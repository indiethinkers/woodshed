# Security policy

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** button in the Security tab of
`indiethinkers/woodshed`. This creates a private security advisory visible only to
the reporter and repository maintainers.

Do not open a public issue, discussion, or pull request for an undisclosed
vulnerability. Include the affected version or commit, impact, reproduction
steps, and any suggested remediation. Do not include real vault data or live
credentials; use synthetic fixtures.

Maintainers will acknowledge a report as soon as practical, validate it,
coordinate a fix and disclosure with the reporter, and credit the reporter if
requested. No bounty program is currently offered.

## Supported versions

Until the first stable release, security fixes are made on the latest `main`
branch and the newest published prerelease. Older development builds are not
supported; users should update and rotate any credential that may have been
exposed.

## Scope

High-priority reports include:

- vault path traversal, symlink escape, or unintended file access;
- command injection or webview-to-shell/filesystem privilege escalation;
- credential disclosure, loose file permissions, or persistence outside the
  documented app-data broker and OS credential-store boundaries;
- remote-content script execution or email HTML sandbox escape;
- SSRF, redirect rebinding, or unbounded network-resource consumption;
- unintended transmission of vault, mail, or calendar data;
- unsafe Gmail operations caused by attacker-controlled message identifiers.

The local user already has access to their own vault and application data. A
report should cross a documented trust boundary or produce an effect beyond
what the local user explicitly requested.
