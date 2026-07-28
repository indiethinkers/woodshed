// Parsers: serialize/deserialize markdown + YAML frontmatter to typed records.
//
// Roundtrip equality is the hard requirement: serialize(parse(x)) == x for any
// well-formed input. Frontmatter key order is fixed by the struct definition so
// rewrites produce stable diffs.
//
// One deliberate exception: `serialize_resource` always writes `area: None`,
// because resources do not belong to an area. A hand-written `area:` on a
// resource file therefore survives the parse but is dropped on the next write.
// See the comment on that field and `resource_legacy_area_is_dropped_on_write`.

use anyhow::{anyhow, Context, Result};
use gray_matter::{engine::YAML, Matter};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// serde skip helper: omit `favorite: false` from frontmatter so the flag
/// only appears in files the user actually starred.
fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Backlog,
    InProgress,
    Done,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecurringRule {
    None,
    Daily,
    Weekly,
    Monthly,
}

/// Origin of an event. `None` on the parsed struct means vault-local
/// (user created via "+ Add event"); explicit variants flag externally
/// synced events. iCal is read-only; future variants (Google OAuth,
/// Outlook) will carry write support.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EventProvider {
    Ical,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    pub id: String,
    pub content: String,
    pub status: TaskStatus,
    pub area: String,
    pub created: Option<String>,
    pub scheduled: Option<String>,
    pub tags: Vec<String>,
    /// Accumulated seconds the task has spent in the in-progress state.
    /// Increments every time status transitions away from in-progress.
    pub time_spent_seconds: Option<u64>,
    /// ISO 8601 timestamp marking when the current timer run started.
    /// `None` when the task is not active or is active with a paused timer.
    pub in_progress_started_at: Option<String>,
    /// Manual ordering within a (scheduled-date, space, backlog) group.
    /// New tasks fall back to creation time when this is missing; explicit
    /// values written by drag-reorder. Float so we can wedge midpoints
    /// between neighbors without renumbering.
    pub sort_key: Option<f64>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub date: String,
    pub duration: u32,
    pub area: String,
    pub attendees: Vec<String>,
    pub recurring: RecurringRule,
    /// `None` for vault-local events (the legacy/default case).
    /// `Some(Ical)` for events synced from an iCal subscription URL.
    pub provider: Option<EventProvider>,
    /// Stable id of the external account/calendar this event came from.
    /// Paired with `provider` to identify the source.
    pub account_id: Option<String>,
    /// External id (the iCal UID, eventually Google Calendar event id).
    /// Used by reconciliation to detect orphaned events on re-sync.
    pub external_id: Option<String>,
    /// Whether this event can be edited in Woodshed. `None` ≡ `true`
    /// (vault-local default). iCal-synced events emit `Some(false)`
    /// so the absence-vs-true distinction in legacy files stays clean.
    pub writable: Option<bool>,
    /// Original `RRULE:` line from an external feed, preserved verbatim
    /// even when our `recurring` enum can't render it. Lets a future
    /// bidirectional sync (Phase 2b) write events back without losing
    /// recurrence rules we don't understand yet.
    pub rrule_original: Option<String>,
    /// iCal note files start as snapshots of the source event. These
    /// fields mark which snapshotted metadata values the user actually
    /// changed locally, so later Google Calendar updates do not get
    /// overwritten by stale auto-materialized frontmatter.
    pub local_metadata_overrides: Vec<String>,
    /// User-applied tags. `event` is implicit from `type: event` and
    /// is NOT persisted here — the tag-table query for `#event` reads
    /// every file with `type: event`. This list is for additional tags
    /// like `1on1`, `sponsor`, `sales`, etc.
    pub tags: Vec<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyJournal {
    pub date: String,
    /// Vault-local events scheduled for this day. Stored inline rather
    /// than as separate `cadence/<slug>-<date>.md` files — the legacy
    /// per-event-file approach polluted the vault and didn't scale
    /// past a few hundred events. Recurring events live in the daily
    /// file for their first occurrence; the events query projects
    /// later occurrences at read time.
    pub events: Vec<Event>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub initials: String,
    pub role: String,
    pub company: String,
    pub email: String,
    /// Free-text relationship note, maintained manually by the user.
    pub relationship: String,
    pub area: Option<String>,
    pub avatar: Option<String>,
    /// ISO 8601 timestamp marking when the person was added. Optional because
    /// people created before this field existed have no `created:` key — the
    /// command layer backfills it from the file's birth time on first write.
    pub created: Option<String>,
    /// User-starred flag. Only serialized when true.
    pub favorite: bool,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub area: Option<String>,
    /// ISO 8601 timestamp; preserved verbatim across roundtrips.
    pub created: String,
    pub tags: Vec<String>,
    /// User-starred flag. Only serialized when true.
    pub favorite: bool,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceAgentRun {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposals: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resource {
    pub id: String,
    pub title: String,
    pub url: String,
    /// Display label for the source (typically the domain, e.g. "stephango.com").
    pub source: String,
    pub area: Option<String>,
    /// ISO 8601 timestamp marking when this resource was saved.
    pub saved: String,
    pub author: Option<String>,
    pub published: Option<String>,
    pub captured_at: Option<String>,
    pub content_hash: Option<String>,
    pub agent_status: BTreeMap<String, ResourceAgentRun>,
    pub tags: Vec<String>,
    /// Captured passages from the source. Stored as a frontmatter list so a
    /// future browser extension can post structured highlights and so tag
    /// tables can later index the spans separately from user notes.
    pub highlights: Vec<String>,
    /// User-starred flag. Only serialized when true.
    pub favorite: bool,
    /// User-authored notes about the resource. Markdown.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Area {
    pub id: String,
    pub name: String,
    /// Legacy hex color. Empty when the area file has no `color:` key.
    pub color: String,
    /// ISO 8601 timestamp; optional because pre-file-per-area vaults don't have one.
    pub created: Option<String>,
    /// Freeform markdown description (purpose, key people, history, etc.).
    /// May be empty for areas migrated from data/areas.json.
    pub body: String,
}

/// Kinds of columns a table supports. New types are additive: existing
/// vault files keep parsing because columns the runtime doesn't know yet are
/// rejected at deserialization time, surfacing the issue rather than silently
/// dropping data.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    Text,
    Number,
    Select,
    MultiSelect,
    Checkbox,
    Date,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectOption {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// Display format for a Number column. Only the rendering changes — the
/// stored cell value is always a raw number. Currency variants format with
/// `Intl.NumberFormat` on the frontend.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NumberFormat {
    /// Plain number (default): grouped thousands separators.
    Number,
    UsDollar,
    Euro,
    BritishPound,
    JapaneseYen,
    Percent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: ColumnType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SelectOption>,
    /// Pixel width set by the user via the resize handle. None means use
    /// the per-position default (wider for the title column, narrower
    /// elsewhere). Stored on the column itself so widths are stable across
    /// views.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Number-column display format. Only meaningful when `type_` is Number;
    /// kept on the base struct so it survives a temporary type change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<NumberFormat>,
    /// Decimal places for number rendering. None → format default (currency
    /// uses 2, plain number uses up to 6 significant digits).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision: Option<u32>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewSort {
    pub column: String,
    pub direction: SortDirection,
}

/// A single filter condition. `op` and `value` shape depend on the column
/// type — validated at apply time, not parse time, so a future op doesn't
/// fail roundtrip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ViewFilter {
    pub column: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_yaml::Value>,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FilterCombineOp {
    #[default]
    And,
    Or,
}

/// Compound filter on a view. Single-level depth (n conditions all combined
/// with the same `op`). Notion-style nested groups would expand this to a
/// recursive shape — Phase 3 territory.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ViewFilters {
    #[serde(default)]
    pub op: FilterCombineOp,
    #[serde(default)]
    pub conditions: Vec<ViewFilter>,
}

impl ViewFilters {
    pub fn is_empty(&self) -> bool {
        self.conditions.is_empty()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CalcFn {
    Sum,
    Count,
    Avg,
    Min,
    Max,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct View {
    pub id: String,
    pub name: String,
    /// View kind: "table" | "board". Future: calendar, gallery, list.
    #[serde(rename = "type")]
    pub type_: String,
    /// Multi-column sort applied in priority order. Empty = no sort.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sorts: Vec<ViewSort>,
    /// Compound filter. Empty conditions = no filter.
    #[serde(default, skip_serializing_if = "ViewFilters::is_empty")]
    pub filters: ViewFilters,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub calculations: BTreeMap<String, CalcFn>,
    /// Column id used to group rows in a board view. Required for board
    /// views; ignored for table views.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub id: String,
    pub name: String,
    pub created: String,
    /// User-starred flag. Only serialized when true.
    pub favorite: bool,
    pub columns: Vec<Column>,
    pub views: Vec<View>,
}

/// A single row in a table. Cells are keyed by column id (not name) so
/// renaming a column doesn't strand cell values. Missing column ids in
/// the cells map are treated as empty.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    pub table: String,
    pub created: String,
    pub cells: BTreeMap<String, serde_yaml::Value>,
    pub body: String,
}

// Frontmatter shapes are defined separately so serialization order is stable
// (serde uses struct field order for YAML output).

#[derive(Debug, Serialize, Deserialize)]
struct TaskFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    content: String,
    status: TaskStatus,
    #[serde(alias = "space")]
    area: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    created: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    scheduled: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    time_spent_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    in_progress_started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    sort_key: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct EventFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    subtitle: Option<String>,
    date: String,
    duration: u32,
    #[serde(alias = "space")]
    area: String,
    #[serde(default)]
    attendees: Vec<String>,
    #[serde(default = "default_recurring")]
    recurring: RecurringRule,
    // Provider-distinction fields. All Option-typed with skip_serializing_if
    // so legacy vault-local events roundtrip byte-identically — the new keys
    // only appear in frontmatter when an external sync writes them.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    provider: Option<EventProvider>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    writable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    rrule_original: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    local_metadata_overrides: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
}

fn default_recurring() -> RecurringRule {
    RecurringRule::None
}

/// Normalize body content extracted from a markdown file.
/// Strips leading and trailing newlines; gray_matter already strips trailing
/// whitespace, but a single trailing newline survives in some inputs. The
/// canonical body form has no surrounding whitespace.
fn normalize_body(content: &str) -> String {
    content.trim_matches('\n').to_string()
}

#[derive(Debug, Serialize, Deserialize)]
struct DailyFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    date: String,
    /// One frontmatter entry per event scheduled on this day. Missing
    /// entirely on legacy daily files (pre-event-inlining) — `default`
    /// keeps those files parsing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    events: Vec<InlineEventFrontmatter>,
}

/// On-disk shape of an event embedded inside a DailyFrontmatter. Drops
/// `type:` (it's implicit from being in a daily's events array) and
/// the provider/account_id/external_id/writable/rrule_original fields
/// that only apply to externally-synced events (those live in the
/// JSON cache, not inline). The remaining shape mirrors EventFrontmatter
/// 1:1 so vault-local events roundtrip cleanly.
#[derive(Debug, Serialize, Deserialize)]
struct InlineEventFrontmatter {
    id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    subtitle: Option<String>,
    date: String,
    duration: u32,
    #[serde(alias = "space")]
    area: String,
    #[serde(default)]
    attendees: Vec<String>,
    #[serde(default = "default_recurring")]
    recurring: RecurringRule,
    /// Optional notes for the event. Stored as a multiline string in
    /// the YAML. Empty by default.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    body: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PersonFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    name: String,
    // initials/role/company/email are user-supplied free text — the user
    // often adds a person they only know the name + email of (or just the
    // name). Wikilink-driven creation (`[[Joe]]` on a cadence page) seeds
    // them as empty strings. Skip-on-empty keeps the on-disk YAML free
    // of `role: ''` / `company: ''` noise for those cases; missing-on-read
    // defaults back to empty, so roundtrip is stable.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    initials: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    role: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    company: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    email: String,
    /// Free-text relationship note ("college friend", "Acme PM") the
    /// user maintains by hand. Same skip-on-empty treatment as the other
    /// user-supplied text fields above.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    relationship: String,
    #[serde(alias = "space", default, skip_serializing_if = "Option::is_none")]
    area: Option<String>,
    // `color` used to seed the avatar's fallback background, but the
    // Person model no longer carries it — every avatar fallback is a
    // single Woodshed-teal now, and user-uploaded images take
    // precedence. Tolerated as an unknown field on existing files
    // (serde ignores unknowns by default); next write drops it from
    // the frontmatter.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    created: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    favorite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct NoteFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    title: String,
    #[serde(alias = "space", default, skip_serializing_if = "Option::is_none")]
    area: Option<String>,
    created: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    favorite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct ResourceFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    title: String,
    url: String,
    source: String,
    #[serde(alias = "space", default, skip_serializing_if = "Option::is_none")]
    area: Option<String>,
    saved: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    published: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    captured_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    agent_status: BTreeMap<String, ResourceAgentRun>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    highlights: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    favorite: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct AreaFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    color: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    created: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TableFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    name: String,
    created: String,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    columns: Vec<Column>,
    #[serde(default)]
    views: Vec<ViewFrontmatter>,
}

/// View shape on disk, accepting both the new `sorts`/`filters` arrays and
/// the legacy single-condition `sort`/`filter` fields. Promotion happens in
/// `From<ViewFrontmatter> for View`. On rewrite we only emit the new shape;
/// after one save the legacy fields are gone.
#[derive(Debug, Serialize, Deserialize)]
struct ViewFrontmatter {
    id: String,
    name: String,
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    sorts: Vec<ViewSort>,
    #[serde(default)]
    filters: Option<ViewFilters>,
    #[serde(default)]
    sort: Option<ViewSort>,
    #[serde(default)]
    filter: Option<ViewFilter>,
    #[serde(default)]
    hidden: Vec<String>,
    #[serde(default)]
    calculations: BTreeMap<String, CalcFn>,
    #[serde(default)]
    group_by: Option<String>,
}

impl From<ViewFrontmatter> for View {
    fn from(fm: ViewFrontmatter) -> Self {
        let sorts = if !fm.sorts.is_empty() {
            fm.sorts
        } else if let Some(legacy) = fm.sort {
            vec![legacy]
        } else {
            Vec::new()
        };
        let filters = match fm.filters {
            Some(f) if !f.conditions.is_empty() => f,
            _ => match fm.filter {
                Some(legacy) => ViewFilters {
                    op: FilterCombineOp::And,
                    conditions: vec![legacy],
                },
                None => ViewFilters {
                    op: FilterCombineOp::And,
                    conditions: Vec::new(),
                },
            },
        };
        View {
            id: fm.id,
            name: fm.name,
            type_: fm.type_,
            sorts,
            filters,
            hidden: fm.hidden,
            calculations: fm.calculations,
            group_by: fm.group_by,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct RowFrontmatter {
    #[serde(rename = "type")]
    type_: String,
    id: String,
    table: String,
    created: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    cells: BTreeMap<String, serde_yaml::Value>,
}

pub fn parse_task(content: &str) -> Result<Task> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("task file has no frontmatter"))?;
    let fm: TaskFrontmatter = data.deserialize().context("deserialize task frontmatter")?;
    if fm.type_ != "task" {
        return Err(anyhow!("expected type=task, got type={}", fm.type_));
    }
    Ok(Task {
        id: fm.id,
        content: fm.content,
        status: fm.status,
        area: fm.area,
        created: fm.created,
        scheduled: fm.scheduled,
        tags: fm.tags,
        time_spent_seconds: fm.time_spent_seconds,
        in_progress_started_at: fm.in_progress_started_at,
        sort_key: fm.sort_key,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_task(task: &Task) -> Result<String> {
    let fm = TaskFrontmatter {
        type_: "task".to_string(),
        id: task.id.clone(),
        content: task.content.clone(),
        status: task.status,
        area: task.area.clone(),
        created: task.created.clone(),
        scheduled: task.scheduled.clone(),
        tags: task.tags.clone(),
        time_spent_seconds: task.time_spent_seconds,
        in_progress_started_at: task.in_progress_started_at.clone(),
        sort_key: task.sort_key,
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize task frontmatter")?;
    if task.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, task.body))
    }
}

pub fn parse_event(content: &str) -> Result<Event> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("event file has no frontmatter"))?;
    let fm: EventFrontmatter = data
        .deserialize()
        .context("deserialize event frontmatter")?;
    if fm.type_ != "event" {
        return Err(anyhow!("expected type=event, got type={}", fm.type_));
    }
    Ok(Event {
        id: fm.id,
        title: fm.title,
        subtitle: fm.subtitle,
        date: fm.date,
        duration: fm.duration,
        area: fm.area,
        attendees: fm.attendees,
        recurring: fm.recurring,
        provider: fm.provider,
        account_id: fm.account_id,
        external_id: fm.external_id,
        writable: fm.writable,
        rrule_original: fm.rrule_original,
        local_metadata_overrides: fm.local_metadata_overrides,
        tags: fm.tags,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_event(event: &Event) -> Result<String> {
    let fm = EventFrontmatter {
        type_: "event".to_string(),
        id: event.id.clone(),
        title: event.title.clone(),
        subtitle: event.subtitle.clone(),
        date: event.date.clone(),
        duration: event.duration,
        area: event.area.clone(),
        attendees: event.attendees.clone(),
        recurring: event.recurring,
        provider: event.provider,
        account_id: event.account_id.clone(),
        external_id: event.external_id.clone(),
        writable: event.writable,
        rrule_original: event.rrule_original.clone(),
        local_metadata_overrides: event.local_metadata_overrides.clone(),
        tags: event.tags.clone(),
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize event frontmatter")?;
    if event.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, event.body))
    }
}

pub fn parse_daily(content: &str) -> Result<DailyJournal> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("daily file has no frontmatter"))?;
    let fm: DailyFrontmatter = data
        .deserialize()
        .context("deserialize daily frontmatter")?;
    if fm.type_ != "daily" {
        return Err(anyhow!("expected type=daily, got type={}", fm.type_));
    }
    let events = fm
        .events
        .into_iter()
        .map(|ev| Event {
            id: ev.id,
            title: ev.title,
            subtitle: ev.subtitle,
            date: ev.date,
            duration: ev.duration,
            area: ev.area,
            attendees: ev.attendees,
            recurring: ev.recurring,
            // Provider/account/external/writable/rrule are never set
            // on inline events — those fields only exist for external
            // sync (iCal cache). Defaulting to None keeps the parsed
            // Event shape uniform across both paths.
            provider: None,
            account_id: None,
            external_id: None,
            writable: None,
            rrule_original: None,
            local_metadata_overrides: Vec::new(),
            tags: Vec::new(),
            body: ev.body,
        })
        .collect();
    Ok(DailyJournal {
        date: fm.date,
        events,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_daily(journal: &DailyJournal) -> Result<String> {
    let events = journal
        .events
        .iter()
        .map(|e| InlineEventFrontmatter {
            id: e.id.clone(),
            title: e.title.clone(),
            subtitle: e.subtitle.clone(),
            date: e.date.clone(),
            duration: e.duration,
            area: e.area.clone(),
            attendees: e.attendees.clone(),
            recurring: e.recurring,
            body: e.body.clone(),
        })
        .collect();
    let fm = DailyFrontmatter {
        type_: "daily".to_string(),
        date: journal.date.clone(),
        events,
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize daily frontmatter")?;
    if journal.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, journal.body))
    }
}

pub fn parse_person(content: &str) -> Result<Person> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("person file has no frontmatter"))?;
    let fm: PersonFrontmatter = data
        .deserialize()
        .context("deserialize person frontmatter")?;
    if fm.type_ != "person" {
        return Err(anyhow!("expected type=person, got type={}", fm.type_));
    }
    Ok(Person {
        id: fm.id,
        name: fm.name,
        initials: fm.initials,
        role: fm.role,
        company: fm.company,
        email: fm.email,
        relationship: fm.relationship,
        area: fm.area,
        avatar: fm.avatar,
        created: fm.created,
        favorite: fm.favorite,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_person(person: &Person) -> Result<String> {
    let fm = PersonFrontmatter {
        type_: "person".to_string(),
        id: person.id.clone(),
        name: person.name.clone(),
        initials: person.initials.clone(),
        role: person.role.clone(),
        company: person.company.clone(),
        email: person.email.clone(),
        relationship: person.relationship.clone(),
        area: person.area.clone(),
        avatar: person.avatar.clone(),
        created: person.created.clone(),
        favorite: person.favorite,
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize person frontmatter")?;
    if person.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, person.body))
    }
}

pub fn parse_note(content: &str) -> Result<Note> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("note file has no frontmatter"))?;
    let fm: NoteFrontmatter = data.deserialize().context("deserialize note frontmatter")?;
    if fm.type_ != "note" {
        return Err(anyhow!("expected type=note, got type={}", fm.type_));
    }
    Ok(Note {
        id: fm.id,
        title: fm.title,
        area: fm.area,
        created: fm.created,
        tags: fm.tags,
        favorite: fm.favorite,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_note(note: &Note) -> Result<String> {
    let fm = NoteFrontmatter {
        type_: "note".to_string(),
        id: note.id.clone(),
        title: note.title.clone(),
        area: note.area.clone(),
        created: note.created.clone(),
        tags: note.tags.clone(),
        favorite: note.favorite,
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize note frontmatter")?;
    if note.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, note.body))
    }
}

pub fn parse_resource(content: &str) -> Result<Resource> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("resource file has no frontmatter"))?;
    let fm: ResourceFrontmatter = data
        .deserialize()
        .context("deserialize resource frontmatter")?;
    if fm.type_ != "resource" {
        return Err(anyhow!("expected type=resource, got type={}", fm.type_));
    }
    Ok(Resource {
        id: fm.id,
        title: fm.title,
        url: fm.url,
        source: fm.source,
        area: fm.area,
        saved: fm.saved,
        author: fm.author,
        published: fm.published,
        captured_at: fm.captured_at,
        content_hash: fm.content_hash,
        agent_status: fm.agent_status,
        tags: fm.tags,
        highlights: fm.highlights,
        favorite: fm.favorite,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_resource(resource: &Resource) -> Result<String> {
    let fm = ResourceFrontmatter {
        type_: "resource".to_string(),
        id: resource.id.clone(),
        title: resource.title.clone(),
        url: resource.url.clone(),
        source: resource.source.clone(),
        // Intentionally not `resource.area`. Resources do not belong to an
        // area, so the key is shed on every write rather than round-tripped —
        // the one documented exception to the invariant at the top of this
        // module. `Resource::area` exists only to keep parsing legacy files
        // that still carry the key. Pinned by
        // `resource_legacy_area_is_dropped_on_write`.
        area: None,
        saved: resource.saved.clone(),
        author: resource.author.clone(),
        published: resource.published.clone(),
        captured_at: resource.captured_at.clone(),
        content_hash: resource.content_hash.clone(),
        agent_status: resource.agent_status.clone(),
        tags: resource.tags.clone(),
        highlights: resource.highlights.clone(),
        favorite: resource.favorite,
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize resource frontmatter")?;
    if resource.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, resource.body))
    }
}

pub fn parse_area(content: &str) -> Result<Area> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("area file has no frontmatter"))?;
    let fm: AreaFrontmatter = data.deserialize().context("deserialize area frontmatter")?;
    if fm.type_ != "area" {
        return Err(anyhow!("expected type=area, got type={}", fm.type_));
    }
    Ok(Area {
        id: fm.id,
        name: fm.name,
        color: fm.color,
        created: fm.created,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_area(area: &Area) -> Result<String> {
    let fm = AreaFrontmatter {
        type_: "area".to_string(),
        id: area.id.clone(),
        name: area.name.clone(),
        color: area.color.clone(),
        created: area.created.clone(),
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize area frontmatter")?;
    if area.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, area.body))
    }
}

pub fn parse_table_schema(content: &str) -> Result<Table> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("table schema has no frontmatter"))?;
    let fm: TableFrontmatter = data
        .deserialize()
        .context("deserialize table frontmatter")?;
    if fm.type_ != "table" {
        return Err(anyhow!("expected type=table, got type={}", fm.type_));
    }
    Ok(Table {
        id: fm.id,
        name: fm.name,
        created: fm.created,
        favorite: fm.favorite,
        columns: fm.columns,
        views: fm.views.into_iter().map(View::from).collect(),
    })
}

pub fn serialize_table_schema(table: &Table) -> Result<String> {
    // Serialize via View directly (clean shape: sorts/filters arrays only,
    // legacy fields dropped). Roundtrip equality holds against this shape.
    #[derive(Serialize)]
    struct OutFrontmatter<'a> {
        #[serde(rename = "type")]
        type_: &'static str,
        id: &'a str,
        name: &'a str,
        created: &'a str,
        #[serde(skip_serializing_if = "is_false")]
        favorite: bool,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        columns: &'a Vec<Column>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        views: &'a Vec<View>,
    }
    let out = OutFrontmatter {
        type_: "table",
        id: &table.id,
        name: &table.name,
        created: &table.created,
        favorite: table.favorite,
        columns: &table.columns,
        views: &table.views,
    };
    let yaml = serde_yaml::to_string(&out).context("serialize table frontmatter")?;
    Ok(format!("---\n{}---\n", yaml))
}

pub fn parse_row(content: &str) -> Result<Row> {
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(content);
    let data = parsed
        .data
        .ok_or_else(|| anyhow!("row file has no frontmatter"))?;
    let fm: RowFrontmatter = data.deserialize().context("deserialize row frontmatter")?;
    if fm.type_ != "row" {
        return Err(anyhow!("expected type=row, got type={}", fm.type_));
    }
    Ok(Row {
        id: fm.id,
        table: fm.table,
        created: fm.created,
        cells: fm.cells,
        body: normalize_body(&parsed.content),
    })
}

pub fn serialize_row(row: &Row) -> Result<String> {
    let fm = RowFrontmatter {
        type_: "row".to_string(),
        id: row.id.clone(),
        table: row.table.clone(),
        created: row.created.clone(),
        cells: row.cells.clone(),
    };
    let yaml = serde_yaml::to_string(&fm).context("serialize row frontmatter")?;
    if row.body.is_empty() {
        Ok(format!("---\n{}---\n", yaml))
    } else {
        Ok(format!("---\n{}---\n\n{}", yaml, row.body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task() -> Task {
        Task {
            id: "t_01HM3X9YQK".to_string(),
            content: "Ship pricing rewrite".to_string(),
            status: TaskStatus::InProgress,
            area: "woodshed".to_string(),
            created: Some("2026-04-23T14:22:00-04:00".to_string()),
            scheduled: Some("2026-04-25".to_string()),
            tags: vec!["task".to_string()],
            time_spent_seconds: None,
            in_progress_started_at: None,
            sort_key: None,
            body: "Subtask: review with Sam".to_string(),
        }
    }

    fn sample_event() -> Event {
        Event {
            id: "e_01HM3Z".to_string(),
            title: "Alex/Jordan 1:1".to_string(),
            subtitle: None,
            date: "2026-04-25T08:00:00-04:00".to_string(),
            duration: 30,
            area: "acme".to_string(),
            attendees: vec!["alex-rivera".to_string(), "jordan-lee".to_string()],
            recurring: RecurringRule::Weekly,
            provider: None,
            account_id: None,
            external_id: None,
            writable: None,
            rrule_original: None,
            local_metadata_overrides: Vec::new(),
            tags: vec!["1on1".to_string()],
            body: "Agenda:\n- Q3 roadmap".to_string(),
        }
    }

    fn sample_daily() -> DailyJournal {
        DailyJournal {
            date: "2026-04-25".to_string(),
            events: vec![],
            body: "## Notes\nLunch with [[Jamie Parker]].".to_string(),
        }
    }

    fn sample_person() -> Person {
        Person {
            id: "alex-rivera".to_string(),
            name: "Alex Rivera".to_string(),
            initials: "AR".to_string(),
            role: "Software Engineer".to_string(),
            company: "Woodshed".to_string(),
            email: "alex@woodshed.com".to_string(),
            relationship: "Former teammate".to_string(),
            area: Some("woodshed".to_string()),
            avatar: Some("/avatars/alex.jpg".to_string()),
            created: Some("2026-05-20T17:59:00-07:00".to_string()),
            favorite: false,
            body: "Senior engineer on the integrations squad.".to_string(),
        }
    }

    fn sample_note() -> Note {
        Note {
            id: "file-over-app".to_string(),
            title: "File-over-app philosophy".to_string(),
            area: Some("indie-thinkers".to_string()),
            created: "2026-04-12T12:30:00".to_string(),
            tags: vec!["essay".to_string(), "idea".to_string()],
            favorite: false,
            body: "The premise is simple: if your tools vanish tomorrow, do your files survive?"
                .to_string(),
        }
    }

    fn sample_resource() -> Resource {
        Resource {
            id: "local-first-software".to_string(),
            title: "Local-first software".to_string(),
            url: "https://www.inkandswitch.com/local-first/".to_string(),
            source: "inkandswitch.com".to_string(),
            area: None,
            saved: "2026-04-10T09:15:00".to_string(),
            author: Some("Ink & Switch".to_string()),
            published: Some("2019-04-30".to_string()),
            captured_at: Some("2026-04-10T09:15:03".to_string()),
            content_hash: Some("sha256:sample".to_string()),
            agent_status: BTreeMap::new(),
            tags: vec!["local-first".to_string(), "philosophy".to_string()],
            highlights: vec![
                "Seven ideals for local-first software".to_string(),
                "Cloud apps are not permanent".to_string(),
            ],
            favorite: false,
            body: "Saved while researching the Woodshed vault format.".to_string(),
        }
    }

    fn sample_area() -> Area {
        Area {
            id: "woodshed".to_string(),
            name: "Woodshed".to_string(),
            color: "#378ADD".to_string(),
            created: Some("2026-05-10T15:00:00-07:00".to_string()),
            body:
                "The product itself. Source at `~/Code/woodshed`. Jordan & Alex work here together."
                    .to_string(),
        }
    }

    #[test]
    fn task_roundtrip_equality() {
        let t = sample_task();
        let serialized = serialize_task(&t).unwrap();
        let parsed = parse_task(&serialized).unwrap();
        assert_eq!(t, parsed);
    }

    #[test]
    fn task_handles_missing_optionals() {
        let raw = "---\ntype: task\nid: t_001\ncontent: Buy milk\nstatus: backlog\nspace: personal\n---\n";
        let parsed = parse_task(raw).unwrap();
        assert_eq!(parsed.id, "t_001");
        assert_eq!(parsed.status, TaskStatus::Backlog);
        assert_eq!(parsed.created, None);
        assert_eq!(parsed.scheduled, None);
        assert!(parsed.tags.is_empty());
    }

    #[test]
    fn task_malformed_frontmatter_errors() {
        let raw = "no frontmatter here";
        assert!(parse_task(raw).is_err());

        let bad = "---\ntype: not-task\nid: x\ncontent: y\nstatus: backlog\nspace: woodshed\n---\n";
        assert!(parse_task(bad).is_err());
    }

    #[test]
    fn task_empty_body_serializes_cleanly() {
        let t = Task {
            id: "t_001".to_string(),
            content: "x".to_string(),
            status: TaskStatus::Backlog,
            area: "woodshed".to_string(),
            created: None,
            scheduled: None,
            tags: vec![],
            time_spent_seconds: None,
            in_progress_started_at: None,
            sort_key: None,
            body: String::new(),
        };
        let s = serialize_task(&t).unwrap();
        assert!(s.starts_with("---\n"));
        assert!(s.ends_with("---\n"));
        let parsed = parse_task(&s).unwrap();
        assert_eq!(parsed.body, "");
    }

    #[test]
    fn task_status_serializes_kebab_case() {
        let t = sample_task();
        let s = serialize_task(&t).unwrap();
        assert!(s.contains("status: in-progress"));
    }

    #[test]
    fn event_roundtrip_equality() {
        let e = sample_event();
        let serialized = serialize_event(&e).unwrap();
        let parsed = parse_event(&serialized).unwrap();
        assert_eq!(e, parsed);
    }

    #[test]
    fn event_recurring_defaults_to_none() {
        let raw = "---\ntype: event\nid: e_001\ntitle: Standup\ndate: 2026-04-25T09:00:00-04:00\nduration: 15\nspace: woodshed\nattendees: []\n---\n";
        let parsed = parse_event(raw).unwrap();
        assert_eq!(parsed.recurring, RecurringRule::None);
    }

    #[test]
    fn event_malformed_errors() {
        assert!(parse_event("---\ntype: task\nid: x\n---\n").is_err());
    }

    #[test]
    fn event_legacy_serializes_without_new_keys() {
        // Vault-local events (no provider/account_id/etc.) must serialize
        // byte-identically to the pre-iCal-integration shape — the new
        // optional fields are entirely absent from the YAML, not present
        // as `null` keys.
        let s = serialize_event(&sample_event()).unwrap();
        assert!(!s.contains("provider"), "got: {}", s);
        assert!(!s.contains("account_id"), "got: {}", s);
        assert!(!s.contains("external_id"), "got: {}", s);
        assert!(!s.contains("writable"), "got: {}", s);
        assert!(!s.contains("rrule_original"), "got: {}", s);
        assert!(!s.contains("local_metadata_overrides"), "got: {}", s);
    }

    #[test]
    fn event_ical_provider_roundtrip_preserves_new_fields() {
        let e = Event {
            id: "e_ical_1".to_string(),
            title: "All Hands".to_string(),
            subtitle: None,
            date: "2026-05-11T08:30:00-04:00".to_string(),
            duration: 60,
            area: "acme".to_string(),
            attendees: vec![],
            recurring: RecurringRule::Weekly,
            provider: Some(EventProvider::Ical),
            account_id: Some("gcal_01HW".to_string()),
            external_id: Some("9k4f8c4q@google.com".to_string()),
            writable: Some(false),
            rrule_original: Some("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959Z".to_string()),
            local_metadata_overrides: vec!["date".to_string()],
            tags: vec![],
            body: String::new(),
        };
        let serialized = serialize_event(&e).unwrap();
        // The new keys all emit as snake_case (matching the Rust field names —
        // EventFrontmatter has no rename_all). Verify before reparsing.
        assert!(serialized.contains("provider: ical"), "got: {}", serialized);
        assert!(
            serialized.contains("writable: false"),
            "got: {}",
            serialized
        );
        assert!(
            serialized.contains("local_metadata_overrides"),
            "got: {}",
            serialized
        );
        let parsed = parse_event(&serialized).unwrap();
        assert_eq!(parsed, e);
    }

    #[test]
    fn daily_roundtrip_equality() {
        let d = sample_daily();
        let serialized = serialize_daily(&d).unwrap();
        let parsed = parse_daily(&serialized).unwrap();
        assert_eq!(d, parsed);
    }

    #[test]
    fn daily_preserves_body_with_wikilinks() {
        let d = DailyJournal {
            date: "2026-04-25".to_string(),
            events: vec![],
            body: "[[Alex]] and [[Jamie Parker]] discussed #idea about [[file-over-app]]."
                .to_string(),
        };
        let s = serialize_daily(&d).unwrap();
        let parsed = parse_daily(&s).unwrap();
        assert_eq!(parsed.body, d.body);
    }

    #[test]
    fn daily_roundtrip_with_inline_events() {
        let d = DailyJournal {
            date: "2026-05-11".to_string(),
            events: vec![
                Event {
                    id: "e_001".to_string(),
                    title: "1:1 with Alex".to_string(),
                    subtitle: None,
                    date: "2026-05-11T08:00:00-04:00".to_string(),
                    duration: 30,
                    area: "acme".to_string(),
                    attendees: vec!["alex-rivera".to_string()],
                    recurring: RecurringRule::Weekly,
                    provider: None,
                    account_id: None,
                    external_id: None,
                    writable: None,
                    rrule_original: None,
                    local_metadata_overrides: Vec::new(),
                    tags: vec![],
                    body: "Q3 planning agenda".to_string(),
                },
                Event {
                    id: "e_002".to_string(),
                    title: "All Hands".to_string(),
                    subtitle: None,
                    date: "2026-05-11T15:00:00-04:00".to_string(),
                    duration: 60,
                    area: "woodshed".to_string(),
                    attendees: vec![],
                    recurring: RecurringRule::None,
                    provider: None,
                    account_id: None,
                    external_id: None,
                    writable: None,
                    rrule_original: None,
                    local_metadata_overrides: Vec::new(),
                    tags: vec![],
                    body: String::new(),
                },
            ],
            body: "## What I worked on\nShipped the events refactor.".to_string(),
        };
        let serialized = serialize_daily(&d).unwrap();
        let parsed = parse_daily(&serialized).unwrap();
        assert_eq!(parsed, d);
    }

    #[test]
    fn daily_legacy_without_events_array_still_parses() {
        // Pre-inlining daily files have no `events:` key. They must
        // continue to parse with an empty events vec.
        let raw = "---\ntype: daily\ndate: 2026-05-11\n---\n\nSome notes.";
        let parsed = parse_daily(raw).unwrap();
        assert!(parsed.events.is_empty());
        assert_eq!(parsed.body, "Some notes.");
    }

    #[test]
    fn daily_without_events_omits_key_in_yaml() {
        // Daily with no events shouldn't emit `events: []` — keep the
        // YAML clean so vault files don't grow noise on roundtrip.
        let d = sample_daily();
        let s = serialize_daily(&d).unwrap();
        assert!(!s.contains("events:"), "got: {s}");
    }

    #[test]
    fn person_roundtrip_equality() {
        let p = sample_person();
        let serialized = serialize_person(&p).unwrap();
        let parsed = parse_person(&serialized).unwrap();
        assert_eq!(p, parsed);
    }

    #[test]
    fn person_handles_missing_avatar() {
        let raw = "---\ntype: person\nid: jane\nname: Jane Doe\ninitials: JD\nrole: Designer\ncompany: Acme\nemail: jane@acme.com\nspace: woodshed\ncolor: purple\n---\n\nNotes about Jane.";
        let parsed = parse_person(raw).unwrap();
        assert_eq!(parsed.id, "jane");
        assert_eq!(parsed.avatar, None);
        assert_eq!(parsed.body, "Notes about Jane.");
    }

    #[test]
    fn person_malformed_errors() {
        assert!(parse_person("no frontmatter").is_err());
        let bad = "---\ntype: task\nid: x\nname: y\ninitials: y\nrole: y\ncompany: y\nemail: y\nspace: y\ncolor: y\n---\n";
        assert!(parse_person(bad).is_err());
    }

    #[test]
    fn person_tolerates_missing_optional_fields() {
        // Users add people they only know the name + email of (or just the
        // name). role/company/initials/email all default to empty so the
        // file still loads. Required identity: id, name, area. The legacy
        // `color:` field is tolerated as an unknown — serde drops it on
        // parse, the next write removes it from the file.
        let raw = "---\ntype: person\nid: cameron-patel\nname: Cameron Patel\nemail: cameron-patel@acme.com\narea: acme\ncolor: amber\n---\n";
        let parsed = parse_person(raw).unwrap();
        assert_eq!(parsed.id, "cameron-patel");
        assert_eq!(parsed.name, "Cameron Patel");
        assert_eq!(parsed.role, "");
        assert_eq!(parsed.company, "");
        assert_eq!(parsed.initials, "");
    }

    #[test]
    fn person_skips_empty_user_fields_on_write() {
        // Wikilink creation (`[[Joe]]`) seeds role/company/email as empty
        // strings. The on-disk file should stay clean — no `role: ''` /
        // `company: ''` noise — so the YAML reads naturally for a person
        // we only know by name.
        let p = Person {
            id: "joe".to_string(),
            name: "Joe".to_string(),
            initials: String::new(),
            role: String::new(),
            company: String::new(),
            email: String::new(),
            relationship: String::new(),
            area: Some("personal".to_string()),
            avatar: None,
            created: None,
            favorite: false,
            body: String::new(),
        };
        let serialized = serialize_person(&p).unwrap();
        assert!(!serialized.contains("role:"), "got: {serialized}");
        assert!(!serialized.contains("company:"), "got: {serialized}");
        assert!(!serialized.contains("email:"), "got: {serialized}");
        assert!(!serialized.contains("initials:"), "got: {serialized}");
        assert!(!serialized.contains("relationship:"), "got: {serialized}");
        // Roundtrip back to the same Person (empty strings preserved).
        let parsed = parse_person(&serialized).unwrap();
        assert_eq!(parsed, p);
    }

    #[test]
    fn note_roundtrip_equality() {
        let n = sample_note();
        let serialized = serialize_note(&n).unwrap();
        let parsed = parse_note(&serialized).unwrap();
        assert_eq!(n, parsed);
    }

    #[test]
    fn favorite_roundtrips_and_is_omitted_when_false() {
        // Unstarred records keep their frontmatter free of `favorite: false`.
        let note = sample_note();
        let serialized = serialize_note(&note).unwrap();
        assert!(!serialized.contains("favorite:"), "got: {serialized}");

        let starred = Note {
            favorite: true,
            ..sample_note()
        };
        let serialized = serialize_note(&starred).unwrap();
        assert!(serialized.contains("favorite: true"), "got: {serialized}");
        assert_eq!(parse_note(&serialized).unwrap(), starred);

        let person = Person {
            favorite: true,
            ..sample_person()
        };
        let serialized = serialize_person(&person).unwrap();
        assert_eq!(parse_person(&serialized).unwrap(), person);

        let resource = Resource {
            favorite: true,
            ..sample_resource()
        };
        let serialized = serialize_resource(&resource).unwrap();
        assert_eq!(parse_resource(&serialized).unwrap(), resource);
    }

    #[test]
    fn note_handles_missing_tags() {
        let raw = "---\ntype: note\nid: x\ntitle: Untitled\nspace: woodshed\ncreated: 2026-04-25T09:00:00\n---\n\nbody text";
        let parsed = parse_note(raw).unwrap();
        assert!(parsed.tags.is_empty());
        assert_eq!(parsed.body, "body text");
    }

    #[test]
    fn note_malformed_errors() {
        assert!(parse_note("no frontmatter").is_err());
        let bad = "---\ntype: task\nid: x\ntitle: y\nspace: woodshed\ncreated: 2026-04-25\n---\n";
        assert!(parse_note(bad).is_err());
    }

    #[test]
    fn resource_roundtrip_equality() {
        let b = sample_resource();
        let serialized = serialize_resource(&b).unwrap();
        let parsed = parse_resource(&serialized).unwrap();
        assert_eq!(b, parsed);
    }

    #[test]
    fn resource_handles_missing_optionals() {
        let raw = "---\ntype: resource\nid: x\ntitle: Y\nurl: https://example.com\nsource: example.com\nspace: personal\nsaved: 2026-04-10T09:15:00\n---\n";
        let parsed = parse_resource(raw).unwrap();
        assert!(parsed.tags.is_empty());
        assert!(parsed.highlights.is_empty());
        assert!(parsed.agent_status.is_empty());
        assert_eq!(parsed.body, "");
    }

    #[test]
    fn resource_malformed_errors() {
        assert!(parse_resource("no frontmatter").is_err());
        let bad = "---\ntype: note\nid: x\ntitle: y\nurl: z\nsource: z\nspace: z\nsaved: z\n---\n";
        assert!(parse_resource(bad).is_err());
    }

    // Area is optional on notes/people (but still required on tasks/events).
    // Resources parse legacy `area:` values but drop them on write because a
    // saved source can support multiple areas. Parsing a file without `area:`
    // yields `None`; serializing a record with `None` omits the key entirely
    // so the YAML stays clean.

    #[test]
    fn note_without_area_roundtrips_with_none() {
        let raw =
            "---\ntype: note\nid: x\ntitle: Untitled\ncreated: 2026-04-25T09:00:00\n---\n\nbody";
        let parsed = parse_note(raw).unwrap();
        assert_eq!(parsed.area, None);
        let serialized = serialize_note(&parsed).unwrap();
        assert!(!serialized.contains("area:"), "got: {serialized}");
        let reparsed = parse_note(&serialized).unwrap();
        assert_eq!(reparsed, parsed);
    }

    #[test]
    fn person_without_area_roundtrips_with_none() {
        let raw = "---\ntype: person\nid: j\nname: J\n---\n";
        let parsed = parse_person(raw).unwrap();
        assert_eq!(parsed.area, None);
        let serialized = serialize_person(&parsed).unwrap();
        assert!(!serialized.contains("area:"), "got: {serialized}");
        let reparsed = parse_person(&serialized).unwrap();
        assert_eq!(reparsed, parsed);
    }

    #[test]
    fn resource_without_area_roundtrips_with_none() {
        let raw = "---\ntype: resource\nid: x\ntitle: Y\nurl: https://example.com\nsource: example.com\nsaved: 2026-04-10T09:15:00\n---\n";
        let parsed = parse_resource(raw).unwrap();
        assert_eq!(parsed.area, None);
        let serialized = serialize_resource(&parsed).unwrap();
        assert!(!serialized.contains("area:"), "got: {serialized}");
        let reparsed = parse_resource(&serialized).unwrap();
        assert_eq!(reparsed, parsed);
    }

    #[test]
    fn resource_legacy_area_is_dropped_on_write() {
        let raw = "---\ntype: resource\nid: x\ntitle: Y\nurl: https://example.com\nsource: example.com\narea: personal\nsaved: 2026-04-10T09:15:00\n---\n";
        let mut parsed = parse_resource(raw).unwrap();
        assert_eq!(parsed.area.as_deref(), Some("personal"));
        let serialized = serialize_resource(&parsed).unwrap();
        assert!(!serialized.contains("area:"), "got: {serialized}");
        parsed.area = None;
        let reparsed = parse_resource(&serialized).unwrap();
        assert_eq!(reparsed, parsed);
    }

    #[test]
    fn resource_capture_metadata_roundtrips() {
        let mut resource = sample_resource();
        resource.agent_status.insert(
            "motif".to_string(),
            ResourceAgentRun {
                last_run: Some("2026-05-16T10:33:00-07:00".to_string()),
                status: "proposed".to_string(),
                proposals: Some(4),
                session_id: Some("agent_01ABC".to_string()),
            },
        );

        let serialized = serialize_resource(&resource).unwrap();
        assert!(serialized.contains("captured_at:"), "got: {serialized}");
        assert!(serialized.contains("agent_status:"), "got: {serialized}");
        let parsed = parse_resource(&serialized).unwrap();
        assert_eq!(parsed, resource);
    }

    #[test]
    fn area_roundtrip_equality() {
        let a = sample_area();
        let serialized = serialize_area(&a).unwrap();
        let parsed = parse_area(&serialized).unwrap();
        assert_eq!(a, parsed);
    }

    #[test]
    fn area_handles_missing_created_and_body() {
        // Areas migrated from data/areas.json have no created timestamp and no body.
        let raw = "---\ntype: area\nid: woodshed\nname: Woodshed\ncolor: \"#378ADD\"\n---\n";
        let parsed = parse_area(raw).unwrap();
        assert_eq!(parsed.id, "woodshed");
        assert_eq!(parsed.name, "Woodshed");
        assert_eq!(parsed.color, "#378ADD");
        assert!(parsed.created.is_none());
        assert_eq!(parsed.body, "");
    }

    #[test]
    fn area_color_is_optional_legacy_metadata() {
        let raw = "---\ntype: area\nid: woodshed\nname: Woodshed\n---\n";
        let parsed = parse_area(raw).unwrap();
        assert_eq!(parsed.color, "");

        let serialized = serialize_area(&parsed).unwrap();
        assert!(!serialized.contains("color:"));
    }

    #[test]
    fn area_malformed_errors() {
        assert!(parse_area("no frontmatter").is_err());
        let wrong_type = "---\ntype: note\nid: x\nname: y\ncolor: \"#000\"\n---\n";
        assert!(parse_area(wrong_type).is_err());
    }

    #[test]
    fn task_frontmatter_key_order_is_stable() {
        // Two tasks with same data must serialize to byte-identical output.
        let t1 = sample_task();
        let t2 = sample_task();
        assert_eq!(serialize_task(&t1).unwrap(), serialize_task(&t2).unwrap());
    }

    fn sample_table() -> Table {
        let mut calculations = BTreeMap::new();
        calculations.insert("col_amount".to_string(), CalcFn::Sum);
        Table {
            id: "budget".to_string(),
            name: "Budget".to_string(),
            created: "2026-04-27T10:00:00".to_string(),
            favorite: false,
            columns: vec![
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
                    format: None,
                    precision: None,
                },
                Column {
                    id: "col_category".to_string(),
                    name: "Category".to_string(),
                    type_: ColumnType::Select,
                    options: vec![
                        SelectOption {
                            id: "opt_food".to_string(),
                            name: "Food".to_string(),
                            color: "blue".to_string(),
                        },
                        SelectOption {
                            id: "opt_rent".to_string(),
                            name: "Rent".to_string(),
                            color: "purple".to_string(),
                        },
                    ],
                    width: None,
                    format: None,
                    precision: None,
                },
            ],
            views: vec![View {
                id: "view_all".to_string(),
                name: "All Transactions".to_string(),
                type_: "table".to_string(),
                sorts: vec![ViewSort {
                    column: "col_amount".to_string(),
                    direction: SortDirection::Desc,
                }],
                filters: ViewFilters {
                    op: FilterCombineOp::And,
                    conditions: vec![],
                },
                hidden: vec![],
                calculations,
                group_by: None,
            }],
        }
    }

    fn sample_row() -> Row {
        let mut cells = BTreeMap::new();
        cells.insert(
            "col_item".to_string(),
            serde_yaml::Value::String("Coffee".to_string()),
        );
        cells.insert(
            "col_amount".to_string(),
            serde_yaml::Value::Number(serde_yaml::Number::from(4.5)),
        );
        cells.insert(
            "col_category".to_string(),
            serde_yaml::Value::String("opt_food".to_string()),
        );
        Row {
            id: "row_001".to_string(),
            table: "budget".to_string(),
            created: "2026-04-27T10:05:00".to_string(),
            cells,
            body: String::new(),
        }
    }

    #[test]
    fn table_schema_roundtrip_equality() {
        let t = sample_table();
        let serialized = serialize_table_schema(&t).unwrap();
        let parsed = parse_table_schema(&serialized).unwrap();
        assert_eq!(t, parsed);
    }

    #[test]
    fn table_schema_handles_minimal_input() {
        let raw = "---\ntype: table\nid: t1\nname: Untitled\ncreated: 2026-04-27T10:00:00\n---\n";
        let parsed = parse_table_schema(raw).unwrap();
        assert_eq!(parsed.id, "t1");
        assert!(parsed.columns.is_empty());
        assert!(parsed.views.is_empty());
        // Absent favorite frontmatter defaults to false.
        assert!(!parsed.favorite);
    }

    #[test]
    fn table_schema_favorite_serializes_only_when_true() {
        let mut t = sample_table();
        t.favorite = true;
        let serialized = serialize_table_schema(&t).unwrap();
        assert!(serialized.contains("favorite: true"));
        assert!(parse_table_schema(&serialized).unwrap().favorite);

        // False is omitted entirely, keeping unstarred files clean.
        t.favorite = false;
        let serialized = serialize_table_schema(&t).unwrap();
        assert!(!serialized.contains("favorite"));
    }

    #[test]
    fn table_schema_malformed_errors() {
        assert!(parse_table_schema("no frontmatter").is_err());
        let bad = "---\ntype: row\nid: x\nname: y\ncreated: z\n---\n";
        assert!(parse_table_schema(bad).is_err());
    }

    #[test]
    fn table_schema_promotes_legacy_single_sort_filter() {
        // Schema written by Phase 1 used `sort:` and `filter:` (singular).
        // Reading must still work and promote them into the new arrays.
        let raw = r#"---
type: table
id: legacy
name: Legacy
created: 2026-04-25T10:00:00
columns: []
views:
- id: v1
  name: All
  type: table
  sort:
    column: col_a
    direction: desc
  filter:
    column: col_b
    op: contains
    value: x
---
"#;
        let parsed = parse_table_schema(raw).unwrap();
        let v = &parsed.views[0];
        assert_eq!(v.sorts.len(), 1);
        assert_eq!(v.sorts[0].column, "col_a");
        assert_eq!(v.filters.op, FilterCombineOp::And);
        assert_eq!(v.filters.conditions.len(), 1);
        assert_eq!(v.filters.conditions[0].column, "col_b");
    }

    #[test]
    fn table_schema_supports_multi_select_and_board_view() {
        let mut t = sample_table();
        t.columns.push(Column {
            id: "col_tags".to_string(),
            name: "Tags".to_string(),
            type_: ColumnType::MultiSelect,
            options: vec![SelectOption {
                id: "opt_red".to_string(),
                name: "Red".to_string(),
                color: "coral".to_string(),
            }],
            width: None,
            format: None,
            precision: None,
        });
        t.views.push(View {
            id: "view_board".to_string(),
            name: "By Category".to_string(),
            type_: "board".to_string(),
            sorts: vec![],
            filters: ViewFilters {
                op: FilterCombineOp::Or,
                conditions: vec![ViewFilter {
                    column: "col_amount".to_string(),
                    op: "gt".to_string(),
                    value: Some(serde_yaml::Value::Number(serde_yaml::Number::from(0))),
                }],
            },
            hidden: vec![],
            calculations: BTreeMap::new(),
            group_by: Some("col_category".to_string()),
        });
        let s = serialize_table_schema(&t).unwrap();
        let parsed = parse_table_schema(&s).unwrap();
        assert_eq!(parsed, t);
    }

    #[test]
    fn row_roundtrip_equality() {
        let r = sample_row();
        let serialized = serialize_row(&r).unwrap();
        let parsed = parse_row(&serialized).unwrap();
        assert_eq!(r, parsed);
    }

    #[test]
    fn row_handles_empty_cells() {
        let raw = "---\ntype: row\nid: r1\ntable: t1\ncreated: 2026-04-27T10:05:00\n---\n";
        let parsed = parse_row(raw).unwrap();
        assert!(parsed.cells.is_empty());
        assert_eq!(parsed.body, "");
    }

    #[test]
    fn row_preserves_heterogeneous_cell_types() {
        let raw = "---\ntype: row\nid: r1\ntable: t1\ncreated: 2026-04-27T10:05:00\ncells:\n  col_text: hello\n  col_num: 42.5\n  col_bool: true\n  col_date: 2026-04-27\n---\n";
        let parsed = parse_row(raw).unwrap();
        assert_eq!(
            parsed.cells.get("col_text"),
            Some(&serde_yaml::Value::String("hello".to_string()))
        );
        assert!(parsed.cells.get("col_bool") == Some(&serde_yaml::Value::Bool(true)));
        assert_eq!(parsed.cells.len(), 4);
    }

    #[test]
    fn row_malformed_errors() {
        assert!(parse_row("no frontmatter").is_err());
        let bad = "---\ntype: table\nid: x\ntable: y\ncreated: z\n---\n";
        assert!(parse_row(bad).is_err());
    }
}
