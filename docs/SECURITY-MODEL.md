# Woodshed security model

## Assets

- vault files and attachments;
- locally cached email and calendar data;
- Gmail App Passwords, iCal secret URLs, and Hermes keys;
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
opaque sandboxed frame; active elements, forms, SVG, and sender stylesheets are
removed. Inline `style` attributes are kept so a message renders as its sender
laid it out — including the hidden preheader every sender ships — minus any
declaration that could start a network request or reach a legacy scripting hook.
The rendered body is additionally served under `default-src 'none'`, so no
sender markup or CSS can reach the network even if sanitization is wrong. Remote
image URLs are rewritten to Woodshed's bounded cache and load when the user
opens a message; sender HTML never fetches them directly. The main webview also
blocks arbitrary HTTP(S) image loads. YouTube embeds are the exception: the
webview CSP permits YouTube-owned frame origins and lazily loads YouTube's
standard player when an embed is displayed. The frame uses `unsafe-url` and
also supplies the current page URL as `widget_referrer` so YouTube can identify
the player inside a native webview. YouTube controls the frame document and its
subrequests; they do not pass through Woodshed's bounded Rust fetcher.

## Storage

The vault is primary data. Writes are atomic when the filesystem supports it.
Deletion moves records to `.woodshed/trash/<operation-id>/` for recovery.
Vault readers open regular files with no-follow semantics and enforce limits on
the open file descriptor, closing the usual symlink-check/read race. Atomic
writes use randomized, exclusively-created temporary files.
Before overwriting a record—including Markdown opened from an adopted folder—
Woodshed retains up to 50 no-follow revision snapshots for that record; the
oldest snapshots are pruned after a successful new snapshot so autosave history
cannot grow without bound. Adopting a Markdown folder does not move its existing
files. Woodshed's typed records live in a visible `woodshed/` child, while the
portable `.woodshed/imported-layout` marker selects that storage layout.

`index.db` and `gcal-cache/` are derived and rebuildable. The SQLite index stores
FTS content plus normalized tag and wikilink edges so reads do not repeatedly
parse the entire vault. Tag views read only the indexed matching paths. Mail
folder list transport is backed by paginated SQLite summary rows; it neither
scans the mail folder nor crosses IPC with the whole corpus. Message bodies and HTML load
only for an opened message, and thread lookup selects bounded indexed paths
before opening matching records.

Agent turns are process-owned background jobs recorded as bounded JSON files in
`agent-runs/` under the application-data directory. A run stores its stable id,
conversation id, submitted message context, streamed progress, terminal result,
and error state. The webview can poll or cancel through narrow commands but does
not own the network request. Completion writes one deterministic assistant
message id to the vault transcript, and repeat finalization checks that id before
writing. The global active-run query considers only process-owned run ids and
reads at most 20 run records per poll. After an app restart, a queued or running
record with no process-local owner becomes a recoverable failure when it is next
read.

Gmail App Passwords and custom Hermes bearer keys live in an atomic, owner-only
(`0600`) `secrets.json` file under the application-data directory. It is
plaintext by design and relies on operating-system account isolation and
full-disk encryption; it is never included in logs, diagnostics, exports, or the
vault. The standard local Agent connection reads the default Hermes profile key
from a bounded, regular, non-symlink file; custom loopback endpoints resolve the
profile that owns their configured port. Local keys are used only for loopback
endpoints. Secret iCal URLs remain in the
operating-system credential store. `config.json` stores only non-secret account
metadata. Older plaintext fields are accepted solely for one-time migration and
are skipped during serialization; legacy Gmail and Hermes Keychain entries are
imported only after a verified write to `secrets.json`.

## Network policy

Mail and calendar refreshes run on explicit refresh or the foreground polling
interval selected in Settings. Five minutes is the default; Manual disables it.
Scheduled refresh stops when Woodshed exits, catches up when the running app
regains focus, and uses the same bounded Gmail and iCal clients as manual
refresh. The navigation rail exposes only whether unread mail exists; it does
not display sender, subject, account, or message contents.

Email snooze restoration is separate from refresh polling: after the user
chooses a deadline, Woodshed checks local archived records every minute and on
focus while running. Only a due record triggers the bounded IMAP label update
that returns it to INBOX; this still runs when refresh is set to Manual.

Agent PDF and text attachments are decoded from the user-selected in-memory data
URL and converted to bounded text inside the Tauri command boundary. PDF bytes
cross only stdin into a short-lived Woodshed PDFKit helper process; stdout is
bounded, and the parent kills and reaps the helper on timeout or protocol error.
The request sent to Hermes contains the extracted text and a sanitized label,
not the original filesystem path. Unsupported, malformed, image-only, and
oversized attachments fail before an agent run is created.

Public resource, calendar, oEmbed, and remote-image fetches:

- accept only HTTP(S), with HTTPS required for secret iCal URLs;
- reject URL credentials, local hostnames, and non-public IP ranges;
- resolve DNS before connecting, reject any non-public answer, pin the
  validated address, and revalidate every redirect;
- enforce connect/overall timeouts, redirect limits, response-size limits, and
  a shared eight-request workload concurrency limit;
- redact credentials, query strings, and fragments from logs.

When a user captures or explicitly refreshes an X URL whose oEmbed response
marks the post text as incomplete, Woodshed sends only the public numeric post
id to `api.fxtwitter.com` to retrieve the complete long-form text. This request
uses the same public-host validation, DNS pinning, redirect, timeout, response
size, and concurrency limits as other resource-capture fetches. A failure keeps
the X oEmbed teaser and does not block capture.

YouTube player frames are the documented exception to these Rust fetch limits.
The main webview CSP permits YouTube-owned frame origins. The iframe sends the
full Woodshed page URL as both referrer data and an explicit `widget_referrer`.
Network activity inside the frame is controlled by YouTube.

Resource budgets are enforced at ingress: text records and rendered email
bodies are capped at 16 MiB, raw IMAP messages and calendar feed downloads at
25 MiB, image uploads at 20 MiB with signature and dimension validation, and
remote email images at 10 MiB each with a 256 MiB cache quota. Calendar caches
are capped at 100,000 retained events and 128 MiB per account. Both uploaded
and remote raster images enforce decoded-dimension and total-pixel limits.
Outgoing mail accepts at most 10 attachments, 10 MiB per attachment and 20 MiB
in total; base64, filenames, and content types are validated again inside the
bounded send command. Agent request, response, attachment, and stream budgets
are enforced independently.

The standard Hermes endpoint is the default local profile. Explicit custom
endpoints may also intentionally be local, so Hermes endpoints are not subject
to the public-host SSRF rule. Their URL syntax, requests, response sizes, stream
sizes, and timeouts are still bounded.

## Explicit authority

External writes are initiated by the user. Agent-proposed mutations display the
concrete operation fields—including resource URLs and task scheduling—and require
confirmation before creating records or archiving mail. Confirmation text is
normalized and bounded before display, and execution uses those exact confirmed
values.

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
