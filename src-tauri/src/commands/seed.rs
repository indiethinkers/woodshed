// Seed samples: writes a curated demo dataset into the vault on first run
// when the user keeps "Seed with sample content" checked during onboarding.
//
// Seed records mirror src/lib/mock-data/* on the frontend so the post-seed
// app feels populated end-to-end. As each domain migrates fully to the
// vault, its mock-data file gets deleted and the seeds here become the
// single source of truth for the demo dataset.

use crate::parsers::{
    self, CalcFn, Column, ColumnType, DailyJournal, FilterCombineOp, Note as ParsedNote,
    NumberFormat, Person as ParsedPerson, Resource as ParsedResource, Row as ParsedRow,
    SelectOption, SortDirection, Table as ParsedTable, Task as ParsedTask, TaskStatus, View,
    ViewFilter, ViewFilters, ViewSort,
};
use crate::vault as vault_lib;
use std::collections::BTreeMap;
use std::path::Path;
use ulid::Ulid;

/// Seed reference date. Hardcoded so the demo lands on a single fixed
/// "today" regardless of when the user installs.
const SEED_DATE: &str = "2026-04-25";

pub fn seed_all(vault: &Path) -> Result<(), String> {
    for person in seed_people() {
        let path = crate::vault::collection_dir(vault, "people").join(format!("{}.md", person.id));
        let content = parsers::serialize_person(&person).map_err(|e| e.to_string())?;
        vault_lib::write_atomic(&path, &content).map_err(|e| e.to_string())?;
    }

    for task in seed_tasks() {
        let path = crate::vault::collection_dir(vault, "tasks").join(format!("{}.md", task.id));
        let content = parsers::serialize_task(&task).map_err(|e| e.to_string())?;
        vault_lib::write_atomic(&path, &content).map_err(|e| e.to_string())?;
    }

    for note in seed_notes() {
        let path = crate::vault::collection_dir(vault, "notebook").join(format!("{}.md", note.id));
        let content = parsers::serialize_note(&note).map_err(|e| e.to_string())?;
        vault_lib::write_atomic(&path, &content).map_err(|e| e.to_string())?;
    }

    for resource in seed_resources() {
        let path = vault_lib::resources_dir(vault).join(format!("{}.md", resource.id));
        let content = parsers::serialize_resource(&resource).map_err(|e| e.to_string())?;
        vault_lib::write_atomic(&path, &content).map_err(|e| e.to_string())?;
    }

    // Daily file: just the journal body for SEED_DATE. Events live in
    // events/ now, not inline here.
    let seed_journal = seed_daily();
    let journal_path = vault_lib::cadence_dir(vault).join(format!("{}.md", seed_journal.date));
    let journal_content = parsers::serialize_daily(&seed_journal).map_err(|e| e.to_string())?;
    vault_lib::write_atomic(&journal_path, &journal_content).map_err(|e| e.to_string())?;

    let (budget_table, budget_rows) = seed_budget_table();
    let budget_dir = crate::vault::collection_dir(vault, "tables").join(&budget_table.id);
    std::fs::create_dir_all(&budget_dir).map_err(|e| e.to_string())?;
    let schema_content =
        parsers::serialize_table_schema(&budget_table).map_err(|e| e.to_string())?;
    vault_lib::write_atomic(&budget_dir.join("_schema.md"), &schema_content)
        .map_err(|e| e.to_string())?;
    for row in &budget_rows {
        let row_content = parsers::serialize_row(row).map_err(|e| e.to_string())?;
        vault_lib::write_atomic(&budget_dir.join(format!("{}.md", row.id)), &row_content)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn seed_people() -> Vec<ParsedPerson> {
    vec![
        person(
            "alex-rivera",
            "Alex Rivera",
            "AR",
            "Software Engineer",
            "Woodshed",
            "alex.rivera@example.com",
            "woodshed",
            "Example teammate for demonstrating relationships, recurring meetings, and linked project notes.",
        ),
        person(
            "jordan-lee",
            "Jordan Lee",
            "JL",
            "Co-creator",
            "Indie Thinkers",
            "jordan.lee@example.com",
            "indie-thinkers",
            "Example writing collaborator used to demonstrate recurring projects and shared notes.",
        ),
        person(
            "sam-chen",
            "Sam Chen",
            "SC",
            "Engineering Lead",
            "Woodshed",
            "sam.chen@example.com",
            "woodshed",
            "Example engineering lead used to demonstrate area inference and project backlinks.",
        ),
        person(
            "morgan-diaz",
            "Morgan Diaz",
            "MD",
            "Data Engineer",
            "Woodshed",
            "morgan.diaz@example.com",
            "woodshed",
            "Example data engineer connected to design reviews and ingestion notes.",
        ),
        person(
            "casey-kim",
            "Casey Kim",
            "CK",
            "Product Manager",
            "Woodshed",
            "casey.kim@example.com",
            "woodshed",
            "Example product partner for roadmap notes and task references.",
        ),
        person(
            "taylor-brooks",
            "Taylor Brooks",
            "TB",
            "Software Engineer",
            "Woodshed",
            "taylor.brooks@example.com",
            "woodshed",
            "Example frontend engineer used in team and project views.",
        ),
        person(
            "cameron-patel",
            "Cameron Patel",
            "CP",
            "Software Engineer",
            "Woodshed",
            "cameron.patel@example.com",
            "woodshed",
            "Example backend engineer used to demonstrate team relationships.",
        ),
        person(
            "riley-torres",
            "Riley Torres",
            "RT",
            "Engineering Manager",
            "Woodshed",
            "riley.torres@example.com",
            "woodshed",
            "Example peer manager for cross-team planning notes.",
        ),
        person(
            "jamie-parker",
            "Jamie Parker",
            "JP",
            "Software Engineer",
            "Freelance",
            "jamie.parker@example.com",
            "personal",
            "Example independent developer used to demonstrate personal CRM links.",
        ),
        person(
            "quinn-morgan",
            "Quinn Morgan",
            "QM",
            "Engineering Manager",
            "Woodshed",
            "quinn.morgan@example.com",
            "woodshed",
            "Example planning partner used in the Cadence schedule.",
        ),
    ]
}

fn seed_tasks() -> Vec<ParsedTask> {
    let now = chrono::Local::now();
    let now_rfc = now.to_rfc3339();
    let now_ms = now.timestamp_millis() as f64;

    vec![
        task(
            "t_seed_pricing",
            "Ship pricing rewrite to staging",
            TaskStatus::InProgress,
            "woodshed",
            &now_rfc,
            Some(SEED_DATE),
            now_ms,
            "Subtask: review the new tier copy with [[Sam Chen]] before pushing.",
        ),
        task(
            "t_seed_outreach",
            "Reply to partner onboarding feedback thread",
            TaskStatus::Backlog,
            "woodshed",
            &now_rfc,
            Some(SEED_DATE),
            now_ms + 1.0,
            "",
        ),
        task(
            "t_seed_essay",
            "Outline next [[Indie Thinkers]] essay",
            TaskStatus::Backlog,
            "indie-thinkers",
            &now_rfc,
            Some(SEED_DATE),
            now_ms + 2.0,
            "Working title: \"The premium-tool buyer thinks in nouns, not verbs.\"",
        ),
        task(
            "t_seed_groceries",
            "Pick up groceries for the week",
            TaskStatus::Backlog,
            "personal",
            &now_rfc,
            Some(SEED_DATE),
            now_ms + 3.0,
            "",
        ),
        task(
            "t_seed_review",
            "Review Q1 retrospective doc",
            TaskStatus::Done,
            "woodshed",
            &now_rfc,
            Some(SEED_DATE),
            now_ms + 4.0,
            "Done — left comments. Riley will drive the follow-ups.",
        ),
    ]
}

fn seed_notes() -> Vec<ParsedNote> {
    vec![
        note(
            "file-over-app-philosophy",
            "File-over-app philosophy",
            "indie-thinkers",
            "2026-04-12T12:30:00",
            &["essay", "idea"],
            "The premise is simple: if your tools vanish tomorrow, do your files survive?\n\nMarkdown is the answer. Plain text with light structure. No proprietary format, no vendor lock-in. Your notes are yours — they work in any editor, on any OS, forever.\n\nThis is the foundation of Woodshed. Every document is a `.md` file. Tags are inline. Links are wikilinks. The app is a lens, not a cage.",
        ),
        note(
            "woodshed-product-spec",
            "Woodshed product spec",
            "personal",
            "2026-04-25T09:30:00",
            &["idea"],
            "What if every document was a markdown file?\n\nWoodshed unifies calendar, notes, tasks, resources, structured data, mail, and a personal CRM into a single workspace. Seven views, one vault.\n\nCore concepts:\n- File over app — every document is a `.md` file in `~/woodshed/`\n- Tasks can be worked as a table when structure matters\n- Wikilinks are the graph — [[double bracket links]] connect files",
        ),
        note(
            "writing-is-thinking",
            "Writing is thinking, not typing",
            "indie-thinkers",
            "2026-04-22T14:00:00",
            &["essay"],
            "Writing isn't the output of thinking — it IS thinking. The act of putting words in sequence forces clarity.\n\nThis is why the best engineers write well. Not because writing is a separate skill, but because clear writing is clear thinking made visible.",
        ),
        note(
            "premium-tool-buyer",
            "The premium-tool buyer",
            "personal",
            "2026-04-20T11:00:00",
            &["idea"],
            "ICP working note. The premium-tool buyer:\n\n- Pays for Linear, Superhuman, Things, Obsidian — not free Notion or Trello\n- Treats tools as infrastructure, not novelty\n- Optimizes for keyboard speed, density, and trust\n- Reads the changelog\n\nWoodshed is for them.",
        ),
    ]
}

fn seed_resources() -> Vec<ParsedResource> {
    vec![
        resource(
            "local-first-software",
            "Local-first software: You own your data, in spite of the cloud",
            "https://www.inkandswitch.com/local-first/",
            "inkandswitch.com",
            "personal",
            "2026-04-10T09:15:00-04:00",
            &["local-first", "philosophy"],
            &[
                "Seven ideals for local-first software",
                "Cloud apps are not permanent",
            ],
            "Foundational reading for the Woodshed vault format. Seven ideals are a useful checklist for any local-first product decision.",
        ),
        resource(
            "file-over-app",
            "File over app",
            "https://stephango.com/file-over-app",
            "stephango.com",
            "personal",
            "2026-04-08T14:30:00-04:00",
            &["local-first", "philosophy", "obsidian"],
            &[
                "If you want your writing to still be readable on a computer from the 2060s, it's important that your notes can be read on a computer from the 1960s",
            ],
            "The post that gave the principle its name. Worth re-reading every product cycle.",
        ),
        resource(
            "premium-tool-buyer",
            "Why premium tool buyers churn",
            "https://example.com/premium-tool-buyer",
            "example.com",
            "personal",
            "2026-04-04T08:00:00-04:00",
            &["icp"],
            &[
                "Premium buyers don't churn on price — they churn when the tool starts feeling generic.",
            ],
            "Useful framing for the Woodshed positioning. The premium-tool buyer pays attention to the changelog.",
        ),
    ]
}

/// Seed a Budget table that mirrors the screenshot the user pinned to the
/// Tables phase: text + number + select + date + checkbox columns, three
/// views with different filter/sort/calculations, and a handful of rows.
/// IDs are stable strings (not ulids) so re-seeding overwrites rather than
/// duplicates.
fn seed_budget_table() -> (ParsedTable, Vec<ParsedRow>) {
    let columns = vec![
        Column {
            id: "col_item".to_string(),
            name: "Item".to_string(),
            type_: ColumnType::Text,
            options: vec![],
            width: None,
            format: None,
            precision: None,
        },
        Column {
            id: "col_amount".to_string(),
            name: "Amount".to_string(),
            type_: ColumnType::Number,
            options: vec![],
            width: None,
            format: Some(NumberFormat::UsDollar),
            precision: Some(2),
        },
        Column {
            id: "col_category".to_string(),
            name: "Category".to_string(),
            type_: ColumnType::Select,
            options: vec![
                SelectOption {
                    id: "opt_food".to_string(),
                    name: "Food".to_string(),
                    color: "amber".to_string(),
                },
                SelectOption {
                    id: "opt_rent".to_string(),
                    name: "Rent".to_string(),
                    color: "purple".to_string(),
                },
                SelectOption {
                    id: "opt_transit".to_string(),
                    name: "Transit".to_string(),
                    color: "blue".to_string(),
                },
                SelectOption {
                    id: "opt_utilities".to_string(),
                    name: "Utilities".to_string(),
                    color: "teal".to_string(),
                },
            ],
            width: None,
            format: None,
            precision: None,
        },
        Column {
            id: "col_date".to_string(),
            name: "Date".to_string(),
            type_: ColumnType::Date,
            options: vec![],
            width: None,
            format: None,
            precision: None,
        },
        Column {
            id: "col_paid".to_string(),
            name: "Paid".to_string(),
            type_: ColumnType::Checkbox,
            options: vec![],
            width: None,
            format: None,
            precision: None,
        },
        Column {
            id: "col_tags".to_string(),
            name: "Tags".to_string(),
            type_: ColumnType::MultiSelect,
            options: vec![
                SelectOption {
                    id: "tag_recurring".to_string(),
                    name: "Recurring".to_string(),
                    color: "blue".to_string(),
                },
                SelectOption {
                    id: "tag_shared".to_string(),
                    name: "Shared".to_string(),
                    color: "pink".to_string(),
                },
                SelectOption {
                    id: "tag_essential".to_string(),
                    name: "Essential".to_string(),
                    color: "amber".to_string(),
                },
            ],
            width: None,
            format: None,
            precision: None,
        },
    ];

    let mut all_calc = BTreeMap::new();
    all_calc.insert("col_amount".to_string(), CalcFn::Sum);
    all_calc.insert("col_item".to_string(), CalcFn::Count);

    let mut big_calc = BTreeMap::new();
    big_calc.insert("col_amount".to_string(), CalcFn::Sum);

    let views = vec![
        View {
            id: "view_all".to_string(),
            name: "All Transactions".to_string(),
            type_: "table".to_string(),
            sorts: vec![ViewSort {
                column: "col_date".to_string(),
                direction: SortDirection::Desc,
            }],
            filters: ViewFilters {
                op: FilterCombineOp::And,
                conditions: vec![],
            },
            hidden: vec![],
            calculations: all_calc,
            group_by: None,
        },
        View {
            id: "view_big".to_string(),
            name: "Big Items".to_string(),
            type_: "table".to_string(),
            sorts: vec![ViewSort {
                column: "col_amount".to_string(),
                direction: SortDirection::Desc,
            }],
            filters: ViewFilters {
                op: FilterCombineOp::And,
                conditions: vec![ViewFilter {
                    column: "col_amount".to_string(),
                    op: "gt".to_string(),
                    value: Some(serde_yaml::Value::Number(serde_yaml::Number::from(50))),
                }],
            },
            hidden: vec!["col_paid".to_string()],
            calculations: big_calc,
            group_by: None,
        },
        View {
            id: "view_board".to_string(),
            name: "By Category".to_string(),
            type_: "board".to_string(),
            sorts: vec![],
            filters: ViewFilters {
                op: FilterCombineOp::And,
                conditions: vec![],
            },
            hidden: vec![],
            calculations: BTreeMap::new(),
            group_by: Some("col_category".to_string()),
        },
    ];

    let table = ParsedTable {
        id: "budget".to_string(),
        name: "Budget".to_string(),
        created: format!("{}T08:00:00", SEED_DATE),
        favorite: false,
        columns,
        views,
    };

    let rows = vec![
        budget_row(
            "row_coffee",
            "Coffee",
            4.5,
            "opt_food",
            "2026-04-25",
            true,
            &[],
        ),
        budget_row(
            "row_lunch",
            "Lunch with team",
            18.0,
            "opt_food",
            "2026-04-24",
            true,
            &["tag_shared"],
        ),
        budget_row(
            "row_rent",
            "Rent",
            1500.0,
            "opt_rent",
            "2026-04-01",
            true,
            &["tag_recurring", "tag_essential"],
        ),
        budget_row(
            "row_subway",
            "Subway",
            2.9,
            "opt_transit",
            "2026-04-23",
            true,
            &["tag_essential"],
        ),
        budget_row(
            "row_internet",
            "Internet",
            65.0,
            "opt_utilities",
            "2026-04-15",
            false,
            &["tag_recurring", "tag_essential"],
        ),
        budget_row(
            "row_groceries",
            "Groceries",
            84.32,
            "opt_food",
            "2026-04-21",
            true,
            &["tag_essential"],
        ),
    ];

    (table, rows)
}

fn budget_row(
    id: &str,
    item: &str,
    amount: f64,
    category: &str,
    date: &str,
    paid: bool,
    tags: &[&str],
) -> ParsedRow {
    let mut cells = BTreeMap::new();
    cells.insert(
        "col_item".to_string(),
        serde_yaml::Value::String(item.to_string()),
    );
    cells.insert(
        "col_amount".to_string(),
        serde_yaml::Value::Number(serde_yaml::Number::from(amount)),
    );
    cells.insert(
        "col_category".to_string(),
        serde_yaml::Value::String(category.to_string()),
    );
    cells.insert(
        "col_date".to_string(),
        serde_yaml::Value::String(date.to_string()),
    );
    cells.insert("col_paid".to_string(), serde_yaml::Value::Bool(paid));
    if !tags.is_empty() {
        cells.insert(
            "col_tags".to_string(),
            serde_yaml::Value::Sequence(
                tags.iter()
                    .map(|t| serde_yaml::Value::String(t.to_string()))
                    .collect(),
            ),
        );
    }
    ParsedRow {
        id: id.to_string(),
        table: "budget".to_string(),
        created: format!("{}T08:05:00", SEED_DATE),
        sort_key: None,
        cells,
        body: String::new(),
    }
}

fn seed_daily() -> DailyJournal {
    DailyJournal {
        date: SEED_DATE.to_string(),
        events: vec![],
        body: "## Notes\n\nKickoff for partner-dashboard work. Sam has the systems context; Morgan owns the ingestion side. Expecting one round of design feedback this week.\n\nLunch with [[Jamie Parker]] — talked through the Q3 cadence for Indie Thinkers and what topics they want to coauthor.\n\nQ2 planning with [[Quinn Morgan]] this afternoon. Bring the platform-team capacity numbers."
            .to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn person(
    id: &str,
    name: &str,
    initials: &str,
    role: &str,
    company: &str,
    email: &str,
    area: &str,
    body: &str,
) -> ParsedPerson {
    ParsedPerson {
        id: id.to_string(),
        name: name.to_string(),
        initials: initials.to_string(),
        role: role.to_string(),
        company: company.to_string(),
        email: email.to_string(),
        relationship: String::new(),
        area: Some(area.to_string()),
        avatar: None,
        // Seeded people carry no explicit timestamp; the People view falls back
        // to the file's birth time (set when the seed is written).
        created: None,
        favorite: false,
        body: body.to_string(),
    }
}

fn note(id: &str, title: &str, area: &str, created: &str, tags: &[&str], body: &str) -> ParsedNote {
    ParsedNote {
        id: id.to_string(),
        title: title.to_string(),
        area: Some(area.to_string()),
        created: created.to_string(),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        favorite: false,
        body: body.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn resource(
    id: &str,
    title: &str,
    url: &str,
    source: &str,
    _area: &str,
    saved: &str,
    tags: &[&str],
    highlights: &[&str],
    body: &str,
) -> ParsedResource {
    ParsedResource {
        id: id.to_string(),
        title: title.to_string(),
        url: url.to_string(),
        source: source.to_string(),
        area: None,
        saved: saved.to_string(),
        author: None,
        published: None,
        captured_at: None,
        content_hash: None,
        agent_status: std::collections::BTreeMap::new(),
        tags: tags.iter().map(|s| s.to_string()).collect(),
        highlights: highlights.iter().map(|s| s.to_string()).collect(),
        favorite: false,
        body: body.to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn task(
    id: &str,
    content: &str,
    status: TaskStatus,
    area: &str,
    created: &str,
    scheduled: Option<&str>,
    sort_key: f64,
    body: &str,
) -> ParsedTask {
    let _ = Ulid::new(); // keep ulid in deps tree even if all seed ids are explicit
    ParsedTask {
        id: id.to_string(),
        content: content.to_string(),
        status,
        area: area.to_string(),
        created: Some(created.to_string()),
        scheduled: scheduled.map(String::from),
        tags: vec!["task".to_string()],
        time_spent_seconds: None,
        in_progress_started_at: None,
        sort_key: Some(sort_key),
        body: body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VAULT_SUBDIRS;
    use tempfile::TempDir;

    fn fresh_vault() -> (TempDir, std::path::PathBuf) {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_path_buf();
        for sub in VAULT_SUBDIRS {
            std::fs::create_dir_all(vault.join(sub)).unwrap();
        }
        (tmp, vault)
    }

    #[test]
    fn seed_all_writes_files_to_each_subdir() {
        let (_tmp, vault) = fresh_vault();
        seed_all(&vault).unwrap();
        let people = std::fs::read_dir(vault.join("people")).unwrap().count();
        let tasks = std::fs::read_dir(vault.join("tasks")).unwrap().count();
        let notes = std::fs::read_dir(vault.join("notebook")).unwrap().count();
        let resources = std::fs::read_dir(vault_lib::resources_dir(&vault))
            .unwrap()
            .count();

        // Sample data intentionally does not create local-only events: those
        // would look like calendar events without syncing to Google Calendar.
        let events = std::fs::read_dir(vault_lib::events_dir(&vault))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
            .count();

        let dailies = std::fs::read_dir(crate::vault::cadence_dir(&vault))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok())
                    .unwrap_or(false)
            })
            .count();

        assert!(people >= 5, "expected several people, got {}", people);
        assert_eq!(events, 0, "expected no locally-created sample events");
        assert!(tasks >= 3, "expected several tasks, got {}", tasks);
        assert!(notes >= 2, "expected several notes, got {}", notes);
        assert!(
            resources >= 2,
            "expected several resources, got {}",
            resources
        );
        assert_eq!(dailies, 1, "expected one daily journal, got {}", dailies);
    }

    #[test]
    fn seed_all_writes_budget_table() {
        let (_tmp, vault) = fresh_vault();
        seed_all(&vault).unwrap();
        let dir = vault.join("tables").join("budget");
        assert!(dir.join("_schema.md").exists());
        let row_count = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                let p = e.path();
                p.extension().and_then(|s| s.to_str()) == Some("md")
                    && p.file_name().and_then(|s| s.to_str()) != Some("_schema.md")
            })
            .count();
        assert!(
            row_count >= 5,
            "expected several budget rows, got {}",
            row_count
        );
    }

    #[test]
    fn seed_records_roundtrip_through_parsers() {
        // Every seeded record must parse back into an equal struct,
        // otherwise the demo will surface "skipping corrupt file" warnings.
        for p in seed_people() {
            let s = parsers::serialize_person(&p).unwrap();
            assert_eq!(parsers::parse_person(&s).unwrap(), p);
        }
        for t in seed_tasks() {
            let s = parsers::serialize_task(&t).unwrap();
            assert_eq!(parsers::parse_task(&s).unwrap(), t);
        }
        for n in seed_notes() {
            let s = parsers::serialize_note(&n).unwrap();
            assert_eq!(parsers::parse_note(&s).unwrap(), n);
        }
        for b in seed_resources() {
            let s = parsers::serialize_resource(&b).unwrap();
            assert_eq!(parsers::parse_resource(&s).unwrap(), b);
        }
        let d = seed_daily();
        let s = parsers::serialize_daily(&d).unwrap();
        assert_eq!(parsers::parse_daily(&s).unwrap(), d);

        let (table, rows) = seed_budget_table();
        let s = parsers::serialize_table_schema(&table).unwrap();
        assert_eq!(parsers::parse_table_schema(&s).unwrap(), table);
        for row in rows {
            let s = parsers::serialize_row(&row).unwrap();
            assert_eq!(parsers::parse_row(&s).unwrap(), row);
        }
    }

    #[test]
    fn seed_all_is_idempotent() {
        let (_tmp, vault) = fresh_vault();
        seed_all(&vault).unwrap();
        let count_first = std::fs::read_dir(vault.join("people")).unwrap().count();
        seed_all(&vault).unwrap();
        let count_second = std::fs::read_dir(vault.join("people")).unwrap().count();
        assert_eq!(
            count_first, count_second,
            "re-seeding should overwrite, not duplicate"
        );
    }
}
