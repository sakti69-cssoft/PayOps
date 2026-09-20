# Guarantees, limits and measurement

## Intended guarantees, subject to executed verification

- PostgreSQL commit is the acceptance boundary. Payment, command and outbox intent are atomic.
- `(merchant,idempotency_key)` uniqueness protects logical acceptance under concurrent requests.
- Dispatch retries use bounded concurrency, timeouts, expiring fenced leases and stable logical IDs.
- MQTT QoS 1 can duplicate delivery. Broker PUBACK does not prove device completion.
- Simulator durability comes from SQLite WAL with synchronous FULL and one transaction for synthetic effect, deduplication and pending receipt. Pending evidence is retried until the API commits and acknowledges it.
- Completed commands do not regress on late broker messages or contradictory expiry receipts.

Real sound playback cannot generally be committed atomically with a database update. Crashing after sound but before recording it can replay audio; recording before sound can lose playback. This implementation makes **no exactly-once physical playback claim**.

## MQTT session choices

MQTT 5, QoS 1, persistent sessions (`clean=false`), 300-second session expiry, stable device client IDs, and distinct configured worker client IDs. Never run two worker instances with the same WORKER_ID. Reconnect delay increases with jitter up to 30 seconds. Commands are never retained; message expiry is the remaining command lifetime. Broker offline queues are bounded at 1000 messages and packets at 20 KB. A device without an existing subscription may miss a publish; reconciliation republishes missing receipts under the same ID. Broker persistence is helpful but PostgreSQL remains dispatch truth.

## Availability

Single-host Compose is **not highly available**. Host loss, disk loss, PostgreSQL outage and loss of simulator storage are single points of failure. Database failure prevents acceptance and receipt acknowledgment; callers must retry the same identity. Broker outage permits durable payment acceptance but delays delivery. Losing all database copies loses accepted work. Losing a simulator's deduplication database can repeat synthetic effects for previously delivered commands.

Ordinary operator replay is limited to unexpired, uncompleted terminal dispatches. Expired payment commands need investigation; the demo refuses to silently renew TTL or create another logical payment. Evidence incidents are deduplicated per resource/kind and remain open for investigation; automatic resolution and recurrent incident episodes are not yet implemented.

## Measurements

Native and container recovery observations are recorded in [test results](test-results.md), including an executed separate-database restore. The isolated container suite writes a JSON report with scenario duration, invariant, pass/fail and error. Scenario duration includes failure injection and checks; it is **not** a pure recovery-time SLO or throughput benchmark.

Backups are consistent logical snapshots without continuous WAL archival. The potential data-loss window is all accepted writes after the snapshot; no scheduled backup interval or zero-RPO guarantee exists. Restore timing must be measured on the actual dataset and host. Backup files and restored databases are always separate from the running application database.
