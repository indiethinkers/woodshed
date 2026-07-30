# Woodshed privacy notice

**Effective:** July 26, 2026 · **Last updated:** July 30, 2026

This notice describes the behavior of the open-source Woodshed desktop
application in this repository. A third party that distributes a modified
build is responsible for documenting any behavior it adds or changes.

## Plain-English summary

Woodshed is local-first. It has no Woodshed account, analytics, advertising,
crash-reporting service, or Woodshed-operated backend. Your vault and local
caches stay on your computer. Configured integrations make direct network
requests when you invoke them. Displaying a YouTube embed loads YouTube's
privacy-enhanced player, and opening an HTML email loads its remote images by
default through Woodshed's bounded cache.

## Data stored on your device

- The selected vault contains Markdown records, synced mail, and attachments.
- The application-data directory contains non-secret preferences, a rebuildable
  SQLite search index, a rebuildable iCal event cache, and rotating local logs.
- Gmail App Passwords and custom Hermes bearer keys are stored in an owner-only
  (`0600`) plaintext file in the application-data directory, protected by
  operating-system account isolation and disk encryption. Local Hermes keys are
  read from the matching Hermes profile without being copied into Woodshed.
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
actions require a configured integration and an explicit command. YouTube
embeds and remote email images are the exceptions described below.

- **Gmail:** IMAP reads inbox content and synchronizes read/archive state; SMTP
  sends mail, replies, and user-selected attachments. Synced messages and
  attachment copies are written to the local vault.
- **Google Calendar or another iCal host:** an explicit Sync downloads the
  configured read-only calendar feed and writes a derived local cache.
- **Resource capture:** saving a URL downloads that public page and, for
  supported providers, an oEmbed response. Public fetches reject private/local
  destinations and enforce redirect, timeout, size, and concurrency limits.
- **YouTube embeds:** displaying a YouTube embed loads the privacy-enhanced
  `youtube-nocookie.com` player. YouTube receives your IP address and time of
  access when the embed is displayed, plus the Woodshed app origin required to
  identify the player client. Vault routes are not sent. Player content and
  player requests are handled by YouTube under its own terms.
- **Remote email images:** opening an HTML email requests its remote images by
  default through Woodshed's bounded public-network cache. Sender HTML never
  fetches the URLs directly. Loading an image can reveal your IP address and
  time of access to the image host.
- **Hermes-compatible agent endpoint:** an explicit agent or Sweep command sends
  the selected instruction and relevant vault or email content directly to the
  endpoint you configured. Opening Sweep does not transmit content. Proposed
  record creation and mail archive actions require confirmation.
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
