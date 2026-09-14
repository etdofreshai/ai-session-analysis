# AI Session Analysis

A local Vite + React dashboard that analyzes sessions from Claude Code, Codex,
Pi, and OpenCode: models used, estimated cost, message counts, tool usage,
subagent activity, and per-session drill-downs.

The default local stores are:

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`
- OpenCode: `~/.local/share/opencode/opencode.db`

## How it works

The Vite dev server includes a middleware plugin (`server/api.ts`) that scans
these stores **server-side** (the data can be hundreds of MB — transcripts and
databases never ship raw to the browser). Parsed per-session stats are cached by
file/database modification state, so the first scan is the slow one and
refreshes are cheap.

- `GET /api/stats` — aggregated stats for every session in every project
- `GET /api/session?project=&id=` — full drill-down with an event timeline

Claude subagent transcripts and OpenCode child sessions are parsed and
attributed to their parent session.

Token usage is deduplicated by API message id (streamed messages repeat the
usage block across multiple JSONL records).

## Direct graph links

Open Overview with the past week's daily graph:

```text
https://ai-session-analysis.etdofresh.com/?granularity=day&range=1w#/overview
```

Optional query parameters override this browser's saved Overview preferences:

- `granularity`: `day` or `hour`.
- `range`: daily `1w`, `1m`, `3m`, `6m`, `1y`, `all`; hourly `6h`,
  `12h`, `24h`, `48h`, `120h`, `168h`.
- `modelView`: `simple` or `broken-out`.

Missing or invalid values fall back to saved preferences, then defaults.
Overrides apply when Overview opens, including after unlocking the site, and do
not overwrite the corresponding saved preferences. Controls still work during
that visit; reloading the link reapplies its settings. Reset view clears the
Overview query parameters as well as saved settings. `#/overview` selects the
Overview tab, with the daily/hourly trend as its first graph.

## Cost estimates

Claude Code transcripts record token usage but **not** billed cost. The app
computes estimates from an editable pricing table (Pricing tab, persisted to
localStorage). Claude defaults follow the official pricing docs (June 2026):
Fable/Mythos 5 at $10/$50 per MTok, Opus 4.5–4.8 at $5/$25, deprecated Opus
4.0/4.1 at $15/$75, Sonnet at $3/$15, Haiku 4.5 at $1/$5. GLM/GPT/Gemini rows
are approximations except exact named OpenAI rows such as GPT-6 Astra at
$10 input / $1 cached input / $50 output per MTok. Cache-write pricing distinguishes 5m vs 1h ephemeral
entries. Caveat: fast mode (premium Opus pricing) is not detected, and
subscription plans (Pro/Max) don't bill per token — treat costs as
API-equivalent value, not an invoice.

## Run

```sh
npm install
npm run dev    # http://localhost:5180
```

Override nonstandard local stores with `CLAUDE_PROJECTS_DIR`,
`CODEX_SESSIONS_DIR`, `PI_SESSIONS_DIR`, or `OPENCODE_DATA_DIR`.

Configured remote hosts are synced into `~/.ai-remotes` too. OpenCode sync
copies only `opencode.db` and its WAL companions, deliberately excluding its
large snapshot and tool-output directories.

## Dokploy/container deployment

The included Dockerfile runs the same Vite API/UI server on port 5180. Set
`AI_REMOTE_HOSTS` to the SSH source hosts and mount the declared
`/data` volume so the append-only staging archive and dedicated SSH key survive
redeploys. `AI_DISABLE_LOCAL=1` (the image default) prevents a phantom
container-local host from appearing in the dashboard. `/healthz` is a
non-scanning liveness endpoint.

Dashboard-wide settings are `AI_REMOTE_HOSTS`, `AI_REMOTE_CACHE`,
`AI_LOCAL_LABEL`, `AI_DISABLE_LOCAL`, and `AI_SYNC_TTL_MS`. Their former
`CLAUDE_` names remain supported as fallbacks; `AI_` takes precedence. An
existing `~/.claude-remotes` archive is reused automatically rather than
abandoned. Set `AI_REMOTE_CACHE` explicitly to select another archive.
`CLAUDE_PROJECTS_DIR` still names the Claude Code source, not the dashboard.

Direct API swarm usage can be included with the optional read-only ledger
source below. Codex-backed swarm sessions are included once their rollouts
are in a configured Codex source directory. Remote Codex archived sessions are not
pulled independently; the append-only cache retains only files previously
synced from the active sessions directory.

### Swarm direct API usage

Set `AI_SWARM_DATABASES` to a JSON object mapping configured host labels to
their swarm-console database paths, for example:

```json
{"etzgt103":"/home/etgarcia/.repos/swarm-console/.data/swarm.sqlite"}
```

The source host needs Node.js with `node:sqlite` (Node 22.13+ or 24+) on
its noninteractive SSH PATH. Each normal sync executes the dependency-free
`server/export-swarm.cjs` over SSH, opens SQLite read-only in a snapshot
transaction, and returns compact hourly usage buckets. No source files,
databases, sessions, or services are modified. Transcripts and raw attribution
payloads never leave the source host.

Usage-bearing records are deduplicated by model and generation ID, with
request ID plus attempt as the fallback. Distinct billed retry generations
remain separate. Records without usage do not count as model calls or errors.
The export reads current rows on every sync so later usage updates are picked
up without append-only double counting.

The `swarm` source groups direct requests by board and owner/agent. These rows
are usage groups, not Codex threads; prompt/message/tool counts are not inferred.
Daily buckets use Central Time, and all retained hourly history is available.
The existing pricing table estimates costs from normalized token counts; the
ledger's own billed/estimated dollar values are not mixed into those estimates.
Codex-backed swarm sessions remain under `codex`, not duplicated under `swarm`.

`<host> / swarm` has independent sync status. Failed or invalid exports retain
the previous complete snapshot and show an error. The snapshot is kept in the
existing durable archive volume, with the original source database path
recorded for provenance. It mirrors the ledger rather than preserving rows
deleted from that ledger.

Set `DASHBOARD_PASSWORD` and a high-entropy `DASHBOARD_SESSION_SECRET` when the
service is routed through a public hostname. Unauthenticated browser requests
receive an unlock screen; successful entry creates a Secure, HttpOnly,
SameSite session cookie. The health endpoint remains unauthenticated, while all
UI assets and session APIs require the session. `DASHBOARD_BASIC_AUTH` remains
as a deployment-compatibility fallback only when `DASHBOARD_PASSWORD` is unset.

For a migration, `ARCHIVE_BOOTSTRAP_SOURCE` can point to the existing Mini
archive (with a trailing slash). The entrypoint rsyncs it once into the volume,
writes `/data/.archive-bootstrapped` only after success, and then switches to
normal incremental per-host pulls. Remove the bootstrap key environment value
after the persistent volume has been verified.

## Notes

- "Prompts" counts real user inputs; tool results echoed back as user messages
  are counted separately.
- `<synthetic>` model entries (client-generated messages) cost $0.
- Sessions running under proxies (GLM, Codex) show those models — pricing is
  approximate there; adjust in the Pricing tab to match your plan.
