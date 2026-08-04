# Woodshed privacy notice

**Effective:** July 26, 2026 · **Last updated:** August 4, 2026

This notice describes the behavior of the open-source Woodshed desktop
application in this repository. A third party that distributes a modified
build is responsible for documenting any behavior it adds or changes.

## Plain-English summary

Woodshed is local-first. It has no Woodshed account, analytics, advertising,
crash-reporting service, or Woodshed-operated backend. Your vault and local
caches stay on your computer. Configured integrations make direct network
requests when you invoke them or while foreground mail/calendar polling is
enabled. Displaying a YouTube embed loads YouTube's standard player, and opening
an HTML email loads its remote images by default through Woodshed's bounded
cache.

## Data stored on your device

- The selected vault contains Markdown records, synced mail, and attachments.
  If you adopt an existing Markdown folder, those files stay where they are and
  appear in Notebook; new Woodshed-managed records live in a visible
  `woodshed/` child of that folder. Recoverable revisions and trash remain under
  the vault's `.woodshed/` directory.
- The application-data directory contains non-secret preferences, a rebuildable
  SQLite search index, a rebuildable iCal event cache, durable Agent run records,
  and rotating local logs. Agent run records include submitted message context,
  progress events, final responses, and errors so a request can survive page
  navigation or reload. A selected image is temporarily included in its queued
  run as a base64 data URL, then removed from that record when the worker copies
  it for dispatch or the run otherwise becomes terminal. When the configured
  provider reports token usage, Woodshed stores it as a progress event in the
  corresponding run record.
- Gmail App Passwords and custom Hermes bearer keys are stored in an owner-only
  (`0600`) plaintext file in the application-data directory, protected by
  operating-system account isolation and disk encryption. The standard local
  connection reads the active Hermes profile's key from its bounded `.env` or
  `config.yaml`; an explicit custom loopback endpoint reads the profile owning
  that port. Neither key is copied into Woodshed.
  Google Calendar secret iCal URLs are stored in the operating-system credential
  store. Legacy plaintext configuration values are migrated and scrubbed on
  first use.
- Upgraded installations delete the obsolete transcription credential and
  preference on the next launch.
- Development builds may read explicitly configured values from `.env.local`.

The app does not encrypt vault files or synced mail. Use operating-system disk
encryption and a backup strategy appropriate for the sensitivity of your data.

## Direct integrations

Woodshed communicates directly with the following services. Most network
actions require a configured integration and an explicit command. Mail and
calendar refresh also runs every five minutes by default while Woodshed is
running; Settings can change the interval or select Manual. YouTube embeds and
remote email images are the
other exceptions described below.

- **Gmail:** IMAP reads inbox and sent content and synchronizes read/archive
  state; SMTP sends mail, replies, and user-selected attachments. Synced
  messages and attachment copies are written to the local vault. If automatic
  refresh is enabled, IMAP polling runs at the selected interval while
  Woodshed is running; the navigation rail indicates only whether unread mail
  exists, without showing sender, subject, account, or message content.
  A snooze you create also authorizes Woodshed to restore that message through
  IMAP when its locally stored deadline becomes due while the app is running.
- **Google Calendar or another iCal host:** an explicit Sync—or the optional
  foreground refresh interval—downloads the configured read-only calendar feed
  and writes a derived local cache.
- **Resource capture:** saving a URL downloads that public page and, for
  supported providers, an oEmbed response. If an X oEmbed response contains an
  incomplete long-form preview, Woodshed sends the public numeric post id to
  `api.fxtwitter.com` to retrieve its complete text. FxTwitter receives your IP
  address, time of access, and that post id. Public fetches reject private/local
  destinations and enforce redirect, timeout, size, and concurrency limits.
- **YouTube embeds:** displaying a YouTube embed loads the standard
  `youtube.com` player. YouTube receives your IP address, time of access, the
  full Woodshed page URL, and any identifiers or cookies its standard player
  uses. Player content and player requests are handled by YouTube under its own
  terms.
- **Remote email images:** opening an HTML email requests its remote images by
  default through Woodshed's bounded public-network cache. Sender HTML never
  fetches the URLs directly. Loading an image can reveal your IP address and
  time of access to the image host.
- **Hermes-compatible agent endpoint:** Woodshed's standard local connection
  follows the active Hermes profile, including its configured API port and
  advertised gateway model. Switch profiles or change the model or provider in
  Hermes; Woodshed displays connection status without managing them. An
  explicit agent command sends the selected instruction and relevant vault or
  email content directly to that endpoint, or to an explicitly configured
  custom endpoint. Proposed record creation and mail archive actions require
  confirmation. User-selected PDF and text attachments are converted to bounded
  text locally. Selected PNG, JPEG, GIF, and WebP images are sent as bounded
  multimodal image data after local validation. The endpoint receives that text
  or those image pixels, not the original file path.
These providers receive requests directly from your device and handle them
under their own terms. Woodshed does not proxy or retain a server-side copy.

## Logs

Diagnostics are written locally to `woodshed.log`, capped at 1 MiB with one
rotated generation. Logs contain command names and error details and may reveal
local paths, account identifiers, or provider error text. Secret URL query
strings and credentials are redacted from network logs. Review logs before
sharing them publicly.

## Retention and deletion

Vault records persist until you remove them. Agent run records currently persist
in the application-data directory until that directory is removed, except raw
image payloads, which are released when dispatch begins or the run otherwise
becomes terminal. Retired
Sweep-card Markdown created by older builds remains in the vault's `sweep/`
directory until you inspect, move, or delete it; current builds do not use or
remove those files. In-app record deletion moves files to `.woodshed/trash/`
inside the vault so they can be recovered or permanently removed by you.
Uninstalling the app does not delete the vault.

Removing an account deletes its stored credential, including any legacy entry
the operating-system credential store still holds. You can also revoke Gmail
App Passwords in your Google Account. Deleting the app-data directory removes
preferences, indexes, caches, logs, and the owner-only credential file; it does
not remove credentials managed separately by the OS.

Because Woodshed operates no data backend, maintainers do not hold a remote copy
of your data to access, export, or delete.

## Changes and contact

Material behavior changes should update this notice in the same pull request.
For non-sensitive questions, open an issue in `indiethinkers/woodshed`. Report
security or privacy vulnerabilities privately using the process in
[SECURITY.md](../../SECURITY.md). Do not include personal vault data or live
credentials in a report.
