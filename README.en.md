# AgentActa

English | [中文](./README.md)

A local request-log dashboard for AI agents: it aggregates the session logs that various AI agents write to disk, and shows per-turn/per-request latency, tokens, cache hits, context usage and tool-call detail in a browser.

- A local long-running service + SSE live push — **no external dependencies, no network egress, purely read-only** (it injects nothing and never touches any agent's config)
- One page for 24 agents: atomcode / codebuddy / workbuddy / claude / codex / cursor / trae / qoder / opencode / gemini / copilot / windsurf / codearts / kimi / dsh / zcode / doubao / hermes / devin / minimax / mimocode / kilo / openclaw / cline
- Plus a floating desktop widget (a small Electron window): today/all-time tokens + the latest card stream

Requirements: `node` on the machine (`node -v` works, `>=22.5`). **Windows is the primary verified platform**; the code paths for mac / Linux / HarmonyOS PC (per-platform candidate directories, self-healing after cross-platform moves, POSIX permissions) are in place and pinned by regression tests, but have not been run end-to-end on real machines — before switching platforms, read the "Cross-platform" section of [REFERENCE.md](REFERENCE.md), which lists where the platforms differ and the two or three things you must handle by hand.

For the full semantics, internals and troubleshooting guide see **[REFERENCE.md](REFERENCE.md)**; for the field semantics and parsing boundaries of each agent's log format see **[LOGFORMATS.md](LOGFORMATS.md)**. (Both are currently Chinese-only.)

## Install & quick start

### From npm

```bash
npm i -g @yxzpro/agent-acta        # installs the `agentacta` and `agentacta-mcp` commands
agentacta --open                   # start the service and open http://127.0.0.1:14570
```

⚠ The package name carries the `@yxzpro/` scope: the bare name `agent-acta` was rejected as too similar to the existing `agentacta` package (someone else's similar project). **The command name is unaffected** — you still type `agentacta`. Registry mirrors sync at different speeds; if install fails, add `--registry=https://registry.npmjs.org/`.

### From a tarball (tgz)

```bash
npm i -g agent-acta-<version>.tgz   # installs the `agentacta` command
agentacta --install-hooks           # optional: auto-start the service when a session begins
agentacta --open                    # start the service and open http://127.0.0.1:14570
```

### From a source checkout

```bash
npm i -g <this directory>                              # symlink install; edits take effect immediately
node <this directory>/agent-acta-server.mjs --ensure   # or skip npm entirely and start the service with one command
```

Then open <http://127.0.0.1:14570> in a browser. Supported agents are discovered automatically — no configuration needed.

## Command reference

| Command | What it does |
|---|---|
| `agentacta` | Run the service in the foreground (the service itself) |
| `agentacta --ensure` | Make sure the port is serving **this** version: exits idempotently if it already is, restarts if the version is older (this is what the hooks call) |
| `agentacta --open` | Start the service and open the browser |
| `agentacta --client` | Start the floating desktop widget (first run downloads ~100MB of Electron runtime into `~/.agent-acta/widget-runtime/`) |
| `agentacta --stop` | Stop the service (graceful shutdown with index flush first; kills by pid only if there's no response) |
| `agentacta --status` | Status check: is the service running, does the version on the port match the local package, is the widget open (exit code 0 = match / 1 = mismatch or unreachable / 2 = not running) |
| `agentacta --doctor` | Self-check that prints a **paste-ready report**: config parses, configured directories still exist, index shards intact and consistent, the port is running this version, page files present, current archive size (exit code 0 = no failures / 1 = failures). **Read-only** — changes neither data nor config |
| `agentacta --install-hooks [--dry] [--agent atomcode,claude]` | Write "auto-start on session launch" into atomcode / claude configs (idempotent, backs up before changing) |
| `agentacta --uninstall-hooks` | Remove the hooks written above |
| `agentacta --where` | Print its own install path + a copy-paste-ready hook command |
| `agentacta --archive` | Archive once: freeze finished log entries older than today, with detail snapshots, into `~/.agent-acta/archive/` (some agents delete their own logs — if you don't freeze them they're gone forever). A running service also archives daily on its own; this command is for manual catch-up/troubleshooting |
| `agentacta --archive --list` | List the archive without archiving |
| `agentacta --archive --dry` | Report what would be written without touching disk (can combine with `--list`) |
| `agentacta --search-reindex [--dry]` | Manually rebuild the full-text search index (what the page search box queries when you press **Enter**). Normally unneeded: the service builds the first pass 60s after startup, then runs incremental passes every 10 minutes. **Refuses to run while the service is up** (`--stop` first); `--dry` only counts |
| `agentacta-mcp` | Run as an **MCP server** (stdio): a read-only tool for clients like Claude / Cursor / Qoder — see the next section |
| `agentacta --version` / `-v` | Version + service-script fingerprint (to tell whether the port is running this build) |
| `agentacta --help` / `-h` | Usage |

Unknown arguments fail with exit code `2` instead of silently starting the service.

**After editing server code**: `agentacta --ensure` is the one step (it compares code fingerprints and restarts when they differ). Page-only edits just need a browser refresh.

## As an MCP server (let agents query their own logs)

`agentacta-mcp` is the second command shipped in the package; it exposes this machine's logs to clients as MCP tools. It is an **independent process that reads logs and indexes directly** — it does **not** connect to port 14570 and writes nothing, so it works whether or not the long-running service is up (after the initial handshake it does a full scan of the machine's logs, ~2s, logging nothing meanwhile).

Config snippet (replace the path with your actual install — `agentacta --where` prints it):

```json
{ "mcpServers": { "agent-acta": { "command": "node", "args": ["<install dir>/mcp-server.mjs"] } } }
```

| Tool | What it does |
|---|---|
| `overview` | Which agents exist, how many entries each, index freshness |
| `search_entries` | List turns by agent/project/time range (newest first, 50 by default) |
| `get_entry` | Full text of one entry by id (prompt, output, tool calls, LLM detail) |
| `list_sessions` | Grouped by session: how many turns, how many tokens, over what span |
| `usage_stats` | `by=day` daily / `by=model` per-model aggregates |
| `slowest_turns` | Slowest N turns + p50/p95 |
| `tool_fails` | Which tools fail / time out most (three-way ranking + per-agent coverage; timeouts count as failures, soft failures listed separately) |

Tool semantics come from the same aggregation functions as the page/HTTP API — not a separate implementation. Full docs and per-client configs are in the "As an MCP server" section of REFERENCE (Chinese-only for now).

## As a DSH plugin (the same panel inside DeepSeek Harness)

If you have [DeepSeek Harness](https://atomgit.com) (DSH) installed, you can install it as a Cordis plugin: an "AgentActa" icon appears in the left rail, opening a full panel in the center — the same Vue3 page (served in an iframe, with filters / details / SSE live push), **no extra browser tab or long-running service needed**.

```
dsh plugin --profile desktop add "@yxzpro/agent-acta"                      # npm package name
dsh plugin --profile desktop add "git+https://github.com/elegant01/agent-acta.git#v2.14.7"   # or straight from the repo
```

> The `@yxzpro/` scope exists because of npm's similarity rules: the bare `agent-acta` was rejected as too close to the existing `agentacta` (someone else's similar project, published 2026-02).
> **The product name is unchanged** — the command is still `agentacta`, and the repo, panel title and URL are all the same; only the npm identifier and DSH's bundle name follow the package name.

- `dsh plugin` forwards its argument verbatim to pnpm and accepts registry / git / tarball / path forms; for a plain file use `"file:C:/absolute/path/yxzpro-agent-acta-2.14.7.tgz"` instead (tarballs packed from a scoped package drop the `@` and turn `/` into `-`). ⚠ In Git Bash / PowerShell, **quote the whole argument** when the URL contains `#` or the package name contains `@`. Replace `v2.14.7` with the version you want (`git ls-remote --tags https://github.com/elegant01/agent-acta` lists them all).
- This project is released under the **MIT** license (see `LICENSE`); the code has no network egress and uploads no log content — it only reads files your agents already wrote to your own disk.
- **Fully quit DSH and start it again after installing** (all processes must exit — closing the window is not enough; the host has a module cache).
- If the icon doesn't show up, check these two first: ① the host gates plugin compatibility by semver (a mismatch just lands in `skippedBundles`, **no error** — the symptom is exactly "doesn't appear"); ② whether `--profile` points at the profile you actually use. Verified on **DSH 0.1.7-rc.2 / runtime 0.2.0-rc.1**.

**How it coexists with the CLI service** (the most-asked question): the plugin probes `127.0.0.1:14570` **on every request** (a ~1ms loopback probe, cached for 2s), so you don't have to choose:

| Port 14570 | What the panel gives you |
|---|---|
| Up | **Exactly that service's panel**, passed through in an iframe (data, SSE, write operations all work) — there is still only that one scanner on the machine, the plugin doesn't start another |
| Down | The plugin runs its own copy inside the host process (no port, no pid file, no idle self-stop) — the panel works as usual |

If the CLI exits mid-session, the panel switches to a small "CLI service has exited" page with a **let the plugin take over** button — it only starts when you click, never automatically: auto-starting could collide with you bringing the CLI back, creating two writers, and that decision belongs to a human.
You do **not** need to `agentacta --stop` or restart DSH just to view the panel (an earlier version made you do that — it was a bad experience and has been fixed).

**Boundaries** (deliberate, not omissions): the plugin doesn't launch the floating widget; the five routes `/` (the host's auth fallback slot), `/api/shutdown`, `/api/client`, `/api/trae/capture-key`, `/widget` are simply not registered in the host (so one misclick can't take the host process down); the panel keeps its own dark skin and doesn't follow the host's light/dark switching; the data path remains read-only-local with zero network egress. Details are in the "As a DSH plugin" section of REFERENCE.

## Page usage cheat sheet

Open <http://127.0.0.1:14570>:

- **Filters**: agent / project / time range (today / last 7 days / last 30 days, by local calendar day) / status / keyword
- **Full-text search**: **typing** in the search box = filter the current window only (instant, free); **pressing Enter** = search the whole store — it searches the **body** of each turn
  (user input + AI reply + tool args/results), across agents and across history not currently loaded, with **no time range applied by default** ("that error last week" is outside the default two days anyway).
  Results take over the card list with hit snippets highlighted; the top banner honestly reports "indexed A of B entries" and "no time range applied", and whether this round was cut off by the
  200-per-query cap ("only 200 returned this time"); tick "restrict to current time range" to narrow by the selected dates.
  The index is maintained incrementally in the background by the service (`~/.agent-acta/search/`); searchable about a minute after first launch
- **Cards**: click any card to expand user input, AI output, execution chain, LLM call detail and tool calls
- **Status badge top-right** = SSE connection state; click it to tune the refresh rate; the dropdown next to it enables "idle self-stop" (30 min / 2 h / 6 h, off by default)
- **Browse by session** (sidebar item 2): view full multi-turn evolution per session; dsh / zcode / trae sessions come with real timelines.
  Session names come from **the product's own titles** (I14: claude-family reads `ai-title` from transcripts, falling back to `last-prompt`; dsh / gemini /
  buddy / zcode / traedb / opencode / kilo / hermes / devin each have their own source); only when none exists does it fall back to the session key — **file names are never passed off as titles**
- **Sub-agent topology** (I16): sub-agent sessions indent with a `└` in the session list, and the parent's row shows "N turns total · x tok" (including itself);
  the top of the right pane has clickable **jump to parent / jump to children**. The criterion is an explicit lineage key from the source (dsh's `parentSession`, claude's `subagents/` directory +
  `.meta.json`, zcode/opencode's `session.parent_id`, hermes' `parent_session_id`) — **never guessed from time windows**
- **Unknown times are labeled honestly** (I16): turns whose timestamps can't be recovered (atomcode `.jsonl` files of 0 bytes / missing `turn_id`, 44.6% on this machine)
  no longer impersonate the session's `updated_at` — the card says "time unknown", and they stay out of per-day statistics (the stats dialog says how many turns were left out)
- **Usage stats** (the line-chart icon in the toolbar): per-day token & latency aggregates + per-model, following the current filters;
  the "latency analysis" dialog has four ranking sub-tabs — slowest turns / tool calls / cache hit rate / **tool-failure profile** (I6: which tools fail most,
  with a coverage table: which sources have no per-tool failure signal at all — blank there doesn't mean "never fails")
- **Export** (download icon in the toolbar → JSON / CSV / Excel): exports exactly the currently filtered list set, and **writes the filter conditions into the file**
  (first two rows of CSV, a note row in Excel, `meta.filters` in JSON) — so you can later prove "this batch was filtered by what". With a turn expanded,
  the detail footer also offers **export this turn's full detail** (via `/api/entry?full=1`; tool args/results are not truncated). Pure browser download; the server writes nothing to disk;
  semantics, column lists and "why Excel is SpreadsheetML" are in the "Export (R11)" section of REFERENCE.md
- **Two-turn compare** (the "compare" button on card top rows; click two cards and it opens automatically): side-by-side latency / model / LLM calls / tools / credits-or-tokens /
  context usage / compaction, each metric marked with "which is bigger" and by how much; the lower half is a field-by-field view of both turns' user input, AI output and tool calls (fetched on open).
  qoder only provides credits and percentages (it doesn't write tokens to disk, and printing 0 would read as "costs nothing"), so in mixed comparisons inapplicable cells show `—` and no diff is computed
- **Single-turn reproduction bundle** (the "export repro bundle" button in the card detail footer): one-click zip = that turn's **raw log segment** (cut with the parser's own turn-boundary rules,
  line numbers match disk) + the full parse result + four version fingerprints + the filter conditions at export time — attach it to a group chat / bug report as-is.
  The zip is hand-assembled in the browser (store mode, zero dependencies); **the server writes nothing and gains no network egress**; for the database / multi-frame-compressed sources
  where raw segments can't be cut, it falls back to "original path + full parse result" and says why
- **History archive** (sidebar item 4): browse the frozen entries in `~/.agent-acta/archive/` — after a product deletes its own logs (CodeArts keeps only ~30 days), the user input / AI output / tool-call detail from back then still opens here. **Read-only side path**, not affected by the left-side filters; bottom-left also has a row of **per-agent archive switches** (turn off the ones you don't want to keep)
- **Disk usage** (sidebar item 6): per-agent breakdown of "log directory / archive / index shards" and which is biggest — see the composition before cleaning (top level of `~/.agent-acta` listed item by item, including the widget's Electron runtime). **Counts only, never deletes**; traversal runs with a budget, and if it can't finish it says "partial count" instead of showing a fake complete number
- **Parser self-test** (the sidebar item of the same name): after changing parsing semantics, see how the last regression run went — each script under `test/` with its result (green / red / timeout), duration, and **which ones were skipped this time and why**, all on one page. Data comes from `~/.agent-acta/selftest.json` (written by `node test/selftest.mjs`); this page is **read-only and runs no tests in the browser**; when the results came from a different build, a yellow bar at the top warns "this green doesn't represent the current build"
- The switch next to each agent in the sidebar = temporarily disable (config kept); `✕` = remove that agent's config (local log files untouched); `+` = add manually
- **The icon button on the cursor row = install/uninstall the token-capture hook**: cursor transcripts contain no tokens; the only local per-turn usage
  comes from its own `stop` hook. One click (with confirmation) adds a command to `~/.cursor/hooks.json`, after which each turn's
  input/output/cache usage is captured into `~/.agent-acta/cursor-usage.jsonl` and attached back onto the cards; click again to uninstall.
  **It only adds its own entry and never touches your existing hooks**; if `hooks.json` isn't valid JSON it refuses rather than overwriting. Semantics in
  the cursor section of [LOGFORMATS.md](LOGFORMATS.md), API in `POST /api/cursor-hook` in [REFERENCE.md](REFERENCE.md)
- Desktop widget (the lightweight, no-Electron way):
  `msedge --app=http://127.0.0.1:14570/widget`, then pin on top with PowerToys

## Data & configuration

- Config: `~/.agent-acta/config.json` (old locations `~/.agent-log/`, `~/.atomcode/agent-log/` are migrated automatically at startup)
- Index: `~/.agent-acta/index/<kind>.json` (incremental offsets persisted; restarts don't rescan everything)
- Archive: `~/.agent-acta/archive/<agent>/<YYYY-MM-DD>.jsonl` + `manifest.json` (entry-level freezing, kept forever by default)
  - **Per-agent on/off switch**: click directly in the bottom-left of the "History archive" dialog (writes `archive.skip` in `config.json`, effective immediately, no restart);
    editing the config by hand works too: `"archive": { "skip": ["cursor"] }`. **Only stops future archiving; already-frozen files are kept**
  - The same section also supports `enabled` (disable automatic passes), `maxDays` / `maxMB` (caps; deletes whole-day files only). Details in the "History archive" section of REFERENCE
- Full-text index: `~/.agent-acta/search/<kind>.json` (the body of each turn, one record per source). **Maintained incrementally in the background by the service itself**
  (first pass 60s after startup, then every 10 minutes); no manual intervention needed; to rebuild manually use `agentacta --search-reindex` (run `--stop` first if the service is up).
  Real-machine reference numbers (evening of 2026-09-22, measured via `/api/search/status` on the long-running service): **648 sources / 5111 searchable entries** (that machine has 5431 in total;
  the rest either had their source files deleted by the product or had no body in that turn to begin with) → index about **24MB**.
  To lift the "index at most 8000 chars per body" cap, use the `AGENT_LOG_SEARCH_MAX_CHARS` environment variable
  - Records recognize sources by **absolute path**, so after moving `~/.agent-acta` to another machine/platform, records that don't match
    this machine are pruned and rescanned on load (both the log and `/api/search/status.pruned` report the numbers). On POSIX, `search/` `index/` `archive/`
    are all created private (`0700`/`0600` — they contain plaintext conversations); existing files are left alone — to lock everything down at once, `chmod -R go-rwx ~/.agent-acta`
- Port: defaults to `14570`, overridable with `AGENT_LOG_PORT`
- pid file: `~/.agent-acta/server-<port>.pid`

## Server HTTP API

| Endpoint | What it does |
|---|---|
| `GET /` | The page |
| `GET /widget` | Desktop widget page (SSE live refresh) |
| `GET /api/ping` | Liveness probe |
| `GET /api/version` | `{version, build, pid}`; build = content fingerprint of the service script |
| `GET /api/agents` · `POST /api/agents` · `DELETE /api/agents?name=` · `POST /api/agents/toggle` | CRUD for agent configs |
| `GET /api/diagnose` | Environment diagnosis: probe results and unrecognized reasons for every candidate path of every candidate agent |
| `GET /api/usage?force=1` | Disk usage: per-agent log/archive sizes + index shards + top-level composition of `~/.agent-acta` (results cached 60s; `force=1` bypasses) |
| `GET /api/selftest` | Results of the last regression self-test (passes `~/.agent-acta/selftest.json` through with three honest labels: `ageMs` / `sameBuild` / `sameParserRev`). **Runs no tests**; returns `ok:false` with a `hint` when never run |
| `GET /api/snapshot?limit&agent=&project=&range=&scan=1` | Entry snapshot (the list's main data) |
| `GET /api/daily` | Per-calendar-day token/latency aggregates (ignores limit; covers the whole filtered set) |
| `GET /api/models` | Per-model aggregates (same parameters) |
| `GET /api/analyze?range=&agent=&project=&from=&to=&top=` | Ranking analysis: `slowest` / `p50` / `p95` / `byTools` (tool calls per turn) / `byCacheRate` + `toolFails` (**I6 tool-failure profile**: `rows` gives `fail/total/rate` per agent×tool, `agents` gives coverage and "not indexed" counts). `top` caps at 50, default 10 |
| `GET /api/entry?id=&full=1` | Single-turn detail (dsh/zcode/traedb additionally return per-event `events[]`) |
| `GET /api/search?q=&re=1&agent=&project=&status=&from=&to=&limit=&offset=` | **Full-text search** (what the page search box hits on Enter). `from`/`to` are only sent when "restrict to current time range" is ticked — **omitted = no time limit**; each entry's `_snip` is the hit snippet (three plain-text segments; the page escapes them itself before highlighting). Empty `q` and invalid regexes get a 400 with the reason spelled out |
| `GET /api/search/status` | Full-text index coverage: `{entries, files, total, building, unreadable, noState, bytes, at, maxChars}` — the page banner "indexed A of B entries" uses the first four |
| `GET /api/sessions` · `GET /api/session?key=` | Session list and session detail ("browse by session") |
| `GET /api/events` | SSE: hello / update / remove / agents / settings / resync / scanning |
| `GET /api/settings` · `POST /api/settings` | Scan cadence / idle self-stop |
| `GET /api/ctxwindows` · `POST /api/ctxwindows` | Context-window table (the denominator of the claude/kimi progress bars) |
| `GET /api/archive/index` | Archive listing: `{root, days[], agents[], totals, skip[], configAgents[]}` (`skip` / `configAgents` feed the "archive switches" list) |
| `POST /api/archive/skip` | Per-agent archive switch: `{agent, skip}` → updates `config.archive.skip`, effective immediately |
| `GET /api/archive/entries?agent&day&q&limit&offset` | Archived entry list (**without** details, only a `hasDetail` flag) |
| `GET /api/archive/entry?agent&day&id` | One frozen detail snapshot (404 when gone) |
| `POST /api/shutdown` | Graceful shutdown (flush index, then exit) |

Per-endpoint field details and semantics are in the "Server HTTP API" section of [REFERENCE.md](REFERENCE.md).

## Packaging & distribution (developers)

```bash
mkdir -p ../dist
npm pack --pack-destination ../dist   # → dist/agent-acta-<version>.tgz (bump package.json's version first)
node test/pack-smoke.mjs              # smoke: unpack → run in an isolated env → probe every endpoint
```

Regression/acceptance scripts live in `test/` (with fixtures, repeatable). Run them all and view results on the page:

```bash
node test/selftest.mjs                 # default list (the ones that need nothing outside the repo), ~2 min serial
node test/selftest.mjs --only parser   # only names matching (prefix or title contains the word)
node test/selftest.mjs --group parser  # only one group: static / parser / cli / release / real / parity / slow
node test/selftest.mjs --all           # including groups that are off by default (depends on the machine)
```

Results are written to `~/.agent-acta/selftest.json` — that's what the sidebar "Parser self-test" page reads (details in the "Parser self-test" section of REFERENCE).

The distributed tgz **is also the DSH plugin package**: `files` includes `plugin/`, and the loading contract lives entirely in `package.json` — `exports["."]` lets the host dynamically import the server shell, `dsh.bundle.patch` points at `plugin/cordis.patch.yml`, `dsh.client.inject` lists the two host UI packages (miss them and it installs but the icon never appears). So after bumping the version, also check: `plugin/client.js` **must have no top-level `import`/`export`** (the host splices it verbatim into a plain `<script>`; ESM syntax there takes the whole DSH startup down).

## Troubleshooting quick reference

- **No idea where to start**: `agentacta --doctor` — one pass listing the state of config / directories / indexes / port version / page files / archive; paste the whole output (**read-only**, changes nothing)
- **Page won't open / stuck on "reconnecting…"**: `curl http://127.0.0.1:14570/api/ping`; if there's no response, run `agentacta --ensure`
- **New endpoints 404 after upgrading/editing code**: the port is serving an old build — restart with `agentacta --ensure` (the criterion: the `build` fingerprint from `GET /api/version`; `--doctor` reports exactly this as `[fail]`)
- **An agent stays at 0 entries**: see the sidebar "Environment diagnosis" or `GET /api/diagnose`
- **Switching to mac / Linux (or another machine)**: just move `~/.agent-acta` over — indexes re-validate against this machine's disk and rebuild,
  stale records prune themselves; **manually added** agent roots in `config.json` stay forever with 0 entries, and `--doctor` names them and hints
  "these are Windows-shaped paths" — delete those entries and let auto-discovery re-detect. trae's key grabbing is Windows-only, so after switching
  platforms its tokens and AI bodies are unavailable. Details in the "Cross-platform" section of [REFERENCE.md](REFERENCE.md)
- **trae shows no tokens / AI bodies**: the SQLCipher database needs a per-machine key; grab it with `tools/grab-trae-key.ps1` and fill in `traeKey` — steps in the "Trae's SQLCipher database" section of [REFERENCE.md](REFERENCE.md)
- More troubleshooting (codex user input empty, atomcode datalog, hook verification pipe stalls, source edits not taking effect, etc.) in the "FAQ" section of [REFERENCE.md](REFERENCE.md)
