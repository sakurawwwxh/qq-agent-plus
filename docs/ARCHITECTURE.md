# QQ Agent Architecture

## Runtime Topology

QQ Agent is a modular Node.js monolith. The OneBot implementation is an
independently managed service. DeepSeek Harness and the legacy Bridge are not in
the message-processing path.

```text
QQ client
  -> external OneBot v11 WebSocket events
  -> per-chat serialized ingestion
  -> SQLite/WAL message state machine
  -> bounded message aggregation and trigger policy
  -> Agent Session and optional conversation lifecycle
  -> OpenAI-compatible model and chat-bound tools
  -> durable outbox
  -> external OneBot v11 HTTP API
```

The same process serves the authenticated management console and SSE updates.
Background managers handle memory consolidation, optional proactive runs, daily
Qzone moments, Qzone interactions and optional identity indexing.

Plugins are the one exception to the single-process model: every enabled plugin
runs in its own child process and talks to the host over newline-delimited JSON
on stdio. The child gets only the capabilities declared in its manifest, and each
capability is implemented host-side (outbound HTTP through `safe-fetch`, storage
inside the plugin's own directory, sends through the normal send queue). This is
what keeps third-party code away from the configuration file and the protocol
client, and it removes the "unhandled exception in a plugin kills the bot" case.

All host-side outbound HTTP (web search, media downloads, plugin HTTP) goes
through `src/llm/safe-fetch.js`. HTTPS GETs and media downloads try HTTP/2
first and fall back to HTTP/1.1 when the server or connection cannot use it;
DNS pinning, private-address blocking, per-hop redirect checks, credential
stripping, body/decompression caps and timeouts apply to both transports. POST
stays on HTTP/1.1 so a request that already reached the peer is never replayed.

## Module Boundaries

| Area | Main modules | Responsibility |
| --- | --- | --- |
| Bootstrap and HTTP | `src/server.js`, `src/console/app.js` | Dependency assembly, lifecycle, event ingestion, console API and SSE |
| Protocol adapter | `src/onebot/onebot.js` | OneBot WebSocket reconnect, HTTP calls and QQ message normalization |
| Durable state | `src/core/store.js` | Message deduplication, leases, outbox, lifecycle transcripts and checkpoints |
| Agent control | `src/core/orchestrator.js` | Debounce, trigger policy, concurrency, model/tool loop and recovery |
| Prompt and tools | `src/llm/prompt.js`, `src/tools/` | Persona context and tools restricted to the current chat |
| Persona runtime | `src/personas.js`, `src/llm/bubble-shape.js`, `roles/voice-profiles.json`, `roles/dialogs/` | Card voice profiles, few-shot examples and bubble shaping (code/URL/emoticon-safe) for persona replies only |
| Delivery | `src/onebot/sender.js` | Per-chat serialization, rate limits, message splitting and outbox completion |
| Outbound network | `src/llm/safe-fetch.js` | HTTP/2-first HTTPS GET/media with HTTP/1.1 fallback, DNS pinning, SSRF checks, per-hop redirects, credential stripping and body/timeout caps |
| Model access | `src/llm/llm.js`, `src/core/providers.js`, `src/core/provider-presets.js` | Chat Completions, retries, provider credentials, usage and per-channel thinking presets |
| Sticker system | `src/onebot/sticker-manager.js`, `src/onebot/stickers.js` | QQ favourites sync, notes, tiered lookup, auto-collect and local asset storage |
| Memory | `src/memory/`, `src/identity/` | Member impressions, handoff state, cross-chat identity index and SQLite FTS5/bigram retrieval with capacity and retention limits |
| Skills | `src/skills/` | Read-only Markdown workflows, manifest validation, per-chat enablement and tool-allowlist narrowing (`skill_list` / `skill_use`) |
| Plugins | `src/plugins/` | Manifest validation (v1/v2), one child process per plugin (NDJSON protocol), host-side capabilities, AES-256-GCM secrets, settings schema, object-bound write approvals, quotas and write audit, index fetching, sha256-anchored install/replace/rollback, revocation |
| MCP resources | `src/mcp/resource-server.js` | Read-only stdio MCP server exposing people memory, memes and pending reminders (sanitised, no config/credentials) |
| Pilots (observability) | `src/pilots/` | Incident panel, relationship shadow evaluation, slang assets, multimodal-context pilot |
| Scheduled social work | `src/features/daily-moments.js`, `src/core/reminders.js`, `src/features/qzone-interactions.js` | Qzone source/draft decisions, recurring reminders (daily/weekly/cron, IANA zones) and their external effects |
| Runtime guards | `src/core/token-saver.js`, `src/core/time-gate.js`, `src/core/redact.js` | Token ceilings, active-hour gating, log redaction |
| Operations | `deploy.sh`, `manage.sh`, `scripts/*.mjs`, `src/ops.js` | Installation, systemd service, health, backup and recovery actions |

`app.js` is the composition root. The protocol, persistence and orchestration
classes are separate, but they run in one process and share the configured data
directory.

## Message State Machine

Incoming messages are deduplicated by `(chat_key, platform_message_id)` and use
these durable states:

```text
pending -> leased -> acked
                 \-> pending  (retryable failure)
                 \-> failed   (permanent or exhausted)
                 \-> held     (an external send may have happened)

incoming reply/at/forward
  -> deferred (bounded background enrichment) -> pending
                                              -> acked (silent/catch-up)
                                              -> dropped (blacklist)
```

A unique partial index permits at most one leased run per chat. The Agent only
acknowledges the claimed message IDs after successful processing. Messages that
arrive during a run remain pending for the next batch.

Every outbound effect is inserted into `outbox` before dispatch. A confirmed
response becomes `sent`; a timeout or ambiguous failure becomes `unknown`.
Messages with possible effects are held for operator review instead of being
automatically replayed. This limits duplicate replies but cannot provide the
exactly-once guarantee that the external QQ API does not offer.

## Conversation Boundaries

Three identifiers have different ownership:

- `chatKey`: one QQ group or private conversation.
- `sessionId`: one claimed batch and Agent execution, including budgets, tools,
  sends and audit data.
- `threadId`: optional state shared by multiple Sessions in threaded or
  lifecycle mode.

Legacy mode reconstructs bounded context for each triggered batch. Threaded mode
adds deterministic continuation behavior. Lifecycle mode stores an append-only
provider transcript in SQLite while the lifecycle is active, so later Sessions
continue the same model context without keeping an HTTP request open while idle.
Structured checkpoints survive lifecycle rollover.

## Persistence

The deployment data directory contains:

- `config.json`: runtime configuration and credentials, mode `0600`.
- `messages.sqlite`: messages, leases, outbox, threads and checkpoints.
- `sessions/`: per-run audit records.
- `memory/`: member impressions and handoff state.
- Optional feature-specific SQLite databases, such as the identity index.
- Qzone task state and managed sticker metadata.

SQLite uses WAL and `synchronous=FULL` by default; `store.sqliteSynchronous`
can be set to `NORMAL` on IOPS-constrained disks. JSON stores use temporary-file rename
where their modules require atomic replacement. These stores and remote API
effects do not form one global transaction, so each background manager defines
its own idempotency and recovery rules.

## Security Boundaries

- Empty allowlists do not allow traffic unless `allowAllWhenEmpty` is explicit.
- Observe mode archives input but blocks normal model runs and all delivery.
- Tool closures bind sends and reads to the current chat.
- Console credentials are omitted from normal config responses.
- LAN console binding requires a token; plain HTTP still requires a trusted
  network or a TLS reverse proxy.
- Remote image and page retrieval validates schemes, DNS answers, redirects and
  response sizes to reduce SSRF and resource-exhaustion risk.
- Plugin processes run under Node's permission model (read-only access to their
  own directory) and, on Linux, inside a network namespace without interfaces;
  when neither is available the host refuses to load them unless the operator
  explicitly turns isolation off. Plugin packages are only installed from an
  index entry anchored by sha256, and a central revocation list is fetched before
  the plugin hosts start.
- Credentials, login state and runtime data are excluded from Git.

## Linux Deployment

`deploy.sh` is the supported installation and update entry point:

1. Validate Linux, paths, tools, source files and service access.
2. Reuse Node.js 22.19+ with `node:sqlite`, or download a pinned Node archive and
   verify it against the official SHA-256 manifest.
3. Lock the data directory and snapshot the previous application/config/unit.
4. Stop the existing service, synchronize source and run reproducible production
   dependency installation.
5. Create or update configuration without resetting an existing runtime mode.
6. Install and verify a hardened user-level systemd unit.
7. Install the independent GitHub update service/timer, enable linger, start the
   Agent and require `/healthz` to succeed.
8. Restore the prior code, configuration, unit and active state on failure.

The installer records the exact deployed Node executable. `manage.sh` uses that
runtime, so status, backup and recovery commands still work when the host has no
system Node.js installation.

The update timer does not modify the running deployment directly. Its oneshot
worker shallow-fetches GitHub into the data directory, tests a temporary
checkout and then invokes the same `deploy.sh` transaction. Failed updates
disable future automatic attempts and are reported through the running or
restored Agent.
