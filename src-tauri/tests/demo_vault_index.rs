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
fn demo_vault_graph_snapshot_is_populated_and_consistent() {
    let Some(vault) = demo_vault() else {
        eprintln!("WOODSHED_DEMO_VAULT unset — skipping demo vault graph check");
        return;
    };

    // Index into a throwaway database so this never touches real app state.
    let tmp = TempDir::new().expect("temp dir");
    let index = IndexHandle::open(&tmp.path().join("index.db")).expect("open index");
    index.rebuild_from_vault(&vault).expect("rebuild");

    let snapshot = index.graph_snapshot().expect("graph snapshot");

    assert!(
        snapshot.nodes.len() > 200,
        "expected a populated graph, got {} nodes",
        snapshot.nodes.len()
    );
    assert!(
        snapshot.edges.len() > 50,
        "expected a linked vault, got {} edges",
        snapshot.edges.len()
    );

    // Every edge endpoint must be a real node id — the Graph view indexes
    // positions by node id, so a dangling endpoint would crash it.
    let ids: std::collections::HashSet<&str> =
        snapshot.nodes.iter().map(|n| n.id.as_str()).collect();
    for edge in &snapshot.edges {
        assert!(
            ids.contains(edge.source.as_str()),
            "edge source {} is not a node",
            edge.source
        );
        assert!(
            ids.contains(edge.target.as_str()),
            "edge target {} is not a node",
            edge.target
        );
    }

    // Any unresolved labels surface as namespaced ghost nodes with no
    // href. The demo narrative resolves every link, so the set may be
    // empty — ghost behavior itself is pinned by
    // `graph_snapshot_keeps_unresolved_links_as_ghost_nodes`.
    for node in snapshot.nodes.iter().filter(|n| n.kind == "unresolved") {
        assert!(
            node.id.starts_with("unresolved:"),
            "ghost id {:?} must be namespaced",
            node.id
        );
        assert!(node.href.is_none(), "ghost node must not have an href");
    }
    let unresolved = snapshot
        .nodes
        .iter()
        .filter(|n| n.kind == "unresolved")
        .count();

    eprintln!(
        "graph: {} nodes ({} unresolved), {} edges",
        snapshot.nodes.len(),
        unresolved,
        snapshot.edges.len()
    );
}

#[test]
fn graph_snapshot_keeps_unresolved_links_as_ghost_nodes() {
    // A minimal vault: two notes, one linking to the other and one linking
    // to a label that matches no record.
    let tmp = TempDir::new().expect("temp dir");
    let notebook = tmp.path().join("vault/notebook");
    std::fs::create_dir_all(&notebook).expect("create notebook dir");
    std::fs::write(
        notebook.join("alpha.md"),
        "---\ntype: note\nid: alpha\ntitle: Alpha note\ncreated: \"2026-08-02T09:00:00\"\n---\n\nLinks to [[Beta note]] and [[Missing Person]].\n",
    )
    .expect("write alpha");
    std::fs::write(
        notebook.join("beta.md"),
        "---\ntype: note\nid: beta\ntitle: Beta note\ncreated: \"2026-08-02T09:00:00\"\n---\n\nBack to [[Alpha note]].\n",
    )
    .expect("write beta");

    let index = IndexHandle::open(&tmp.path().join("index.db")).expect("open index");
    index
        .rebuild_from_vault(&tmp.path().join("vault"))
        .expect("rebuild");

    let snapshot = index.graph_snapshot().expect("graph snapshot");

    // Exactly one ghost, deterministically named.
    let ghost_ids: Vec<&str> = snapshot
        .nodes
        .iter()
        .filter(|n| n.kind == "unresolved")
        .map(|n| n.id.as_str())
        .collect();
    assert_eq!(ghost_ids, vec!["unresolved:Missing Person"]);

    // The resolved link and the ghost link both appear as edges, and the
    // ghost edge points at the synthetic id.
    let mut edges: Vec<(&str, &str)> = snapshot
        .edges
        .iter()
        .map(|e| (e.source.as_str(), e.target.as_str()))
        .collect();
    edges.sort_unstable();
    assert!(edges.contains(&("notebook/alpha.md", "notebook/beta.md")));
    assert!(edges.contains(&("notebook/alpha.md", "unresolved:Missing Person")));
    assert!(edges.contains(&("notebook/beta.md", "notebook/alpha.md")));
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
        .backlinks_for_target("Elliot Park")
        .expect("backlinks for a wikilinked person");
    assert!(
        !backlinks.is_empty(),
        "expected backlinks for a person referenced by [[wikilink]]"
    );

    eprintln!(
        "indexed {indexed} records; inbox {} messages; Elliot Park has {} backlinks",
        page.len(),
        backlinks.len()
    );
}
