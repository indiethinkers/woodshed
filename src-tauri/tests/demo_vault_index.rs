//! Indexes a generated demo vault with the real indexer and asserts the
//! surfaces a demo actually touches come back populated.
//!
//! `demo_vault_roundtrip` proves each file parses. This proves the records make
//! it through `rebuild_from_vault` into search, mail, tag views and backlinks —
//! the difference between "the file is valid" and "the audience sees something
//! when you click".
//!
//! Skipped (green) when `WOODSHED_DEMO_VAULT` is unset:
//!
//! ```sh
//! bun run demo:vault -- --out /tmp/demo-vault
//! WOODSHED_DEMO_VAULT=/tmp/demo-vault \
//!   cargo test --manifest-path src-tauri/Cargo.toml --test demo_vault_index
//! ```

use std::path::PathBuf;
use tempfile::TempDir;
use woodshed_lib::index::IndexHandle;

fn demo_vault() -> Option<PathBuf> {
    let raw = std::env::var("WOODSHED_DEMO_VAULT").ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

#[test]
fn demo_vault_indexes_into_populated_surfaces() {
    let Some(vault) = demo_vault() else {
        eprintln!("WOODSHED_DEMO_VAULT unset — skipping demo vault index check");
        return;
    };

    // Index into a throwaway database so this never touches real app state.
    let tmp = TempDir::new().expect("temp dir");
    let index = IndexHandle::open(&tmp.path().join("index.db")).expect("open index");
    let indexed = index.rebuild_from_vault(&vault).expect("rebuild");

    assert!(
        indexed > 200,
        "expected a populated vault, indexed only {indexed} records"
    );

    // Search has to return real result sets for the terms a demo would type.
    for query in [
        "fundraise",
        "retention",
        "local-first",
        "onboarding",
        "sync",
    ] {
        let hits = index.search(query, 20).expect("search");
        assert!(
            !hits.is_empty(),
            "search for {query:?} returned nothing — a demo would show an empty pane"
        );
    }

    // Mail: the inbox page is what the Mail surface renders.
    let (page, _next) = index.mail_inbox_page(0, 50).expect("mail page");
    assert!(
        page.len() >= 20,
        "expected a populated inbox, got {} messages",
        page.len()
    );
    assert!(
        page.iter().any(|m| !m.read),
        "expected at least one unread message so Mail shows a badge"
    );

    // Tag tables read normalized edges; an empty tag view is a dead surface.
    for tag in ["fundraise", "rfc", "user-interview"] {
        let paths = index.tagged_paths(tag).expect("tagged paths");
        assert!(
            !paths.is_empty(),
            "tag view #{tag} is empty — nothing to show if the demo opens it"
        );
    }

    // Backlinks are the single most persuasive moment in the demo script:
    // open a person, see every record that mentions them.
    let backlinks = index
        .backlinks_for_target("Ravi Menon")
        .expect("backlinks for a wikilinked person");
    assert!(
        !backlinks.is_empty(),
        "expected backlinks for a person referenced by [[wikilink]]"
    );

    eprintln!(
        "indexed {indexed} records; inbox {} messages; Ravi Menon has {} backlinks",
        page.len(),
        backlinks.len()
    );
}
