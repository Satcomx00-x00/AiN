//! The Hunspell dictionaries spelling checks against on this machine: French (Grammalecte's,
//! MPL 2.0) and English (US, SCOWL), as packaged by wooorm/dictionaries at a pinned commit,
//! downloaded together on request (about 2 MB), checked against known hashes, into their own folder.

use std::{fs, path::Path, sync::atomic::AtomicBool};

use super::speller::{Language, Speller};
use crate::features::{
    download::{self, DownloadError, Pinned, Status, pinned},
    models::Downloadable,
};

const REPO: &str = "https://raw.githubusercontent.com/wooorm/dictionaries";
const COMMIT: &str = "8cfea406b505e4d7df52d5a19bce525df98c54ab";

pub struct Dictionaries {
    pub id: &'static str,
    pub folder: &'static str,
    /// `<language>.aff` and `<language>.dic` for each language.
    files: &'static [Pinned],
}

/// What's on offer: one download for both languages.
pub const MODELS: &[Dictionaries] = &[Dictionaries {
    id: "hunspell-fr-en",
    folder: "hunspell-fr-en",
    files: &[
        pinned("fr.aff", 199_870, "05a735d34c912e4e381ff08ee7c747923ccf5cf9dca81d8467982fa1ca51c2b7"),
        pinned("fr.dic", 1_229_133, "984e933237bc1224a48f42828233be9b03228260ef67aa8e2bdddcd03a26230d"),
        pinned("en.aff", 3_086, "8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b"),
        pinned("en.dic", 551_762, "f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647"),
    ],
}];

impl Dictionaries {
    fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    /// Where `fr.aff` comes from: `dictionaries/fr/index.aff`.
    fn url(file: &str) -> String {
        let (language, extension) = file.split_once('.').unwrap_or((file, ""));
        format!("{REPO}/{COMMIT}/dictionaries/{language}/index.{extension}")
    }
}

impl Downloadable for Dictionaries {
    fn id(&self) -> &'static str {
        self.id
    }

    fn folder(&self) -> &'static str {
        self.folder
    }

    fn status(&self, dir: &Path) -> Status {
        if download::complete(dir, self.files) { Status::Ready } else { Status::Missing { size: self.total_size() } }
    }

    fn size(&self) -> u64 {
        self.total_size()
    }

    fn download(&self, base: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(u64, u64)) -> Result<(), DownloadError> {
        download::fetch_pinned(&base.join(self.folder), self.files, |f| Self::url(f.name), cancel, progress)
    }
}

/// Reads both dictionaries from `dir`.
pub fn load(_: &'static Dictionaries, dir: &Path) -> Result<Speller<spellbook::Dictionary>, String> {
    let read = |language: Language| {
        let text = |extension| fs::read_to_string(dir.join(format!("{}.{extension}", language.code())));
        let (aff, dic) = (text("aff"), text("dic"));
        let broken =
            |e: &dyn std::fmt::Display| format!("The {} dictionary couldn't be read ({e}); try downloading it again", language.name());
        spellbook::Dictionary::new(&aff.map_err(|e| broken(&e))?, &dic.map_err(|e| broken(&e))?).map_err(|e| broken(&e))
    };
    Ok(Speller { fr: read(Language::Fr)?, en: read(Language::En)? })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::download::remove;

    #[test]
    fn pins_the_commit() {
        assert_eq!(
            Dictionaries::url("fr.dic"),
            "https://raw.githubusercontent.com/wooorm/dictionaries/8cfea406b505e4d7df52d5a19bce525df98c54ab/dictionaries/fr/index.dic"
        );
        assert_eq!(MODELS[0].size(), 1_983_851);
        assert!(MODELS[0].files.iter().all(|f| f.sha256.len() == 64));
    }

    #[test]
    fn missing_until_every_file_is_complete() {
        let base = std::env::temp_dir().join(format!("island-spelling-test-{}", std::process::id()));
        let dir = base.join(MODELS[0].folder);
        let _ = remove(&base);
        assert_eq!(MODELS[0].status(&dir), Status::Missing { size: 1_983_851 });
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("en.aff"), "partial").unwrap();
        assert!(load(&MODELS[0], &dir).is_err_and(|e| e.starts_with("The French dictionary couldn't be read")));
        remove(&base).unwrap();
    }

    #[test]
    fn reads_hunspell_files() {
        let dir = std::env::temp_dir().join(format!("island-spelling-load-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for code in ["fr", "en"] {
            fs::write(dir.join(format!("{code}.aff")), "SET UTF-8\nTRY esianrtolcdugmphbyfvkwz\n").unwrap();
        }
        fs::write(dir.join("fr.dic"), "2\nécole\nbonjour\n").unwrap();
        fs::write(dir.join("en.dic"), "2\nhello\nreceive\n").unwrap();
        let speller = load(&MODELS[0], &dir).unwrap();
        assert_eq!(speller.correct("bonjour ecole", None).text, "bonjour école");
        assert_eq!(speller.correct("hello recieve", None).text, "hello receive");
        remove(&dir).unwrap();
    }

    /// Against the real dictionaries: `AIN_SPELLING_DICTS=<folder> cargo test -- --ignored real_dictionaries`.
    #[test]
    #[ignore = "needs the downloaded dictionaries"]
    fn corrects_with_the_real_dictionaries() {
        let dir = std::env::var("AIN_SPELLING_DICTS").expect("AIN_SPELLING_DICTS names the dictionaries' folder");
        let speller = load(&MODELS[0], Path::new(&dir)).unwrap();
        let fr = speller.correct("Aujourdhui, je vais à l'ecole pour le developement du projet.", None);
        assert_eq!((fr.text.as_str(), fr.language), ("Aujourd'hui, je vais à l'école pour le développement du projet.", Language::Fr));
        let en = speller.correct("I will definately recieve teh letter, said NASA on github.com.", None);
        assert_eq!((en.text.as_str(), en.language), ("I will definitely receive the letter, said NASA on github.com.", Language::En));
    }
}
