//! Correcting a text word by word against Hunspell dictionaries (read by spellbook): each word the
//! dictionary doesn't know is replaced by its closest suggestion, when one is close enough. Words
//! that look like names, code or addresses are left alone. Pure logic, tested on fake dictionaries.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A language the dictionaries cover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Fr,
    En,
}

impl Language {
    pub const ALL: [Self; 2] = [Self::Fr, Self::En];

    /// What the settings and the dictionaries' files call it.
    pub fn code(self) -> &'static str {
        match self {
            Self::Fr => "fr",
            Self::En => "en",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Fr => "French",
            Self::En => "English",
        }
    }
}

/// What a dictionary answers.
pub trait Lexicon {
    fn knows(&self, word: &str) -> bool;
    /// Its suggestions for an unknown word, best first.
    fn suggest(&self, word: &str) -> Vec<String>;
}

impl Lexicon for spellbook::Dictionary {
    fn knows(&self, word: &str) -> bool {
        self.check(word)
    }

    fn suggest(&self, word: &str) -> Vec<String> {
        let mut out = Vec::new();
        spellbook::Dictionary::suggest(self, word, &mut out);
        out
    }
}

/// One dictionary per language.
pub struct Speller<D> {
    pub fr: D,
    pub en: D,
}

impl<D: Lexicon> Speller<D> {
    pub fn lexicon(&self, language: Language) -> &D {
        match language {
            Language::Fr => &self.fr,
            Language::En => &self.en,
        }
    }

    /// The language `text` is in: the one whose dictionary knows more of its words (French on a tie).
    pub fn detect(&self, text: &str) -> Language {
        let known = |language| words(text).filter(|w| w.checked && self.lexicon(language).knows(w.text)).count();
        if known(Language::En) > known(Language::Fr) { Language::En } else { Language::Fr }
    }

    /// `text` corrected in `language` (detected when none).
    pub fn correct(&self, text: &str, language: Option<Language>) -> Corrected {
        let language = language.unwrap_or_else(|| self.detect(text));
        let lexicon = self.lexicon(language);
        let curly = text.contains('’');
        let mut out = String::with_capacity(text.len());
        let (mut at, mut fixes) = (0, 0);
        for word in words(text).filter(|w| w.checked && !lexicon.knows(w.text)) {
            let suggestions = lexicon.suggest(word.text);
            let Some(better) = closest(word.text, &suggestions) else { continue };
            out.push_str(&text[at..word.start]);
            out.push_str(&styled(word.text, better, curly));
            at = word.start + word.text.len();
            fixes += 1;
        }
        out.push_str(&text[at..]);
        Corrected { text: out, fixes, language }
    }
}

/// A text after correction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Corrected {
    pub text: String,
    /// How many words changed.
    pub fixes: u32,
    pub language: Language,
}

/// A word of a text, and where it starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Word<'a> {
    start: usize,
    text: &'a str,
    /// False for what isn't prose: an acronym, a camelCase name, part of an address or of code.
    checked: bool,
}

const JOINERS: [char; 3] = ['\'', '’', '-'];
/// Next to a word, these mean it belongs to an address, a path, a tag or code.
const TECHNICAL: [char; 8] = ['@', '/', '\\', '_', '#', '<', '>', '='];

/// The words of `text`: letters, joined by apostrophes or hyphens between letters.
fn words(text: &str) -> impl Iterator<Item = Word<'_>> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].1.is_alphabetic() {
            i += 1;
            continue;
        }
        let begin = i;
        while i < chars.len()
            && (chars[i].1.is_alphabetic() || (JOINERS.contains(&chars[i].1) && chars.get(i + 1).is_some_and(|c| c.1.is_alphabetic())))
        {
            i += 1;
        }
        let (start, end) = (chars[begin].0, chars.get(i).map_or(text.len(), |c| c.0));
        let before = begin.checked_sub(1).map(|j| chars[j].1);
        let after = chars.get(i).map(|c| c.1);
        let dotted = after == Some('.') && chars.get(i + 1).is_some_and(|c| c.1.is_alphanumeric());
        let technical = [before, after].into_iter().flatten().any(|c| TECHNICAL.contains(&c) || c.is_numeric())
            || dotted
            || before == Some('.') && begin >= 2 && chars[begin - 2].1.is_alphanumeric();
        let text = &text[start..end];
        out.push(Word { start, text, checked: !technical && prose(text) });
    }
    out.into_iter()
}

/// A word worth checking: two letters or more, not all capitals, no capital inside.
fn prose(word: &str) -> bool {
    let mut letters = word.chars().filter(|c| c.is_alphabetic());
    let Some(_) = letters.next() else { return false };
    let rest: Vec<char> = letters.collect();
    !rest.is_empty() && !rest.iter().any(|c| c.is_uppercase())
}

/// The suggestion closest to `word`, when it is close enough to replace it without asking.
fn closest<'a>(word: &str, suggestions: &'a [String]) -> Option<&'a str> {
    let folded = fold(word);
    let limit = if folded.len() >= 8 { 3 } else { 2 };
    suggestions
        .iter()
        .enumerate()
        .map(|(rank, s)| (distance(&folded, &fold(s)) + usize::from(s.contains(' ') && !word.contains(' ')), rank, s))
        .filter(|(d, ..)| *d <= limit)
        .min_by_key(|(d, rank, _)| (*d, *rank))
        .map(|(.., s)| s.as_str())
}

/// `better` written like `word`: capitalized like it, with the text's apostrophes.
fn styled(word: &str, better: &str, curly: bool) -> String {
    let better = if curly { better.replace('\'', "’") } else { better.replace('’', "'") };
    let mut chars = better.chars();
    match (word.chars().next().is_some_and(char::is_uppercase), chars.next()) {
        (true, Some(first)) => first.to_uppercase().chain(chars).collect(),
        _ => better,
    }
}

/// Lowercase, without accents, with straight apostrophes: what a slip of the keyboard keeps.
fn fold(word: &str) -> Vec<char> {
    word.to_lowercase()
        .chars()
        .flat_map(|c| {
            let plain = match c {
                'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' => "a",
                'é' | 'è' | 'ê' | 'ë' => "e",
                'î' | 'ï' | 'í' | 'ì' => "i",
                'ô' | 'ö' | 'ó' | 'ò' | 'õ' => "o",
                'ù' | 'û' | 'ü' | 'ú' => "u",
                'ç' => "c",
                'ÿ' => "y",
                'ñ' => "n",
                'œ' => "oe",
                'æ' => "ae",
                '’' => "'",
                _ => return vec![c],
            };
            plain.chars().collect()
        })
        .collect()
}

/// The edits (insert, delete, replace, swap two neighbours) turning `a` into `b`.
fn distance(a: &[char], b: &[char]) -> usize {
    let mut rows = vec![(0..=b.len()).collect::<Vec<_>>(); a.len() + 1];
    for (i, row) in rows.iter_mut().enumerate() {
        row[0] = i;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (rows[i - 1][j] + 1).min(rows[i][j - 1] + 1).min(rows[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(rows[i - 2][j - 2] + 1);
            }
            rows[i][j] = best;
        }
    }
    rows[a.len()][b.len()]
}

/// About how many words differ between `before` and `after` (what a provider changed).
pub fn changes(before: &str, after: &str) -> u32 {
    let (a, b): (Vec<_>, Vec<_>) = (before.split_whitespace().collect(), after.split_whitespace().collect());
    // Past this, comparing costs more than it tells.
    const MAX_CELLS: usize = 4_000_000;
    if a.len() * b.len() > MAX_CELLS {
        return u32::from(a != b);
    }
    let mut common = vec![0usize; b.len() + 1];
    for x in &a {
        let mut diagonal = 0;
        for (j, y) in b.iter().enumerate() {
            let above = common[j + 1];
            common[j + 1] = if x == y { diagonal + 1 } else { above.max(common[j]) };
            diagonal = above;
        }
    }
    let same = common[b.len()];
    u32::try_from((a.len() - same).max(b.len() - same)).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// A dictionary of known words, and suggestions for some unknown ones.
    #[derive(Default)]
    struct Fake {
        known: Vec<&'static str>,
        suggestions: HashMap<&'static str, Vec<&'static str>>,
    }

    impl Lexicon for Fake {
        fn knows(&self, word: &str) -> bool {
            self.known.iter().any(|k| k.eq_ignore_ascii_case(word))
        }
        fn suggest(&self, word: &str) -> Vec<String> {
            self.suggestions.get(word.replace('’', "'").as_str()).map(|s| s.iter().map(|s| s.to_string()).collect()).unwrap_or_default()
        }
    }

    fn speller() -> Speller<Fake> {
        Speller {
            fr: Fake {
                known: vec!["je", "vais", "à", "l'école", "aujourd'hui", "le", "développement", "est", "bon"],
                suggestions: HashMap::from([
                    ("l'ecole", vec!["l’école"]),
                    ("aujourdhui", vec!["aujourd’hui"]),
                    ("developement", vec!["enveloppement", "développement"]),
                    ("Developement", vec!["Enveloppement", "Développement"]),
                    ("xyzzy", vec!["bizarre"]),
                ]),
            },
            en: Fake {
                known: vec!["i", "will", "the", "letter", "is", "good", "today"],
                suggestions: HashMap::from([("recieve", vec!["receive", "relieve"]), ("teh", vec!["t eh", "the"])]),
            },
        }
    }

    #[test]
    fn fixes_french_and_keeps_the_rest_as_is() {
        let fixed = speller().correct("Je vais à l'ecole aujourdhui.", None);
        assert_eq!(fixed, Corrected { text: "Je vais à l'école aujourd'hui.".into(), fixes: 2, language: Language::Fr });
        let fixed = speller().correct("  le developement est bon\n", Some(Language::Fr));
        assert_eq!(fixed.text, "  le développement est bon\n", "the closest suggestion wins, the spaces stay");
    }

    #[test]
    fn fixes_english_and_detects_it() {
        let fixed = speller().correct("I will recieve teh letter today", None);
        assert_eq!(fixed, Corrected { text: "I will receive the letter today".into(), fixes: 2, language: Language::En });
    }

    #[test]
    fn keeps_the_capital_and_the_texts_apostrophes() {
        assert_eq!(speller().correct("Developement est bon", Some(Language::Fr)).text, "Développement est bon");
        assert_eq!(speller().correct("l’ecole aujourdhui", Some(Language::Fr)).text, "l’école aujourd’hui");
    }

    #[test]
    fn leaves_words_with_no_close_suggestion() {
        assert_eq!(
            speller().correct("le xyzzy est bon", None),
            Corrected { text: "le xyzzy est bon".into(), fixes: 0, language: Language::Fr }
        );
    }

    #[test]
    fn skips_names_code_and_addresses() {
        let checked = |text| words(text).filter(|w| w.checked).map(|w| w.text).collect::<Vec<_>>();
        assert_eq!(checked("NASA iPhone teh"), ["teh"]);
        assert_eq!(checked("mail teh@ecole.fr or see ecole.fr/teh and foo_bar"), ["mail", "or", "see", "and"]);
        assert_eq!(checked("v2 abc123 #ecole a"), [] as [&str; 0]);
        assert_eq!(checked("peut-être l'école -teh- teh."), ["peut-être", "l'école", "teh", "teh"]);
    }

    #[test]
    fn measures_typing_slips() {
        let d = |a: &str, b: &str| distance(&fold(a), &fold(b));
        assert_eq!(d("teh", "the"), 1);
        assert_eq!(d("ecole", "École"), 0);
        assert_eq!(d("developement", "développement"), 1);
        assert_eq!(d("aujourdhui", "aujourd’hui"), 1);
        assert_eq!(d("cœur", "coeur"), 0);
        assert_eq!(d("", "abc"), 3);
    }

    #[test]
    fn counts_the_words_a_provider_changed() {
        assert_eq!(changes("I will recieve teh letter", "I will receive the letter"), 2);
        assert_eq!(changes("same text", " same  text "), 0);
        assert_eq!(changes("a b", "a b c d"), 2);
        assert_eq!(changes("", ""), 0);
    }

    #[test]
    fn names_its_languages() {
        assert_eq!(Language::ALL.map(Language::name), ["French", "English"]);
        assert_eq!(serde_json::to_value(Language::Fr).unwrap(), Language::Fr.code());
    }
}
