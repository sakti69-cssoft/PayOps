# API reference

Base: `http://localhost:3000`. JSON body limit: 16 KiB. `/api` requests limited to 300/minute per source IP; login to 10/minute. API should sit behind a configured TLS reverse proxy outside the local demonstration. Do not blindly enable Express trust proxy.

All merchant endpoints require `Authorization: Bearer <JWT>`. Merchant access is checked against the user's current membership. Unknown or unauthorized resources return 404. Readers can inspect; operators and merchant admins can accept synthetic payments and replay eligible announcements.

| Method / path                                            | Behavior                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /api/login`                                        | `{email,password}` → `{token}` valid for one hour                                       |
| `GET /api/me`                                            | Authorized merchants and roles                                                          |
| `POST /api/merchants/:merchant/payments`                 | `Idempotency-Key` required; 201 new, 200 identical duplicate, 409 conflicting duplicate |
| `GET /api/merchants/:merchant/payments`                  | Paginated payments, separate dispatch and completion states                             |
| `GET /api/merchants/:merchant/payments/:id`              | Payment, latest bounded attempts and receipt references                                 |
| `GET /api/merchants/:merchant/devices[/:id]`             | Device status without credentials                                                       |
| `GET /api/merchants/:merchant/incidents[/:id]`           | Incident feed or immutable evidence                                                     |
| `GET /api/merchants/:merchant/audit`                     | Operator action history                                                                 |
| `POST /api/merchants/:merchant/announcements/:id/replay` | `{confirm:true}`, operator required; same logical ID; audited                           |
| `POST /api/device-evidence`                              | HMAC-authenticated heartbeat or completion, durable acknowledgment                      |
| `GET /health/live`                                       | Process liveness                                                                        |
| `GET /health/ready`                                      | Database and recent worker progress                                                     |

Lists take `limit` (1–100, default 25) and `offset` (0–100000). Timeline attempts and receipts are bounded at 100; incident evidence at 50. Errors use `{error,correlationId}`, including throttling and unknown routes.

Payment body:

```json
{
  "deviceId": "00000000-0000-4000-8000-000000000001",
  "amountMinor": "12900",
  "currency": "INR",
  "reference": "Synthetic order 123"
}
```

Only INR, USD and EUR are accepted; this demo treats all three as 100 minor units per unit. The amount is a decimal integer string, never floating-point money. An idempotency key identifies **one semantic request** within a merchant. Do not change the key when retrying an ambiguous outcome.

## Device evidence signing v1

Signature = lowercase hex HMAC-SHA256 of UTF-8 `payops:evidence:v1\n` followed by canonical JSON of all fields except `signature`. Canonical JSON recursively sorts object keys, preserves array order, omits undefined object values, and uses JSON string encoding without whitespace. Allowed fields are strictly validated.

Common fields: `kind`, `deviceId`, positive `credentialVersion`, UUID `messageId`, ISO UTC `timestamp`. Receipts also require `commandId` and `result` (`completed` or `expired`). Heartbeats may not contain receipt fields.

All new messages reject timestamps over 120 seconds in the future. New heartbeats reject timestamps more than 120 seconds old. Delayed receipts may be older, but cannot predate their payment by more than the skew allowance. Only a completion timestamp at or before command expiry can establish an in-time effect. Exact valid retransmissions return their prior durable acknowledgment; a reused identity with different signed content returns 409. Revoked credentials fail even on retransmission. Keep overlapping versions active until queued receipts drain.

The assistant endpoint is intentionally absent while the reliability gate is unmet.
