# Woodshed security model

## Assets

- vault files and attachments;
- locally cached email and calendar data;
- Gmail App Passwords, iCal secret URLs, Hermes keys, and Deepgram keys;
- the authority to send/archive mail, create records, and contact integrations.

## Trust boundaries

The React webview is less trusted than the Rust backend. It receives no generic
shell or filesystem capability. Narrow Tauri commands resolve configured paths
in Rust, validate record identifiers, refuse symlinked vault collections and
records, and open only backend-resolved attachments or URLs with approved
schemes. The asset protocol is scoped at runtime to the selected vault's
attachments directory only after watcher startup succeeds. Watcher startup is
serialized and process-idempotent, so attachment scopes cannot accumulate
across concurrent or failed startup attempts.

Vault Markdown, YAML, email HTML, iCal feeds, fetched web pages, and model output
are untrusted. HTML is sanitized before rendering; email content renders in an
opaque sandboxed frame; sender styles, active elements, forms, and SVG are
removed. Remote image URLs are rewritten to Woodshed's bounded cache and load
when the user opens a message; sender HTML never fetches them directly. The main
webview also blocks arbitrary HTTP(S) image loads; YouTube embeds make no
request until the user presses Play.

## Storage

The vault is primary data. Writes are atomic when the filesystem supports it.
Deletion moves records to `.woodshed/trash/<operation-id>/` for recovery.
Vault readers open regular files with no-follow semantics and enforce limits on
the open file descriptor, closing the usual symlink-check/read race. Atomic
writes use randomized, exclusively-created temporary files.
Before overwriting a record, Woodshed retains up to 50 no-follow revision
snapshots for that record; the oldest snapshots are pruned after a successful
new snapshot so autosave history cannot grow without bound.

`index.db` and `gcal-cache/` are derived and rebuildable. The SQLite index stores
FTS content plus normalized tag and wikilink edges so reads do not repeatedly
parse the entire vault. Tag views read only the indexed matching paths. Inbox
list transport is backed by paginated SQLite summary rows; it neither scans the
inbox nor crosses IPC with the whole corpus. Message bodies and HTML load only
for an opened message, and thread lookup selects bounded indexed paths before
opening matching records.

Secrets live in the operating-system credential store. `config.json` stores
only non-secret account metadata. Older plaintext fields are accepted solely
for one-time migration and are skipped during serialization.

## Network policy

Public resource, calendar, oEmbed, and remote-image fetches:

- accept only HTTP(S), with HTTPS required for secret iCal URLs;
- reject URL credentials, local hostnames, and non-public IP ranges;
- resolve DNS before connecting, reject any non-public answer, pin the
  validated address, and revalidate every redirect;
- enforce connect/overall timeouts, redirect limits, response-size limits, and
  a shared eight-request workload concurrency limit;
- redact credentials, query strings, and fragments from logs.

Resource budgets are enforced at ingress: text records and rendered email
bodies are capped at 16 MiB, raw IMAP messages and calendar feed downloads at
25 MiB, image uploads at 20 MiB with signature and dimension validation, and
remote email images at 10 MiB each with a 256 MiB cache quota. Calendar caches
are capped at 100,000 retained events and 128 MiB per account. Both uploaded
and remote raster images enforce decoded-dimension and total-pixel limits.
Agent request,
response, attachment, and stream budgets are enforced independently.

The Hermes endpoint is user-configured and may intentionally be local, so it is
not subject to the public-host SSRF rule. Its URL syntax, requests, response
sizes, stream sizes, and timeouts are still bounded. Deepgram uses fixed HTTPS
endpoints with bounded input and output.

## Explicit authority

External writes are initiated by the user. Agent-generated action plans display
the concrete operation fields—including resource URLs and task scheduling—and
require confirmation before creating records or archiving mail. Confirmation
text is normalized and bounded before display, and execution uses those exact
confirmed values. Opening Sweep alone sends nothing. Voice data is sent only
after the user invokes dictation or voice mode.

## Residual assumptions

- The operating system, current user account, credential store, and signed app
  distribution are trusted.
- Vault Markdown and synced mail remain plaintext by design; disk encryption and
  backups are the user's responsibility.
- A user-configured integration can retain content it receives under its own
  terms. Woodshed cannot enforce deletion at that endpoint.
- The legacy synchronous IMAP client remains a maintenance dependency and
  emits a Rust future-compatibility warning. RustSec currently reports no known
  vulnerabilities, but does report allowed maintenance/soundness warnings in
  transitive IMAP parser dependencies, HTML parsing/build dependencies, and
  Linux-only GTK dependencies. A future IMAP replacement and parser refresh
  should remove the relevant warnings; CI continues to audit every lockfile.
