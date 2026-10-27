//! The Hunspell dictionaries spelling falls back on: French (Grammalecte's, MPL 2.0) and English
//! (US, SCOWL), as packaged by wooorm/dictionaries at commit 8cfea406b505e4d7df52d5a19bce525df98c54ab.
//! Built into the app (about 2 MB, in `src-tauri/dictionaries/` with their licenses), so they are
//! always there; read on first use (some tens of MB once parsed), let go once cold.

use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use spellbook::Dictionary;

use super::speller::{Language, Speller};

/// `(aff, dic)` for `language`.
const fn sources(language: Language) -> (&'static str, &'static str) {
    macro_rules! bundled {
        ($code:literal) => {
            (
                include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/dictionaries/", $code, ".aff")),
                include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/dictionaries/", $code, ".dic")),
            )
        };
    }
    match language {
        Language::Fr => bundled!("fr"),
        Language::En => bundled!("en"),
    }
}

/// Parses both bundled dictionaries.
fn load() -> Result<Speller<Dictionary>, String> {
    let read = |language: Language| {
        let (aff, dic) = sources(language);
        Dictionary::new(aff, dic).map_err(|e| format!("The {} dictionary couldn't be read ({e})", language.name()))
    };
    Ok(Speller { fr: read(Language::Fr)?, en: read(Language::En)? })
}

/// The dictionaries in memory, and when they were last used.
#[derive(Default)]
pub struct Dictionaries(Mutex<Option<(Arc<Speller<Dictionary>>, Instant)>>);

impl Dictionaries {
    fn lock(&self) -> MutexGuard<'_, Option<(Arc<Speller<Dictionary>>, Instant)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The speller, read on first use (a caller waits while another reads it).
    pub fn speller(&self) -> Result<Arc<Speller<Dictionary>>, String> {
        let mut held = self.lock();
        let speller = match held.take() {
            Some((speller, _)) => speller,
            None => Arc::new(load()?),
        };
        *held = Some((Arc::clone(&speller), Instant::now()));
        Ok(speller)
    }

    /// Lets the speller go once unused for `keep`; skipped while it's being read, so the caller never waits.
    pub fn let_cold_go(&self, keep: Duration) {
        if let Ok(mut held) = self.0.try_lock()
            && held.as_ref().is_some_and(|(_, used)| used.elapsed() >= keep)
        {
            *held = None;
        }
    }

    #[cfg(test)]
    fn loaded(&self) -> bool {
        self.lock().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundles_both_languages() {
        for language in Language::ALL {
            let (aff, dic) = sources(language);
            assert!(aff.contains("SET UTF-8") && dic.len() > 500_000, "{}", language.name());
        }
    }

    #[test]
    fn loads_on_first_use_and_lets_go_once_cold() {
        let dictionaries = Dictionaries::default();
        assert!(!dictionaries.loaded());
        let speller = dictionaries.speller().unwrap();
        assert!(Arc::ptr_eq(&speller, &dictionaries.speller().unwrap()), "read once");
        dictionaries.let_cold_go(Duration::from_secs(60));
        assert!(dictionaries.loaded(), "still warm");
        dictionaries.let_cold_go(Duration::ZERO);
        assert!(!dictionaries.loaded());
    }

    #[test]
    fn corrects_with_the_bundled_dictionaries() {
        let speller = load().unwrap();
        let fr = speller.correct("Aujourdhui, je vais à l'ecole pour le developement du projet.", None);
        assert_eq!((fr.text.as_str(), fr.language), ("Aujourd'hui, je vais à l'école pour le développement du projet.", Language::Fr));
        let en = speller.correct("I will definately recieve teh letter, said NASA on github.com.", None);
        assert_eq!((en.text.as_str(), en.language), ("I will definitely receive the letter, said NASA on github.com.", Language::En));
    }
}
