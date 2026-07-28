# Changelog

All notable changes to Woodshed will be documented here.

## Unreleased

- Moved Gmail App Passwords and custom Hermes bearer keys to a prompt-free,
  owner-only local credential broker; existing Keychain entries migrate once.
- Added zero-paste authentication for loopback Hermes endpoints by discovering
  the key from the local profile that owns the configured API port.
- Hardened filesystem, network, credential, HTML rendering, dependency, and
  release boundaries in preparation for open-source distribution.

## 0.1.0

- Initial development release.
