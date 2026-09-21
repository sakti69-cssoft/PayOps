# Parent platform monitoring

PayOps is the monitoring and investigation child of [Cloud-Native Payment Soundbox Platform](https://github.com/sakti69-cssoft/Cloud-Native-Payment-Soundbox-Platform). This connection is an optional read-only polling bridge. The parent owns its payments and MQTT announcements. PayOps imports observations into separate tables and never routes them into its payment API, commands or outbox.

## Data flow

1. A synthetic signed payment reaches the parent API and follows the parent's existing dispatch path.
2. The collector calls the parent's authenticated `GET /api/v1/transactions` endpoint, filtered to one explicitly mapped parent merchant.
3. Each validated page updates `parent_transactions` by source ID and parent transaction ID. Duplicate imports update observations without creating duplicate delivery work.
4. The **Parent platform** view displays payment status, the parent's announcement status and when each row was observed. Connection status and the last complete scan remain visible.
5. A successful parent payment that remains PENDING for over 30 seconds, or reports FAILED announcement status, creates a `parent_publication_pending` incident. Publication resolves this monitoring incident and appends another immutable evidence snapshot. Resolution establishes observed publication only, not audio playback.
6. Existing merchant authorization and cited investigation apply to those incidents. Mock mode remains the default. The investigation explicitly identifies the parent's lack of signed device receipts.

## Configure a connection

Apply migrations and rerun seed using the normal PayOps startup procedure so the application role receives access to the new tables. Rebuild/restart the API and dashboard. A parent deployment and an existing PayOps merchant must already exist. Record the UUID of each merchant; their IDs do not need to match.

Add these settings to PayOps' private `.env`, or supply them in the collector's process environment:

```dotenv
PARENT_SOURCE_ID=soundbox-parent
PARENT_API_URL=http://localhost:3000
PARENT_MERCHANT_ID=REPLACE_WITH_PARENT_MERCHANT_UUID
PAYOPS_MERCHANT_ID=REPLACE_WITH_PAYOPS_MERCHANT_UUID
PARENT_API_TOKEN=REPLACE_WITH_PARENT_MANAGEMENT_JWT
```

Use the actual parent port. PayOps on this workstation uses port 53009, while another unrelated application may own 3000. Choose an unused parent port; do not stop unrelated services. `DATABASE_URL` must reach the PayOps database from the collector process. The shown loopback URL is for a collector running on the host. Remote origins require HTTPS. Credentials in URLs, redirects, query strings and URL paths are rejected.

The token must be a valid parent management JWT signed using the parent's existing authentication mechanism. A PayOps login token cannot substitute for it. The parent currently grants global management access to such tokens; the collector only performs GET requests, but a stolen token has wider authority. Keep it out of the browser, logs, repository and generated documents. Prefer a short lifetime and replace the token before expiry. The collector reads configuration on startup, so restart it after rotating the token. A future parent-specific read-only role would reduce this remaining limitation.

```sh
npm run parent:sync -- --once
# Or keep polling, with a 15-second delay between scans:
npm run parent:sync
```

The collector is opt-in and is not started by the existing Compose stack. Stop it with Ctrl+C. It accepts no instructions from parent free-form fields, persists no source JWT, and never calls the parent's notification or replay endpoints.

## Mapping and failure behavior

A source ID binds one parent origin and merchant to one PayOps merchant. Later attempts to change that binding fail. Use a distinct source ID for a genuinely separate source. Every row must match the configured parent merchant before a page is imported. PayOps readers only see their own mapped sources and transactions.

Network, authentication and payload failures set source status to `error` while retaining previous observations. Existing observations are historical, not proof that the source is currently healthy. The UI flags a connection with no complete scan within 60 seconds as potentially stale. A collector killed mid-scan can leave `syncing` until the next successful run, with the timestamp still exposing stale data.

Each request times out after five seconds and reads at most 512 KiB. Each scan reads up to 20 pages of 100 transactions. Larger histories report `partial`, do not advance the last complete-scan timestamp and require a future cursor-based integration for complete coverage. The parent's offset pagination is not a consistent snapshot: concurrent inserts and tied timestamps can move records between pages. Repeated scans reconcile observations, but this bridge does not claim lossless event capture. Missing rows are not deleted or treated as completed.

Amounts must have at most two decimal places and are stored as integer minor units. PUBLISHED and even a parent-reported DELIVERED value remain unverified device status. The connection imports transactions, not the parent's full device inventory or heartbeat feed. The original PayOps Payments and Devices views continue to describe PayOps' own delivery path.

## Verification

Unit tests cover read-only requests, merchant filtering, origin restrictions, response bounds, authentication failure, invalid money and evidence projection. Real PostgreSQL integration tests cover repeated import, incident creation/resolution, immutable evidence, merchant authorization, source binding and preserved data after failure. Regression tests verify no native payment, command or outbox row is created by import.
