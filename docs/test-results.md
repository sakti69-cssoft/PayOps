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

## Blocked / unverified

- `npm run integration` attempted an isolated test project and failed before service startup because Docker Engine returned HTTP 500 when inspecting the Mosquitto image. No integration pass is claimed.
- Docker backend log: `connect tcp 192.168.65.7:2376: no route to host`.
- WSL diagnostic failed with `Wsl/Service/0x8007274c`.
- Container builds, full container fault suite (including full database outage, poison/exhaustion/replay and backup restoration), and the complete GenAI demonstration are unverified. Native results above do not establish container behavior or high availability.
- GenAI provider interface, mock, real adapter and model security tests are deferred by the explicit Phase 10 gate. No real-provider credential or live-model execution has been verified.

Native tool provenance: PostgreSQL 17.6 binaries were obtained via the npm `@embedded-postgres/windows-x64@17.6.0-beta.15` distribution (the wrapper's version includes beta; the server reports 17.6). Mosquitto 2.0.22 was extracted without system installation from the [official Windows download](https://mosquitto.org/files/binary/win64/). These tools are isolated under ignored `.runtime/`, not runtime npm dependencies or a substitute for Compose.
