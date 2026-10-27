//! Correcting a text with the chosen engine, and the shortcut's whole round: read the selection,
//! correct it, type the result over it. The engine is a provider's chat model, or on this machine the
//! language model; when either fails (or isn't there), the dictionaries take over.

use serde_json::Value;
use tauri::AppHandle;

use super::{Correction, Corrector, FEATURE, MAX_CHARS, Phase, Shared, speller};
use crate::{
    features::delivery::{self, Delivery},
    shell::{
        providers::{self, Engine},
        settings,
    },
};

/// Where the text to correct comes from when the shortcut is pressed.
pub type Selection = fn() -> Option<String>;

/// How the settings want texts corrected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Preferences {
    /// None: whichever of French or English the text is in.
    pub language: Option<speller::Language>,
    /// Type the correction over the selection, rather than copy it.
    pub replace: bool,
}

impl Preferences {
    pub fn read(settings: &Value) -> Self {
        let option = |key| settings::option(settings, FEATURE, key).and_then(Value::as_str);
        Self {
            language: option("language").and_then(|code| speller::Language::ALL.into_iter().find(|l| l.code() == code)),
            replace: option("apply") != Some("copy"),
        }
    }
}

/// What a chat model is told to do with the text.
pub fn instructions(language: Option<speller::Language>) -> String {
    let language = language.map_or_else(|| "The text is in French or English.".to_string(), |l| format!("The text is in {}.", l.name()));
    format!(
        "You correct spelling, grammar and punctuation. {language} Reply with the corrected text only: no comment, no quotes, \
         no Markdown. Keep its language, meaning, tone, line breaks and formatting, and change nothing that is already correct."
    )
}

/// A chat model's answer without the fences or quotes some wrap it in, unless the text had them.
fn unwrap<'a>(answer: &'a str, original: &str) -> &'a str {
    let answer = answer.trim();
    let fenced =
        answer.strip_prefix("```").and_then(|a| a.strip_suffix("```")).map(|inner| inner.split_once('\n').map_or("", |(_, body)| body));
    let answer = fenced.map_or(answer, str::trim);
    match ['"', '“', '«'].into_iter().find(|q| answer.starts_with(*q) && !original.trim_start().starts_with(*q)) {
        Some(quote) => answer[quote.len_utf8()..].trim_end_matches(['"', '”', '»']).trim(),
        None => answer,
    }
}

/// A chat model's answer, when it is the text corrected rather than something else: not empty, and
/// about as long as the text (a small model may answer the text instead of correcting it).
fn checked<'a>(answer: &'a str, original: &str) -> Result<&'a str, String> {
    let fixed = unwrap(answer, original);
    let (was, is) = (original.chars().count(), fixed.chars().count());
    match () {
        () if fixed.is_empty() => Err("The model sent back an empty text".into()),
        () if is.abs_diff(was) > 12 && (is * 3 < was * 2 || is * 2 > was * 3) => {
            Err("The model answered something else than the text".into())
        }
        () => Ok(fixed),
    }
}

/// `text` corrected by `engine`, or by the dictionaries when it can't.
pub fn correct(shared: &Shared, engine: &Engine, text: &str, language: Option<speller::Language>) -> Result<Correction, String> {
    if text.chars().count() > MAX_CHARS {
        return Err(format!("The text is too long to correct at once (at most {MAX_CHARS} characters)"));
    }
    let ask = |by, answer: Result<String, String>| {
        answer.and_then(|a| checked(&a, text).map(|fixed| Correction { fixes: speller::changes(text, fixed), text: fixed.to_string(), by }))
    };
    let first = match engine {
        Engine::Remote(remote) => Some(ask(Corrector::Provider, remote.chat(&instructions(language), text))),
        Engine::Local if shared.model.ready() => {
            let answer = shared.model.engine().and_then(|llm| llm.chat(&instructions(language), text));
            shared.model.touch();
            Some(ask(Corrector::Model, answer))
        }
        Engine::Local => None,
    };
    let failure = match first {
        Some(Ok(correction)) => return Ok(correction),
        Some(Err(message)) => Some(message),
        None => None,
    };
    if !shared.dictionaries.ready() {
        return Err(failure.unwrap_or_else(|| "Download the language model or the dictionaries in Settings first".into()));
    }
    if let Some(message) = failure {
        eprintln!("island: spelling: {message}; the dictionaries take over");
    }
    let fixed = shared.dictionaries.engine()?.correct(text, language);
    shared.dictionaries.touch();
    Ok(Correction { text: fixed.text, fixes: fixed.fixes, by: Corrector::Dictionaries })
}

/// The spaces around `text`, and what's between them.
fn split(text: &str) -> (&str, &str, &str) {
    let core = text.trim();
    let start = text.len() - text.trim_start().len();
    (&text[..start], core, &text[start + core.len()..])
}

/// The shortcut's round: corrects the selection and hands the result over, saying how it went.
pub fn fix(app: &AppHandle, shared: &Shared, selection: Selection) -> Phase {
    let settings = settings::current(app);
    let engine = match providers::chosen(&settings, FEATURE) {
        Ok(engine) => engine,
        Err(message) => return Phase::Error { message },
    };
    if engine == Engine::Local && !shared.model.ready() && !shared.dictionaries.ready() {
        return Phase::NeedsModel;
    }
    let Some(selected) = selection() else { return Phase::NothingSelected };
    shared.publish(app, Phase::Checking);
    let preferences = Preferences::read(&settings);
    let (before, core, after) = split(&selected);
    let correction = match correct(shared, &engine, core, preferences.language) {
        Ok(correction) => correction,
        Err(message) => return Phase::Error { message },
    };
    let changed = correction.text != core;
    let text = format!("{before}{}{after}", correction.text);
    let delivery = match (changed, preferences.replace) {
        (false, _) => None,
        (true, true) => Some(delivery::deliver(app, &text)),
        (true, false) if delivery::copy(app, &text) => Some(Delivery::Copied),
        (true, false) => return Phase::Error { message: "The correction couldn't be copied".into() },
    };
    let fixes = if changed { correction.fixes.max(1) } else { 0 };
    Phase::Done { original: core.to_string(), corrected: correction.text, fixes, by: correction.by, delivery }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::features::spelling::speller::Language;

    #[test]
    fn reads_the_language_and_what_to_do_with_the_result() {
        let with = |options: Value| Preferences::read(&json!({ "options": { "spelling": options } }));
        assert_eq!(with(json!({})), Preferences { language: None, replace: true });
        assert_eq!(with(json!({ "language": "fr", "apply": "copy" })), Preferences { language: Some(Language::Fr), replace: false });
        assert_eq!(with(json!({ "language": "auto", "apply": "replace" })), Preferences { language: None, replace: true });
        assert_eq!(with(json!({ "language": "de" })).language, None);
    }

    #[test]
    fn tells_the_model_the_language_when_known() {
        assert!(instructions(Some(Language::En)).contains("The text is in English."));
        assert!(instructions(None).contains("The text is in French or English."));
        assert!(instructions(None).contains("corrected text only"));
    }

    #[test]
    fn unwraps_fences_and_quotes_the_text_didnt_have() {
        assert_eq!(unwrap("  Hello there.\n", "helo there."), "Hello there.");
        assert_eq!(unwrap("```text\nHello there.\n```", "helo there."), "Hello there.");
        assert_eq!(unwrap("```\n```", "x"), "");
        assert_eq!(unwrap("\"Hello there.\"", "helo there."), "Hello there.");
        assert_eq!(unwrap("« Bonjour. »", "bonjour."), "Bonjour.");
        assert_eq!(unwrap("\"Hi,\" he said.", "\"Hi,\" he sayed."), "\"Hi,\" he said.");
    }

    #[test]
    fn takes_only_answers_about_as_long_as_the_text() {
        assert_eq!(checked("```\nI will receive it.\n```", "I will recieve it."), Ok("I will receive it."));
        assert_eq!(checked("  ", "teh"), Err("The model sent back an empty text".into()));
        assert_eq!(checked("The", "teh"), Ok("The"), "short texts may change a lot");
        let chatty = "Sure! Here is your text, corrected: I will receive the letter today.";
        assert_eq!(checked(chatty, "I will recieve teh letter"), Err("The model answered something else than the text".into()));
        assert!(checked("I", "I will recieve teh letter today, and the parcel tomorrow").is_err());
    }

    #[test]
    fn keeps_the_spaces_around_the_selection() {
        assert_eq!(split("  teh cat\n"), ("  ", "teh cat", "\n"));
        assert_eq!(split("word"), ("", "word", ""));
    }
}
