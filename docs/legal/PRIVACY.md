# Woodshed privacy notice

**Effective and last updated:** July 26, 2026

This notice describes the behavior of the open-source Woodshed desktop
application in this repository. A third party that distributes a modified
build is responsible for documenting any behavior it adds or changes.

## Plain-English summary

Woodshed is local-first. It has no Woodshed account, analytics, advertising,
crash-reporting service, or Woodshed-operated backend. Your vault and local
caches stay on your computer. Data leaves the device only when you configure
and explicitly invoke an integration.

## Data stored on your device

- The selected vault contains Markdown records, synced mail, and attachments.
- The application-data directory contains non-secret preferences, a rebuildable
  SQLite search index, a rebuildable iCal event cache, and rotating local logs.
- Gmail App Passwords, Google Calendar secret iCal URLs, Hermes API keys, and
  Deepgram keys are stored in the operating-system credential store. Legacy
  plaintext configuration values are migrated there and scrubbed on first use.
- Development builds may read explicitly configured values from `.env.local`.

The app does not encrypt vault files or synced mail. Use operating-system disk
encryption and a backup strategy appropriate for the sensitivity of your data.

## Direct integrations

Woodshed communicates directly with the following services only when configured
and invoked:

- **Gmail:** IMAP reads inbox content and synchronizes read/archive state; SMTP
  sends mail and replies. Synced messages are written to the local vault.
- **Google Calendar or another iCal host:** an explicit Sync downloads the
  configured read-only calendar feed and writes a derived local cache.
- **Resource capture:** saving a URL downloads that public page and, for
  supported providers, an oEmbed response. Public fetches reject private/local
  destinations and enforce redirect, timeout, size, and concurrency limits.
- **Remote email images:** images are removed from sender HTML by default. They
  are requested only after you choose **Load remote images**, through the same
  bounded public-network policy. Loading an image can reveal your IP address and
  time of access to the image host.
- **Hermes-compatible agent endpoint:** an explicit agent or Sweep command sends
  the selected instruction and relevant vault or email content directly to the
  endpoint you configured. Opening Sweep does not transmit content. Proposed
  record creation and mail archive actions require confirmation.
- **Deepgram:** dictation sends the microphone clip for transcription; voice
  playback sends reply text for speech synthesis. Nothing is sent until you
  invoke a voice feature.

These providers receive requests directly from your device and handle them
under their own terms. Woodshed does not proxy or retain a server-side copy.

## Logs

Diagnostics are written locally to `woodshed.log`, capped at 1 MiB with one
rotated generation. Logs contain command names and error details and may reveal
local paths, account identifiers, or provider error text. Secret URL query
strings and credentials are redacted from network logs. Review logs before
sharing them publicly.

## Retention and deletion

Vault records persist until you remove them. In-app record deletion moves files
to `.woodshed/trash/` inside the vault so they can be recovered or permanently
removed by you. Uninstalling the app does not delete the vault.

Removing an account deletes its stored credential when the operating-system
credential store allows it. You can also revoke Gmail App Passwords in your
Google Account. Deleting the app-data directory removes preferences, indexes,
caches, and logs; it does not remove credentials managed separately by the OS.

Because Woodshed operates no data backend, maintainers do not hold a remote copy
of your data to access, export, or delete.

## Changes and contact

Material behavior changes should update this notice in the same pull request.
For non-sensitive questions, open an issue in `indiethinkers/woodshed`. Report
security or privacy vulnerabilities privately using the process in
[SECURITY.md](../../SECURITY.md). Do not include personal vault data or live
credentials in a report.
