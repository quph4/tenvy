//! Parental PIN: categories marked locked stay out of lists, search and
//! playback until the PIN is entered (for the rest of the session).
//!
//! The PIN is stored salted and hashed in the `meta` table. It keeps
//! curious kids out of a category; it isn't meant to stop someone with
//! access to the Windows account and the database file.

use std::sync::Mutex;

use sha2::{Digest, Sha256};

use crate::db::{self, Db};
use crate::err;
use crate::error::Result;
use crate::models::ParentalStatus;

pub(crate) const META_KEY: &str = "parental_pin";

pub struct Parental {
    state: Mutex<State>,
}

struct State {
    /// "salt_hex:hash_hex", or None without a PIN.
    hash: Option<String>,
    unlocked: bool,
}

impl Parental {
    pub fn load(db: &Db) -> Self {
        let hash = db::get_meta(db, META_KEY).ok().flatten().filter(|h| !h.is_empty());
        Self { state: Mutex::new(State { hash, unlocked: false }) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Locked categories may be shown: no PIN set, or it was entered.
    pub fn unlocked(&self) -> bool {
        let s = self.state();
        s.hash.is_none() || s.unlocked
    }

    pub fn status(&self) -> ParentalStatus {
        let s = self.state();
        ParentalStatus { pin_set: s.hash.is_some(), unlocked: s.hash.is_none() || s.unlocked }
    }

    /// Check a PIN; on success locked categories open for the session.
    pub fn unlock(&self, pin: &str) -> bool {
        let mut s = self.state();
        let ok = s.hash.as_deref().is_none_or(|h| matches(h, pin));
        if ok {
            s.unlocked = true;
        }
        ok
    }

    pub fn lock(&self) {
        self.state().unlocked = false;
    }

    /// Set, change or (with `new = None`) remove the PIN. Changing or
    /// removing an existing PIN needs the current one.
    pub fn set_pin(&self, db: &Db, current: Option<&str>, new: Option<&str>) -> Result<()> {
        let mut s = self.state();
        if let Some(h) = s.hash.as_deref() {
            if !current.is_some_and(|c| matches(h, c)) {
                return Err(err!("That's not the current PIN."));
            }
        }
        let stored = match new {
            Some(pin) => {
                if !(4..=8).contains(&pin.len()) || !pin.chars().all(|c| c.is_ascii_digit()) {
                    return Err(err!("The PIN must be 4 to 8 digits."));
                }
                Some(hash_pin(pin, &salt()))
            }
            None => None,
        };
        db::set_meta(db, META_KEY, stored.as_deref().unwrap_or(""))?;
        s.hash = stored;
        s.unlocked = false;
        Ok(())
    }
}

impl Parental {
    /// Take over the PIN from a backup — only when none is set here.
    /// True if it was taken.
    pub fn adopt(&self, db: &Db, stored: &str) -> Result<bool> {
        let mut s = self.state();
        let well_formed = stored.split_once(':').is_some_and(|(salt, hash)| unhex(salt).is_some() && unhex(hash).is_some());
        if s.hash.is_some() || !well_formed {
            return Ok(false);
        }
        db::set_meta(db, META_KEY, stored)?;
        s.hash = Some(stored.to_string());
        s.unlocked = false;
        Ok(true)
    }
}

fn salt() -> [u8; 16] {
    let mut b = [0u8; 16];
    // Falling back to a fixed salt only weakens the hash, never the lock.
    let _ = getrandom::getrandom(&mut b);
    b
}

fn hash_pin(pin: &str, salt: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(salt);
    h.update(pin.as_bytes());
    format!("{}:{}", hex(salt), hex(&h.finalize()))
}

fn matches(stored: &str, pin: &str) -> bool {
    let Some((salt_hex, _)) = stored.split_once(':') else { return false };
    let Some(salt) = unhex(salt_hex) else { return false };
    hash_pin(pin, &salt) == stored
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| s.get(i..i + 2).and_then(|p| u8::from_str_radix(p, 16).ok()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let dir = std::env::temp_dir().join(format!("tenvy-parental-{}-{}", std::process::id(), rand_suffix()));
        crate::db::open(&dir.join("t.db")).unwrap()
    }

    fn rand_suffix() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64
    }

    #[test]
    fn pin_lifecycle() {
        let db = db();
        let p = Parental::load(&db);
        assert!(p.unlocked() && !p.status().pin_set);

        assert!(p.set_pin(&db, None, Some("12a4")).is_err());
        p.set_pin(&db, None, Some("1234")).unwrap();
        assert!(!p.unlocked());
        assert!(!p.unlock("0000"));
        assert!(p.unlock("1234") && p.unlocked());
        p.lock();
        assert!(!p.unlocked());

        // Survives a restart, stored hashed.
        let again = Parental::load(&db);
        assert!(again.status().pin_set);
        assert!(!db::get_meta(&db, META_KEY).unwrap().unwrap().contains("1234"));

        assert!(again.set_pin(&db, Some("9999"), None).is_err());
        again.set_pin(&db, Some("1234"), None).unwrap();
        assert!(again.unlocked());
    }
}
