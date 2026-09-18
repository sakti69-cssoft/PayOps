# PayOps GenAI

A synthetic payment soundbox monitoring and incident platform. No real money or bank integrations.

**Status:** core API, worker, simulator and React console implemented and exercised against native PostgreSQL and Mosquitto. Unit, database/security, MQTT and 11 native recovery scenarios pass. Docker/WSL on the implementation host is unavailable, so container builds, the full container fault suite, backup restoration and the complete GenAI demonstration remain unverified. The GenAI implementation is deliberately deferred until the required reliability gate is met. See [PROGRESS.md](PROGRESS.md) and [test results](docs/test-results.md).

## Start locally

Requirements: Node.js 24, npm, Docker Engine with Compose v2, approximately 2 GB available RAM for the core stack. Ports 3000, 5173, 5432 and 1883 must be free.

```sh
npm ci
npm run setup
docker compose up --build -d
docker compose ps
```

The setup command generates random credentials in ignored `.env`; it never replaces an existing file. Migration and seed are one-shot prerequisite services. Open http://localhost:5173 and sign in as `admin@cedar.test` with `SEED_PASSWORD` from your private `.env`. `reader@cedar.test` and `admin@harbor.test` use that same local seed password. There are two synthetic merchants; only Counter 01 has a simulator by default. Seed data contains **no invented payment successes**.

No secrets are embedded in the development stack. The isolated test stack uses explicit test-only credentials. Never expose either stack to an untrusted network.

For separate host processes, start only dependencies and seed:

```sh
docker compose up --build -d database broker seed
npm run api
# In another terminal:
npm run worker
# In another terminal, use device broker credentials as shown below:
npm run simulator
# In another terminal:
npm run dashboard
```

The simulator needs `MQTT_PASSWORD` set to the value of `DEVICE_MQTT_PASSWORD`. Host process scripts load `.env` using Node's native environment-file support; shell variables take precedence. For PowerShell:

```powershell
$env:MQTT_PASSWORD = (Get-Content .env | Where-Object { $_ -like 'DEVICE_MQTT_PASSWORD=*' }).Substring(21)
npm run simulator
Remove-Item Env:MQTT_PASSWORD
```

For Bash:

```bash
MQTT_PASSWORD="$(sed -n 's/^DEVICE_MQTT_PASSWORD=//p' .env)" npm run simulator
```

Do not source arbitrary untrusted environment files. The generated `.env` contains only alphanumeric values and URLs. Windows hosts may use `npm.cmd` if PowerShell script execution policy blocks `npm.ps1`.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run integration
npm run test:fault
```

`integration` creates a uniquely named `payops-test-*` Compose project, starts PostgreSQL/Mosquitto, then runs real-service tests. `test:fault` builds an isolated API/worker/simulator stack and runs deterministic crash and outage scenarios. Both stop only their own containers and **retain all volumes** for inspection. They fail explicitly if Docker is unavailable. Test ports default to 55432, 51883 and 53000; set `TEST_PG_PORT`, `TEST_MQTT_PORT`, `TEST_API_PORT` to unused ports for simultaneous runs. Never point the suite at development services. Low-level `test:integration` requires an explicit `TEST_DATABASE_URL` whose database name begins `payops_test_`, and `TEST_MQTT_URL`.

```powershell
$env:TEST_PG_PORT='55433'
npm run integration
```

```bash
TEST_PG_PORT=55433 npm run integration
```

## Native diagnostic fallback

If Docker is unavailable but you have a local PostgreSQL server, set `NATIVE_PG_URL` to its maintenance database and run `node --import tsx scripts/native-db-tests.ts`. It creates and retains a separate `payops_test_native_*` database. For the Windows native recovery harness, also set `NATIVE_MOSQUITTO` to a directory containing the official `mosquitto.exe` and `mosquitto_passwd.exe`, then run `node --import tsx scripts/native-recovery.ts`. That harness uses separate test ports and a fresh test database/runtime directory; it stops only the processes it starts.

These diagnostics provided the native test results in this repository. They do not replace container builds, the complete container fault suite or backup/restore verification.

## Operations

```sh
docker compose logs -f api worker simulator
docker compose --profile monitoring up -d
npm run backup
npm run restore -- backups/<chosen-file>.dump
docker compose down
```

`down` does not remove volumes. Do not add `-v` unless you independently decide the specific volumes are disposable. Backups contain device keys; protect the ignored `backups/` directory.

## Repository

- `apps/api`: authentication, merchant routes, atomic acceptance and receipt verification.
- `apps/worker`: short claim transactions, fenced leases, MQTT publish and reconciliation.
- `apps/simulator`: SQLite WAL inbox, atomic synthetic effect and durable pending evidence.
- `apps/dashboard`: responsive React operations console with real backend data.
- `packages/contracts`, `security`, `database`, `observability`: shared boundaries.
- `infra`: resource-conscious Compose, Mosquitto ACLs and optional monitoring.
- `tests`: unit, real PostgreSQL/MQTT integration and process fault fixtures.
- `scripts`: setup, isolated test orchestration, backup, restore and rotation.

Read [architecture](docs/architecture.md), [API](docs/api.md), [threat model](docs/threat-model.md), [runbooks](docs/runbooks.md), [reliability](docs/reliability.md), and [verification status](docs/test-results.md).
