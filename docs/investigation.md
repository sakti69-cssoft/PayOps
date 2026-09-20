# Read-only incident investigation

The assistant is enabled after the initial 17-scenario Docker recovery suite passed. Its provider receives a bounded, typed projection of at most ten authorized incident snapshots. It receives no database connection, tool definitions, shell capability, user token, payment reference, free-form error text, device name, credential, or operational action endpoint.

## Modes

`GENAI_PROVIDER=mock` is the default: deterministic selection, explicitly labeled in every response and in the dashboard. No external model is called. Set `GENAI_PROVIDER=openai`, `GENAI_API_KEY`, and optionally `GENAI_MODEL` in your private `.env` to use the real adapter. The default model is `gpt-4.1-mini`. Recreate the API after configuration changes. Model access depends on your API account; ChatGPT/Codex usage is separate from API credentials.

The adapter uses the [OpenAI Responses API structured-output format](https://developers.openai.com/api/docs/guides/structured-outputs). It sets `store:false`, a 2,500 output-token ceiling, a 24,000-character input ceiling, a 64-KiB response ceiling, and a seven-second provider deadline. No live model execution is claimed without credentials and a successful live test.

## Grounding and limitations

The model selects and orders known observation and hypothesis identifiers. The server rejects invented identifiers, additional fields, malformed output, refusals, incomplete output, and oversized responses. All displayed prose comes from trusted templates and typed snapshot values. This intentionally limits fluent open-ended generation to make supported claims reviewable. The server preserves all observations, contradictions and missing-information notices even if the provider omits them. Hypotheses remain explicitly unconfirmed.

Every observation links to its immutable evidence snapshot. Snapshot timestamps describe historical observations, not current state. Empty receipt history does not prove the device never completed. Arbitrary logs are excluded rather than trusted as model instructions. The application cannot prove a root cause from snapshots alone.

## Authorization, bounds and audit

`POST /api/merchants/:merchantId/incidents/:id/investigation` requires a JWT, current membership, incident ownership and an empty JSON object. Readers may investigate. Cross-merchant IDs return 404 before provider invocation. A database advisory lock enforces ten requests per user per rolling hour across API instances, including failed provider requests. Each API process permits at most two concurrent investigations. Requests, completions and failures append audit records; provider bodies and credentials are not logged.

Only those audit records are written by the request handler. The provider can neither mutate payments/devices nor replay commands. Provider failure returns 503 while the ordinary incident and evidence endpoints remain available. These application controls do not defend against a database administrator or arbitrary trusted server code.

The unit suite covers untrusted input, unsupported claims/references, incomplete and contradictory evidence, request format, failures, response bounds and timeouts. Real PostgreSQL tests cover membership, tenant boundaries, reader access, audit, provider failure and persisted request budgets.
