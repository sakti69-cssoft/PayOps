# Verification record

Implementation host: Windows, Node 24.15.0, npm 11.12.1, Docker CLI 29.6.2.

## Executed

- Initial unit suite: 2 files / 9 tests passed. Covers canonical signatures, tamper rejection, password hashing, JWT signatures, validation, transitions/retry limits, simulator restart deduplication, atomic effect rollback and expired/conflicting commands.
- Strict TypeScript check passed after fixing receipt result literal typing.
- ESLint passed.
- React/Vite production build passed.
- Development Compose configuration validation passed.
- npm installation audited 315 packages with zero reported vulnerabilities at initial installation.
- 18 PostgreSQL integration/process tests passed using native PostgreSQL 17.6 in a uniquely named local test database. Includes real API process termination around commit, 40 concurrent identical accepts, tenant/resource isolation, fenced claims, receipt verification, revocation, conflict preservation, concurrent migration runners/checksum tampering, and audited exhaustion replay. Final run: 18 September 2026, 16.34 seconds.
- 2 Mosquitto integration tests passed using native Mosquitto 2.0.22 with per-device ACLs and authentication.
- Native API → worker → broker → simulator → signed API receipt round trip passed. The demonstration observed completion 303 ms after polling began; this single sample is not a latency benchmark.
- 11 native process recovery scenarios passed; the exact machine-readable report is [native-recovery.json](verification/native-recovery.json). Each recovered payment was checked against the simulator's durable effect count and one original receipt.
- Browser login and merchant overview were visually inspected against the real API. Mobile layout and replay-confirmation automation have not been verified.

| Native recovery scenario                                 | Total scenario time (ms) |
| -------------------------------------------------------- | -----------------------: |
| Baseline verified round trip                             |                      846 |
| Broker killed and restarted                              |                     2545 |
| Worker killed after claim                                |                     8502 |
| Worker killed after publish                              |                     6400 |
| Simulator killed before processing                       |                     5072 |
| Simulator killed before atomic commit                    |                     4591 |
| Simulator killed after completion                        |                     4100 |
| Simulator killed before recording receipt acknowledgment |                     2993 |
| API offline after durable simulated completion           |                     5117 |
| Database connections terminated and recovered            |                     1365 |
| Backlog of 30 payments                                   |                     5439 |

These durations include injection, process startup and bounded polling; they are not service SLOs. Terminating database connections is not equivalent to testing a full PostgreSQL server outage. The native suite retains its dedicated database and runtime files and stops only its own processes.

An initial native run stopped at the final simulator crash hook because Node 24 on Windows produced a libuv shutdown assertion instead of exit code 86. Fault hooks now synchronously record the exact injected boundary. The native harness requires that marker and nonzero termination before checking durable recovery; it does not treat unrelated crashes as a successful injection. A fresh complete run then passed all 11 scenarios.

## Docker recovery and assistant verification — 19 September 2026

- Docker Engine 29.8.0 and WSL were recovered without a factory reset or volume deletion. `hello-world` passed. The original Docker/WSL startup errors above are historical, not a current blocker.
- Initial Docker integration run passed 20 tests. The initial full recovery run passed 17 scenarios, including full database outage, broker restart, API/worker/simulator crash boundaries, stale leases, poison/exhaustion/replay, contradictory receipts, a 60-payment backlog and a separate database restore. Exact report: [initial container recovery](verification/container-recovery-initial.json). This pass preceded GenAI implementation.
- After adding investigation: **16 unit tests** and **25 real PostgreSQL/MQTT integration tests** passed. New checks cover tenant isolation, reader access, durable audit/budgets, hostile evidence input, invented references/claims, contradictory and incomplete evidence, provider timeout/failure, refusal/response limits, and the OpenAI request contract using a stub transport.
- Typecheck, lint and production React build passed. A strengthened container suite adds exact crash markers, simulator effect-count verification, content-digest restore comparison, and the complete broker-outage-to-mock-investigation demonstration.

The strengthened suite passed **18/18 scenarios** in isolated project `payops-test-1fa25e32be`; [exact report](verification/container-recovery.json). Broker outage, incident capture and recovery took 29,398 ms total; the subsequent mock investigation took 485 ms. The 60-payment backlog scenario took 11,864 ms; stopping writers, dumping, restoring and comparing payment/command/receipt/evidence counts and content digests took 7,777 ms. These are single-run scenario durations on this host, not performance guarantees. All test volumes were retained.

Normal development Compose startup was also executed. A dashboard startup failure exposed missing non-root Vite cache permissions; the Dockerfile now creates and owns only the needed writable cache directories. The rebuilt dashboard returned HTTP 200; its API proxy correctly returned 401 for an unauthenticated request, and API readiness returned 200. Browser login, the actual completed synthetic payment overview, labeled mock investigation, and evidence citations were visually inspected. Mobile layout and replay-confirmation automation remain unverified.

`npm run demo` completed a synthetic payment with one verified receipt (1,174 ms observed polling duration). The documented `npm run backup` and restore script restored into `payops_restore_1789832818880`; payment, command, receipt and incident-evidence counts and content digests matched the source. The separate database and private dump were retained.

## Unverified and limits

- Live OpenAI execution is unverified; the default is explicitly labeled deterministic mock mode. Adapter contract tests do not prove account access or live model behavior.
- GitHub-hosted CI execution must be distinguished from these local results; repository publishing alone is not proof that CI passed.
- Single-host Compose is not highly available. Test scenario times include injection, restarts and verification, not just service recovery. Evidence snapshots are bounded, and no exactly-once physical audio playback is claimed.

Native tool provenance: PostgreSQL 17.6 binaries were obtained via the npm `@embedded-postgres/windows-x64@17.6.0-beta.15` distribution (the wrapper's version includes beta; the server reports 17.6). Mosquitto 2.0.22 was extracted without system installation from the [official Windows download](https://mosquitto.org/files/binary/win64/). These tools are isolated under ignored `.runtime/`, not runtime npm dependencies or a substitute for Compose.
