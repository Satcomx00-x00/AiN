//! The small language model spelling runs on this machine first: an instruction-tuned Qwen2.5 in
//! GGUF (Apache 2.0), run on the CPU by llama.cpp. It corrects spelling and grammar alike; the
//! dictionaries take over when it isn't downloaded, fails, or answers something else than the text.
//! Each model is one `.gguf` file from Hugging Face (or the models source), downloaded on request into
//! its own folder.

use std::{
    fmt::Display,
    num::NonZeroU32,
    path::Path,
    sync::{OnceLock, atomic::AtomicBool},
    time::{Duration, Instant},
};

use llama_cpp_2::{
    context::params::LlamaContextParams,
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{LlamaChatMessage, LlamaModel, params::LlamaModelParams},
    sampling::LlamaSampler,
};

use crate::features::{
    download::{self, DownloadError, Status},
    models::Downloadable,
};

/// A correction that takes longer than this is given up, and the dictionaries take over.
const TIME_LIMIT: Duration = Duration::from_secs(60);

pub struct Model {
    /// What the "model" setting stores.
    pub id: &'static str,
    /// Its own folder, inside the models folder.
    pub folder: &'static str,
    repo: &'static str,
    file: &'static str,
    /// The file's size, roughly, until the download says.
    size: u64,
}

/// Every model on offer; the first is the default. The ids match `src/features/spelling/models.ts`.
pub const MODELS: &[Model] = &[
    Model {
        id: "qwen2.5-1.5b",
        folder: "qwen2.5-1.5b-instruct-q4_k_m",
        repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
        file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        size: 1_120_000_000,
    },
    Model {
        id: "qwen2.5-0.5b",
        folder: "qwen2.5-0.5b-instruct-q4_k_m",
        repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        size: 490_000_000,
    },
];

impl Model {
    fn url(&self) -> String {
        format!("{}/{}/resolve/main/{}?download=true", crate::config::base(crate::config::HF_URL), self.repo, self.file)
    }
}

impl Downloadable for Model {
    fn id(&self) -> &'static str {
        self.id
    }

    fn folder(&self) -> &'static str {
        self.folder
    }

    /// Ready once its file is there: it is renamed in only once downloaded whole.
    fn status(&self, dir: &Path) -> Status {
        if dir.join(self.file).is_file() { Status::Ready } else { Status::Missing { size: self.size } }
    }

    fn size(&self) -> u64 {
        self.size
    }

    fn download(&self, base: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), DownloadError> {
        // Served over HTTPS by Hugging Face (or from the models source, as `<folder>/<file>`); a GGUF
        // that doesn't load says so when first used.
        let whole = |fetched: &download::Fetched| fetched.size > 0;
        let url = download::source(self.url(), &format!("{}/{}", self.folder, self.file));
        download::fetch_file(&base.join(self.folder), self.file, &url, whole, cancel, |received| {
            progress(received, self.size.max(received));
        })
    }
}

fn fail(what: &str) -> impl Fn(&dyn Display) -> String + '_ {
    move |e| format!("The language model {what} ({e})")
}

/// llama.cpp's backend, set up once for the app's life (it can't be set up twice).
fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            let mut backend = LlamaBackend::init().map_err(|e| fail("couldn't start")(&e))?;
            backend.void_logs();
            Ok(backend)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A model loaded in memory.
pub struct Llm(LlamaModel);

/// Whether `path` starts like a GGUF file: llama.cpp aborts the whole app on some broken files
/// rather than failing, so anything else is refused before it gets there.
fn gguf(path: &Path) -> bool {
    let mut magic = [0; 4];
    std::fs::File::open(path).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic)).is_ok() && &magic == b"GGUF"
}

/// Loads `model`, stored in `dir`.
pub fn load(model: &'static Model, dir: &Path) -> Result<Llm, String> {
    if !gguf(&dir.join(model.file)) {
        return Err("The language model's file is damaged; try downloading it again".into());
    }
    let loaded = LlamaModel::load_from_file(backend()?, dir.join(model.file), &LlamaModelParams::default());
    loaded.map(Llm).map_err(|e| fail("couldn't be loaded; try downloading it again")(&e))
}

/// How many tokens the answer may take: about the text's, with room for what the model adds.
pub fn budget(text_tokens: usize) -> usize {
    text_tokens * 3 / 2 + 32
}

/// The CPU threads to run on: most of them, leaving the app and the system some.
fn threads() -> i32 {
    let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
    i32::try_from(cores.saturating_sub(1).clamp(1, 8)).unwrap_or(4)
}

impl Llm {
    /// What the model answers to `text`, following `instructions`; greedy, so the same text gets
    /// the same answer.
    pub fn chat(&self, instructions: &str, text: &str) -> Result<String, String> {
        let model = &self.0;
        let message =
            |role: &str, content: &str| LlamaChatMessage::new(role.into(), content.into()).map_err(|e| fail("refused the text")(&e));
        let template = model.chat_template(None).map_err(|e| fail("has no chat template")(&e))?;
        let prompt = model
            .apply_chat_template(&template, &[message("system", instructions)?, message("user", text)?], true)
            .map_err(|e| fail("refused the text")(&e))?;
        let vocab = model.vocab();
        let prompt = vocab.tokenize(prompt.as_bytes(), false, true);
        let budget = budget(vocab.tokenize(text.as_bytes(), false, false).len());
        let size = prompt.len() + budget;
        if size > model.n_ctx_train() as usize {
            return Err("The text is too long for the language model".into());
        }
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(u32::try_from(size).unwrap_or(u32::MAX)))
            .with_n_batch(u32::try_from(prompt.len()).unwrap_or(u32::MAX).max(512))
            .with_n_threads(threads())
            .with_n_threads_batch(threads());
        let mut context = model.new_context(backend()?, params).map_err(|e| fail("couldn't start")(&e))?;
        let mut batch = LlamaBatch::new(size.max(512), 1);
        let last = prompt.len() - 1;
        for (i, token) in prompt.iter().enumerate() {
            batch.add(*token, i as i32, &[0], i == last).map_err(|e| fail("refused the text")(&e))?;
        }
        context.decode(&mut batch).map_err(|e| fail("failed")(&e))?;
        let mut sampler = LlamaSampler::greedy();
        let (mut answer, started) = (Vec::new(), Instant::now());
        for at in prompt.len()..size {
            let token = sampler.sample(&context, batch.n_tokens() - 1);
            if vocab.is_eog(token) {
                return Ok(String::from_utf8_lossy(&answer).into_owned());
            }
            if started.elapsed() > TIME_LIMIT {
                return Err("The language model took too long".into());
            }
            answer.extend(vocab.token_to_piece(token, false, None));
            batch.clear();
            batch.add(token, at as i32, &[0], true).map_err(|e| fail("failed")(&e))?;
            context.decode(&mut batch).map_err(|e| fail("failed")(&e))?;
        }
        Err("The language model didn't finish its answer".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_the_larger_model_first() {
        assert_eq!(MODELS[0].id, "qwen2.5-1.5b");
        assert_eq!(
            MODELS[1].url(),
            "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true"
        );
        let folders: std::collections::HashSet<_> = MODELS.iter().map(|m| m.folder).collect();
        assert_eq!(folders.len(), MODELS.len());
    }

    #[test]
    fn missing_until_its_file_is_there() {
        let dir = std::env::temp_dir().join(format!("island-llm-test-{}", std::process::id()));
        let _ = download::remove(&dir);
        assert_eq!(MODELS[1].status(&dir), Status::Missing { size: 490_000_000 });
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MODELS[1].file), "not a model").unwrap();
        assert_eq!(MODELS[1].status(&dir), Status::Ready);
        assert!(load(&MODELS[1], &dir).is_err_and(|e| e.contains("damaged")), "refused before llama.cpp reads it");
        std::fs::write(dir.join(MODELS[1].file), b"GGUF\x03\0\0\0").unwrap();
        assert!(gguf(&dir.join(MODELS[1].file)));
        download::remove(&dir).unwrap();
    }

    #[test]
    fn leaves_room_for_the_answer() {
        assert_eq!(budget(0), 32);
        assert_eq!(budget(100), 182);
        assert!((1..=8).contains(&threads()));
    }

    /// Against a real model: `AIN_SPELLING_LLM=<folder of qwen2.5-0.5b> cargo test -- --ignored real_model`.
    #[test]
    #[ignore = "needs a downloaded model"]
    fn corrects_with_a_real_model() {
        let dir = std::env::var("AIN_SPELLING_LLM").expect("AIN_SPELLING_LLM names the model's folder");
        let llm = load(&MODELS[1], Path::new(&dir)).unwrap();
        let answer = llm.chat(&crate::features::spelling::engine::instructions(None), "Je vais a l'ecole demain.").unwrap();
        assert!(answer.contains("école"), "{answer}");
    }
}
