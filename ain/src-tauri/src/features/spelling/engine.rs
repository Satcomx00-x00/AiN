//! Correcting a text with the chosen engine (the dictionaries on this machine, or a provider's chat
//! model), and the shortcut's whole round: read the selection, correct it, type the result over it.

use serde_json::Value;
use tauri::AppHandle;

use super::{Correction, FEATURE, MAX_CHARS, Phase, Shared, speller};
use crate::{
    features::delivery::{self, Delivery},
    shell::{
        providers::{self, Engine, Remote},
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

/// `text` corrected by `engine`.
pub fn correct(shared: &Shared, engine: &Engine, text: &str, language: Option<speller::Language>) -> Result<Correction, String> {
    if text.chars().count() > MAX_CHARS {
        return Err(format!("The text is too long to correct at once (at most {MAX_CHARS} characters)"));
    }
    match engine {
        Engine::Local if !shared.models.ready() => Err("Download the dictionaries in Settings first".into()),
        Engine::Local => {
            let speller = shared.models.engine()?;
            let fixed = speller.correct(text, language);
            shared.models.touch();
            Ok(Correction { text: fixed.text, fixes: fixed.fixes })
        }
        Engine::Remote(remote) => remotely(remote, text, language),
    }
}

fn remotely(remote: &Remote, text: &str, language: Option<speller::Language>) -> Result<Correction, String> {
    let answer = remote.chat(&instructions(language), text)?;
    let fixed = unwrap(&answer, text);
    if fixed.is_empty() {
        return Err("The provider sent back an empty text".into());
    }
    Ok(Correction { fixes: speller::changes(text, fixed), text: fixed.to_string() })
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
    if engine == Engine::Local && !shared.models.ready() {
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
    Phase::Done { original: core.to_string(), corrected: correction.text, fixes, delivery }
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
    fn keeps_the_spaces_around_the_selection() {
        assert_eq!(split("  teh cat\n"), ("  ", "teh cat", "\n"));
        assert_eq!(split("word"), ("", "word", ""));
    }
}
