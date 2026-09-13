# Security

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/wiolett-industries/notes/security/advisories/new)
before publishing details. If you cannot use that form, ask a maintainer for a
private reporting channel without including exploit details in a public issue.

Include the affected commit, a minimal reproduction using disposable accounts,
the expected and observed behavior, and the potential impact. Never include real
access keys, PRF output, session cookies, or another person's board contents.

## Current scope

Security fixes target the current `main` branch. No independently audited security
certification or support window is claimed. Read the
[encryption design and limitations](docs/encryption.md) before relying on Notes
for sensitive information.

Private board encryption, authenticated key derivation, role enforcement, public
snapshot sanitization, and file isolation are security boundaries. An explicitly
published snapshot is public plaintext by design. An unlocked browser session,
compromised client, or previously authorized recipient can retain information
they have already read.
