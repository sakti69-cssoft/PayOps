# Threat model

This single-host synthetic demonstration assumes a trusted workstation and administrators. It is not an internet-ready payment system.

| Threat                 | Implemented boundary / remaining limitation                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-merchant access  | Verified JWT subject plus current database membership and resource filters; composite ownership constraints. Integration negative tests await execution.                                                                   |
| JWT forgery            | HS256 allowlist; issuer, audience, subject, issued-at, expiry and maximum-age validation; random 48-byte local secret.                                                                                                     |
| Password theft         | Salted scrypt hashes; login throttling. No MFA or password recovery flow.                                                                                                                                                  |
| Device impersonation   | Per-device/version HMAC, strict canonical format, timestamp validation and durable message identity uniqueness.                                                                                                            |
| Command eavesdropping  | Per-device broker users and exact topic ACL; no anonymous access. MQTT is plaintext on the trusted local Docker network. TLS/mTLS required for remote devices.                                                             |
| Duplicate deliveries   | Stable command IDs; SQLite transaction commits inbox, synthetic effect and pending receipt atomically. Not an exactly-once physical sound guarantee.                                                                       |
| Stale worker writes    | Unique lease tokens and conditional updates requiring an unexpired lease. Publishing cannot be fenced by PostgreSQL; device deduplication absorbs it.                                                                      |
| Evidence tampering     | Restricted app role lacks UPDATE/DELETE/TRUNCATE on evidence, receipts, audit; triggers reject row mutation. Database owners/superusers can disable triggers or change grants. No cryptographic external transparency log. |
| Secret disclosure      | Ignored environment and runtime files, redacted structured logging, device keys omitted from API/evidence. Database credential secrets remain plaintext at rest; protect/encrypt host volumes and backups.                 |
| Request/queue overload | Size and per-IP rate limits, bounded connection pool, claim concurrency, publish timeout and broker queue caps. No guaranteed overload SLO; test burst is small and explicit.                                              |
| Model prompt injection | GenAI is not yet implemented; disabled pending required reliability verification. No model has tools or operational access.                                                                                                |

A stolen device HMAC key can fabricate evidence for that device. A signed receipt proves possession of the key and a reported result, not independent proof of actual audio playback. Merchant admins are not database administrators. Privileged maintenance scripts use separate migration credentials and require filesystem access.

The application PostgreSQL role is restricted for append-only evidence but otherwise shared between API and worker. Tenant isolation is implemented in application queries, not PostgreSQL RLS. Further hardening should split application roles, add TLS and a secret manager, and establish retention/backup policy before any external deployment.
