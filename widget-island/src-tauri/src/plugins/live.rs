//! The latest value of something a background thread watches, readable by commands.

use std::sync::RwLock;

#[derive(Debug, Default)]
pub struct Live<T>(RwLock<T>);

impl<T: Clone + PartialEq> Live<T> {
    pub fn get(&self) -> T {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Stores `value`; returns true when it differs from what was there.
    pub fn set(&self, value: T) -> bool {
        let mut current = self.0.write().unwrap_or_else(|e| e.into_inner());
        if *current == value {
            return false;
        }
        *current = value;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_only_real_changes() {
        let live = Live::<Option<i32>>::default();
        assert_eq!(live.get(), None);
        assert!(live.set(Some(1)));
        assert!(!live.set(Some(1)));
        assert!(live.set(None));
        assert_eq!(live.get(), None);
    }
}
