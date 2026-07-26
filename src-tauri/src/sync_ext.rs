// Poison-recovering lock acquisition.
//
// Woodshed's shared in-memory state — the SQLite search index, the events
// cache + id→path map, the people-email index, the tag-table caches, the
// watcher handle, the mail connection pools — is all *derived* from the vault
// on disk. Half-updating or briefly observing a stale view of any of it is
// recoverable on the next write or watcher pass; none of it is a source of
// truth.
//
// That matters because of how `Mutex`/`RwLock` poisoning works: if a thread
// panics while holding a lock, the lock is poisoned and *every* subsequent
// `.lock().unwrap()` on it panics too. With a panic hook now logging the
// original panic, a single fault used to cascade — one poisoned lock wedged
// the whole app ("the vault stopped loading") until a full restart cleared the
// in-memory state.
//
// These helpers take the inner guard even when the lock is poisoned
// (`PoisonError::into_inner`), so a panic stays contained to the one operation
// that hit it instead of taking down everything that shares the lock. The
// trade — possibly observing partially-updated derived state — is the right
// one for caches that self-heal; it is NOT appropriate for a lock guarding an
// invariant that must hold for correctness (we have none of those on this
// shared state).

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub trait MutexRecover<T: ?Sized> {
    /// Lock the mutex, recovering the guard if the lock was poisoned.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> MutexRecover<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub trait RwLockRecover<T: ?Sized> {
    /// Acquire a read guard, recovering it if the lock was poisoned.
    fn read_recover(&self) -> RwLockReadGuard<'_, T>;
    /// Acquire a write guard, recovering it if the lock was poisoned.
    fn write_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T: ?Sized> RwLockRecover<T> for RwLock<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T> {
        self.read().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn write_recover(&self) -> RwLockWriteGuard<'_, T> {
        self.write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, RwLock};

    #[test]
    fn mutex_recovers_after_poison() {
        let m = Arc::new(Mutex::new(5));
        let m2 = m.clone();
        // Poison the mutex by panicking while holding the guard.
        let _ = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.lock().is_err(), "lock should be poisoned");
        // The recover helper still hands back the value.
        assert_eq!(*m.lock_recover(), 5);
    }

    #[test]
    fn rwlock_recovers_after_poison() {
        let rw = Arc::new(RwLock::new(String::from("hi")));
        let rw2 = rw.clone();
        let _ = std::thread::spawn(move || {
            let _guard = rw2.write().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(rw.read().is_err(), "lock should be poisoned");
        assert_eq!(&*rw.read_recover(), "hi");
        rw.write_recover().push_str(" there");
        assert_eq!(&*rw.read_recover(), "hi there");
    }
}
