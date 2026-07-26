// Google Calendar integration via iCal subscription URLs — read-only, no
// OAuth, no Google verification paperwork. Each connected calendar maps to one private
// "Secret address in iCal format" URL pasted in Settings → Accounts.
//
// Layering:
//   cache.rs — IcalEventCache (in-memory + JSON-on-disk) and the
//              one-shot legacy-file cleanup. All events for a calendar
//              live in <app_data_dir>/gcal-cache/<account_id>.json,
//              replaced wholesale on every sync.
//   ical.rs  — wraps the `ical` crate. Walks VEVENTs, lowers a small
//              subset of RRULE to our existing recurring enum, and
//              preserves the original RRULE line for Phase 2b's
//              eventual write-back path.
//   sync.rs  — per-account orchestrator. Reads each configured URL
//              out of the operating-system credential store, fetches, parses,
//              and replaces the cache.
//
// All fetches happen via `reqwest` (already in Cargo). HTTP failures
// stay per-account inside the SyncReport — one bad calendar never
// blocks the others.

pub mod cache;
pub mod clean;
pub mod ical;
pub mod sync;

pub use cache::IcalEventCache;

/// Account IDs become cache filenames and credential-store usernames, so
/// validate their generated shape again at every trust boundary. The shorter
/// test IDs used by unit tests remain valid; dots, separators, Unicode, and
/// controls do not.
pub fn validate_account_id(id: &str) -> Result<(), String> {
    crate::vault::validate_record_id(id)
        .map_err(|e| format!("invalid calendar account id: {e}"))?;
    let suffix = id
        .strip_prefix("gcal_")
        .ok_or_else(|| "calendar account id must start with gcal_".to_string())?;
    if suffix.is_empty() || !suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("calendar account id has an invalid format".to_string());
    }
    if id.len() > 64 {
        return Err("calendar account id is too long".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod account_id_tests {
    use super::validate_account_id;

    #[test]
    fn account_ids_are_confined_filename_components() {
        assert!(validate_account_id("gcal_01K123ABC").is_ok());
        for unsafe_id in [
            "../../config",
            "gcal_../config",
            "other_123",
            "gcal_a/b",
            "gcal_\n",
        ] {
            assert!(validate_account_id(unsafe_id).is_err(), "{unsafe_id:?}");
        }
    }
}
