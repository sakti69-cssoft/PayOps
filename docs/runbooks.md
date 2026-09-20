# Operations runbooks

## Startup troubleshooting

1. `docker info` must succeed. This host's WSL hang and orphaned Docker socket startup failures were repaired on 19 September 2026. The repair preserved runtime folders, restarted WSL and disabled optional Docker AI. If startup fails again, inspect current logs before changing anything; do not factory reset, unregister distributions or delete volumes automatically.
2. `docker compose config --quiet` validates configuration without starting services.
3. Inspect `docker compose logs seed`: migrations must complete and checksum verification must pass.
4. Inspect API readiness and worker logs. Liveness alone does not mean dispatch is progressing.
5. Check broker ACL credentials and device HMAC version independently; they are different credentials.

## Broker outage and recovery demonstration

Use the isolated `npm run test:fault` suite; its broker outage scenario accepts a payment while the test broker is stopped, verifies durable noncompletion, waits for persisted incident evidence, restarts the broker, and waits for verified completion. It then authenticates and generates a read-only mock investigation with validated citations. It never stops the development broker. Run `npm run demo` for a normal synthetic payment in the development stack, then use Investigation in the dashboard for any captured incident.

## Replay

Inspect command expiry, receipt references, attempts and immutable incident evidence. In the dashboard, eligible rows expose Replay. Confirm explicitly. The backend rechecks membership, operator role, ownership, current state and expiry under a transaction lock. A successful replay resets dispatch attempts while retaining attempt history and the logical command ID, and appends an audit event. Never replay a completed command or change an accepted payment's idempotency key to hide uncertainty.

## Backup / separate restore

`npm run backup` writes a custom-format dump directly to a file using a process pipe (safe for binary output on PowerShell). `npm run restore -- backups/<file>.dump` creates `payops_restore_<timestamp>`, then restores with exit-on-error. It does not overwrite, drop or switch the original database. Verify payment/command/receipt/evidence counts and migration checksums, then perform a synthetic round trip against the restored database before any deliberate cutover. The initial container recovery suite successfully restored payment and evidence rows into a separate database; the strengthened suite compares counts and content digests while test writers are stopped.

## Migration / rollback

Migrations are ordered SQL files with SHA-256 checksums and one session advisory lock. Each migration executes in a transaction. Never edit a migration already applied to a persistent database. Add a forward migration. A failed migration rolls back and records no checksum. For application rollback, use the previous image only if its schema compatibility is established. Otherwise restore a backup into a **separate** database and investigate before cutover. Never automate destructive down migrations.

## Device signing-key rotation

Run `node --env-file=.env --import tsx scripts/rotate-key.ts <device-uuid>` with migration credentials. It creates the next version and saves a private `.runtime/device-...env` file; secrets do not appear in logs. Provision the simulator/device with the new key and version. Keep the old credential active until its pending receipt queue has drained. Then explicitly revoke the old `(device_id,version)` in a privileged audited transaction. For compromise, revoke immediately and accept that old pending receipts will be rejected. Broker password rotation is separate: change its private environment value and recreate broker-init and broker; keep the ACL device ID synchronized. New device onboarding requires an explicit broker ACL entry.

## Reconciliation and retention

Reconciler passes use a transaction advisory lock. A worker restart recovers leases after expiry; no manual lease deletion is required. Keep device time synchronized within 120 seconds. Preserve receipt message identity tombstones as long as their commands are valid historical evidence. Heartbeat replay rows older than one day are deleted in bounded batches. Evidence, audit and delivery-attempt retention is intentionally not automatically destructive; plan archival as data grows.

## Monitoring

Start the optional monitoring profile. Prometheus scrapes the worker on its internal port 3001; Grafana uses Prometheus automatically. No device, payment, merchant or command identifiers are metric labels. Backlog, age, retries, missing receipts and offline-device gauges come from PostgreSQL. `payops_recent_delivery_mean_seconds` reports the mean acceptance-to-verified-receipt latency of the latest 1000 completed commands (zero when empty), using durable timestamps. The API also maintains a process-local completion histogram, but it is not scraped by the worker endpoint.
