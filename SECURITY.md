# Security

Report vulnerabilities privately to the maintainers (set a contact address before publishing; GitHub private vulnerability reporting is recommended). Do not open public issues for security problems.

## What v0.1 protects
- Provider keys are read from environment variables named in the config; **config files containing secret-looking fields are rejected**.
- Gateway tokens are stored only as SHA-256 digests and compared in constant time. The gateway **refuses to start without keys** (opt-out only on loopback).
- Log lines and error strings pass through a redaction filter; tests assert prompts, completions and keys are absent from logs and client responses.
- `CredentialVault` (AES-256-GCM envelope encryption, per-record data keys, id-bound AAD, master-key rotation, 0600 files) is implemented and tested as a library but is **not yet wired into the gateway** (see STATUS).
- Requests are size-limited, rate-limited per key, and unsupported request features are rejected rather than ignored.

## Not yet protected (do not rely on it)
No TLS termination (put a reverse proxy in front), no multi-tenant isolation, no RBAC beyond user/admin, in-memory rate limiting and usage ledger, no sandboxed execution (the local runtime does not exist yet). No third-party audit has been performed.
