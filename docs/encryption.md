# Encryption and trust model

Notes encrypts private board data in the browser using the Web Crypto API. This
document describes the current implementation, including what it does **not**
protect. It is a design description, not a security audit or proof.

## Key hierarchy

```text
Passkey PRF output                    Random access-key seed
         │                                     │
         └────────── HKDF-SHA-256 ──────────────┘
                         │
                Account encryption key
                         │
             Encrypted sharing private key
                         │ RSA-OAEP unwrap
                 Per-board AES-256 key
                         │
           ┌─────────────┼─────────────────┐
           │             │                 │
     Board entities   Board name     Live presence
       AES-GCM        AES-GCM          AES-GCM
```

Note locking uses an additional hierarchy described below. In particular, the
account encryption key does not directly decrypt the note-lock private key.

## Authentication is separate from encryption

### Passkeys

WebAuthn handles registration and authentication, with discoverable credentials
and user verification. The client also requests a 32-byte output from the
WebAuthn PRF extension. HKDF-SHA-256 derives an AES-256-GCM account key from that
output, using the account identifier as a salt and a purpose-specific context.

The client serializes only the expected WebAuthn fields. PRF output is explicitly
excluded from `clientExtensionResults` and is not sent to the server. The server
stores the credential's public key and verifies assertions, origin, and RP ID.
PRF support depends on the complete browser/authenticator/provider combination;
support for ordinary passkey sign-in alone is not sufficient.

### Generated access keys

An access key is `notes_` followed by a base64url-encoded, cryptographically random
32-byte seed. It is generated locally, not chosen as a human password.
HKDF-SHA-256 derives separate values for the account identifier, authentication
token, account encryption key, and note-lock protection key using distinct
contexts. The original seed is not sent to the server.

The derived authentication token is sent over HTTPS. The server stores its
SHA-256 hash, not the seed or encryption key. That token is a bearer credential:
knowledge of it permits authentication, but it does not by itself derive the
account encryption key. Keep the original access key in a password manager.

Passkey and generated-key accounts are separate. Notes does not currently offer
email recovery, interchangeable sign-in methods for one account, or a recovery
key that can replace a lost passkey.

## Private board storage

Each board gets a fresh random 256-bit AES key. The browser encrypts notes,
layouts, groups, connections, and board metadata as separate entities using
AES-GCM with fresh 96-bit IVs and 128-bit authentication tags. Encryption contexts
bind ciphertext to its board/account scope, entity identifier, and revision.

The encrypted manifest contains a digest of the sorted entity IDs, revisions,
and ciphertext hashes. It detects missing or mixed entities relative to that
manifest. It is not an externally anchored history: replay of an entire older,
consistent snapshot by a malicious server is not independently prevented.

Only changed entities are re-encrypted and sent. Image entities are stored as
`.enc` files; SQLite stores their references and encoded sizes. Stored file sizes
include encryption and base64/JSON overhead. They count toward `BOARD_LIMIT_MB`,
which defaults to 200 decimal MB. The server checks the quota transactionally.
When a save fails, new files are removed; after a committed image deletion or
replacement, obsolete files are unlinked. Startup cleanup also removes orphaned
files left after interruptions.

A database backup alone is insufficient: retain the database and image directory
as one consistent backup. Filesystem allocation slack and the whole SQLite/WAL
file size are not assigned to an individual user's board quota.

## Invited collaborators

Each account has an RSA-OAEP 3072-bit sharing key pair using SHA-256. Its private
key is encrypted under the account encryption key. On invitation, the owner's
browser wraps the board key with the recipient's public key, binding the wrapped
value to both board and recipient. The server stores the wrapped key alongside
the membership record.

The server enforces owner, editor, and viewer roles on reads, writes, and live
messages. It receives minimal plaintext policy metadata so it can reject changes
to pinned or locked entities. Cursor positions, selections, and transient drag
coordinates are encrypted with the board key before relay. Anonymous public
visitors are not included in presence.

Recipient public keys are obtained from the server. There is no out-of-band
fingerprint verification or key-transparency system, so a malicious server could
substitute a recipient key during an invitation. A shared board key also means
that authorized members share cryptographic access; editor/viewer write
restrictions are enforced by the server, not by different encryption keys.

Removing a member stops further access through the server and live connection.
It does **not** rotate the board key or delete copies the former member has
already downloaded. Do not treat removal as retroactive cryptographic revocation.

## Locked notes

A note's contents are encrypted under a fresh random AES-256-GCM key. That key is
wrapped with a separate RSA-OAEP note-lock public key. The corresponding private
key is encrypted under a purpose-separated key derived from the original PRF
output or access-key seed. Unlocking requires a fresh verified passkey assertion
or re-entry of the original access key.

The application removes the cleartext content from its active board and relevant
caches when locking. The visible title, position, dimensions, and existing mention
relationships remain available to board members. Locked images are hidden along
with other locked content.

JavaScript garbage collection does not offer guaranteed secure erasure of every
previous string or browser-internal copy. Locking is not protection against a
compromised device, extension, debugger, or collaborator who already saw the note
while it was unlocked. It should not be described as guaranteed memory wiping.

## Sessions and local persistence

The server uses HttpOnly, SameSite=Strict session cookies, with Secure cookies on
HTTPS. Sessions expire after 12 hours; real activity in a visible tab refreshes
that window at most once per minute. Idle/background tabs do not keep a session
alive by themselves.

To survive a tab reload, the browser stores a non-extractable account CryptoKey
in IndexedDB and associates it with a sessionStorage marker for that tab. This
stores neither the original access-key seed nor PRF output. Logging out removes
that saved access. If browser storage is unavailable, session restoration may
not work.

Non-extractable means Web Crypto does not allow raw-key export. It does **not**
mean hostile code running in the same origin cannot use that key to decrypt data.
Protect the browser session and use HTTPS on a host you trust.

Camera position and zoom are stored separately in localStorage, scoped by account
and board (or public snapshot). They contain no note text or images, survive
sign-out for the next visit, and are not encrypted. Clearing browser site data
removes these local view preferences.

## Public snapshots

Publishing explicitly sends a plaintext snapshot to the server. The server stores
it as a separate `.public.json` file. The public URL contains a random access
token, not a decryption key. Anyone who possesses the link can view the snapshot.

Private board ciphertext remains separate. Later edits do not refresh the
snapshot automatically. Private key material and the contents of locked notes
are excluded; visible titles and permitted geometry remain. The snapshot counts
toward the same board quota. Disabling publication removes its file and invalidates
the server link, but cannot remove previously downloaded copies.

Deleting an image from a private board removes its private `.enc` file after a
successful save. If an earlier public snapshot contained that image, the snapshot
still contains its published copy until publication is disabled or replaced.

## What the server can see

The server necessarily sees account/credential identifiers, sharing public keys,
memberships and roles, board/entity identifiers, policy flags, revisions, stored
sizes, traffic timing, and connection/session metadata. Hosting infrastructure
may also observe IP addresses and request logs. Public snapshots are plaintext.
No email or password is requested, but this is pseudonymous access, not a claim
of network anonymity or metadata privacy.

## Deployment assumptions

Use HTTPS and a trusted application host. A compromised host can serve modified
JavaScript that reads data after unlocking; database-at-rest encryption does not
solve malicious-client delivery. Browser extensions and device compromise are
outside this protection model. The server can also withhold, delete, or replay
data, so keep independent backups.

Notes has not undergone an independent security audit. For reporting procedures,
see [SECURITY.md](../SECURITY.md).

### Implementation references

- [Passkey protocol](../apps/web/src/passkey.ts)
- [Access-key derivation](../apps/web/src/key-auth.ts)
- [Entity encryption and integrity manifest](../apps/web/src/entities.ts)
- [Sharing key envelopes](../apps/web/src/sharing-crypto.ts)
- [Note locking](../apps/web/src/note-lock.ts)
- [Session persistence](../apps/web/src/session.ts)
- [Server membership and quota enforcement](../apps/server/src/collaboration-store.ts)
- [File storage and cleanup](../apps/server/src/image-files.ts)
