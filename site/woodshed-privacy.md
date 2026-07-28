# Woodshed Privacy Policy

**Effective:** 2026-05-08 · **Last updated:** 2026-07-28
**Contact:** daniel@indiethinkers.com

> **Plain-English summary.** Woodshed is a local-first desktop application. We do not operate a server that receives or stores your data. Your vault, mail, calendar cache, index, preferences, and logs stay on your computer. Data leaves the device only when you configure and explicitly invoke Gmail, an iCal feed, resource capture, or a Hermes-compatible agent endpoint.

## 1. Who we are

"Woodshed," "we," "us," and "our" refer to **Daniel Hunter**, an individual operating in California, USA.

## 2. Data stored on your device

- **Vault folder path and profile.** Stored locally so the app can reopen your vault and present your chosen identity.
- **Markdown files and attachments.** Notes, tasks, events, people, resources, tables, mail, and attachments are stored in the vault you choose.
- **Derived data.** The app-data directory contains a rebuildable SQLite search index, a rebuildable iCal cache, preferences, and rotating local diagnostics logs.
- **Credentials.** Gmail App Passwords, Google Calendar secret iCal URLs, and Hermes API keys are stored in the operating system's credential store. Legacy plaintext configuration values are migrated and scrubbed on first use. Development builds may read values you place in `.env.local`.

Vault files and synced mail are not encrypted by Woodshed. Use operating-system disk encryption and backups appropriate for your data.

## 3. Direct integrations

- **Gmail (IMAP and SMTP).** Woodshed reads the inbox, synchronizes read/archive state, and sends messages or replies that you initiate. Gmail data is written to the local vault. Woodshed does not use Gmail OAuth scopes.
- **Google Calendar or another iCal host.** An explicit Sync downloads the configured read-only iCal feed. Woodshed does not currently request Calendar OAuth access or write to Google Calendar.
- **Resource capture.** Saving a URL downloads that public page and, for supported providers, an oEmbed response. Public fetches reject private/local destinations and enforce redirect, timeout, size, and concurrency limits.
- **Remote email images.** Sender images are removed by default. They are requested only after you choose **Load remote images**. Loading an image can reveal your IP address and time of access to its host.
- **Hermes-compatible agent endpoint.** An explicit agent or Sweep action sends the selected instruction and relevant vault or email content directly to the endpoint you configured. Opening Sweep alone sends nothing. Proposed record creation and mail archive actions require confirmation.
These providers receive requests directly from your device and process them under their own terms. Woodshed does not proxy or retain a server-side copy.

## 4. Information we do not collect

- Woodshed has no user account system or operated data backend.
- We do not collect device identifiers, IP addresses, analytics events, crash reports, advertising data, cookies, fingerprints, or telemetry.
- We do not receive or use your data to train models, sell it, or build advertising profiles.

## 5. Logs

Diagnostics remain on the device in a file capped at 1 MiB with one rotated generation. Logs can contain local paths, account identifiers, or provider error text. Secret URL query strings and credentials are redacted from network logs. Review logs before sharing them.

## 6. Retention and deletion

Data persists on your device until you remove it. In-app deletion moves records to `.woodshed/trash/` inside the vault for recovery. Uninstalling Woodshed does not delete the vault.

Removing an account deletes its credential when the OS credential store allows it. You can revoke a Gmail App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Reset a leaked Google Calendar secret URL in Google Calendar settings. Delete the app-data directory to remove preferences, indexes, caches, and logs; remove Woodshed credential entries separately through the OS.

Because we operate no data backend, we do not hold a remote copy to access, export, or delete.

## 7. Children

Woodshed is not directed at children under 13 or the relevant age in your jurisdiction. We do not knowingly collect data from children.

## 8. Changes and contact

We will update this page and its date when application behavior materially changes. Privacy questions and general contact: **daniel@indiethinkers.com**. Do not email live credentials or private vault content.
