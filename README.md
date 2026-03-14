# ragbox

Structure-first RAG for Markdown/MDX folders.

`ragbox` indexes a docs folder into local PageIndex JSON files, then answers questions from that index with an OpenAI-compatible chat model. It keeps one PageIndex tree per source file and one folder-level `root-tree.json` for document selection.

[中文文档](./README.zh-CN.md)

## Install

```bash
npm install -g @bndynet/ragbox
```

## Requirements

- Node.js 18 or newer.
- A local PageIndex Python script, usually `run_pageindex.py`.
- An OpenAI-compatible `/chat/completions` endpoint.
- An API key for that endpoint.
- A source folder containing `.md` or `.mdx` files.

`ragbox` does not install PageIndex. Point `PAGEINDEX_CLI` to your local PageIndex script.

## Quick Start

```bash
export PAGEINDEX_CLI=/path/to/PageIndex/run_pageindex.py
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1

ragbox index ./docs --output-dir ./.ragbox-index
ragbox query ./.ragbox-index "How do I configure authentication?"
ragbox watch ./docs --output-dir ./.ragbox-index
```

You can also pass the same model service settings as flags on `index`, `watch`, or `query`:

```bash
ragbox index ./docs \
  --output-dir ./.ragbox-index \
  --api-key sk-... \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini

ragbox query ./.ragbox-index "How do I configure authentication?" \
  --api-key sk-... \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini
```

## Project Config

Create a project config:

```bash
ragbox init
```

This writes `ragbox.config.json`:

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "/path/to/PageIndex/run_pageindex.py"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "docs": {
    "rootDir": "./docs",
    "outputDir": "./.ragbox-index"
  }
}
```

Relative paths in the config are resolved from the config file directory. CLI flags override config values. API keys should usually stay in environment variables instead of `ragbox.config.json`.

For one documentation source, use the top-level `docs` object. No `--source` flag is needed. If a project needs multiple named sources, use the optional `sources` map.

Use the configured docs:

```bash
ragbox index
ragbox query "How do I configure authentication?"
ragbox watch --jsonl
ragbox --config ./ragbox.config.json index
```

For multiple documentation directories, name each one under `sources`:

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "/path/to/PageIndex/run_pageindex.py"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini"
  },
  "sources": {
    "docs": {
      "rootDir": "./docs",
      "outputDir": "./.ragbox-index/docs"
    },
    "api": {
      "rootDir": "./packages/api/docs",
      "outputDir": "./.ragbox-index/api"
    },
    "web": {
      "rootDir": "./apps/web/content",
      "outputDir": "./.ragbox-index/web",
      "include": ["**/*.md", "**/*.mdx"],
      "exclude": ["**/draft/**"]
    }
  }
}
```

A runnable copy of this multi-source layout lives in `./examples/ragbox.config.json`.

Index named sources separately, then query globally or narrow to selected sources:

```bash
ragbox index --source docs
ragbox index --source api
ragbox index --source web

ragbox query "What are the deployment steps?"
ragbox query --source api "How do I configure authentication?"
ragbox query --source docs,api "How does authentication work end to end?"
ragbox query --all-sources "What are the deployment steps?"
```

When multiple sources are configured, `ragbox query "..."` queries all of them. `--all-sources` is an explicit alias for the same behavior; use `--source` to limit the search.

You can keep environment-specific files too:

```bash
ragbox --config prod index
ragbox --config ./ragbox.config.prod.json query "How do I deploy?"
```

## Configuration

Resolution order is command-line flags, then `ragbox.config.json`, then environment variables, then defaults.

| Setting | Env | CLI flag | Used by | Default |
| --- | --- | --- | --- | --- |
| PageIndex script | `PAGEINDEX_CLI` | none | `index`, `watch` | required when indexing |
| Python executable | `PAGEINDEX_PYTHON` | `--pageindex-python` | `index`, `watch` | `python3` |
| Output directory | `RAGBOX_OUTPUT_DIR` | `--output-dir` | `index`, `watch` | `<folder>/.pageindex` |
| Concurrency | `PAGEINDEX_CONCURRENCY` | `--concurrency` | `index`, `watch` | `1` |
| API base URL | `OPENAI_BASE_URL` | `--base-url` | `index`, `watch`, `query` | `https://api.openai.com/v1` |
| API key | `OPENAI_API_KEY` | `--api-key` | `index`, `watch`, `query` | required for query and usually PageIndex |
| Model | `PAGEINDEX_MODEL`, `LLM_MODEL` | `--model` | `index`, `watch`, `query` | `gpt-4o-mini` |
| Serve host | `RAGBOX_SERVE_HOST` | `--host` | `serve` | `127.0.0.1` |
| Serve port | `RAGBOX_SERVE_PORT` | `--port` | `serve` | `8787` |
| Serve token | `RAGBOX_SERVE_TOKEN` | `--auth-token` | `serve` | none |
| Watch debounce | `RAGBOX_WATCH_DEBOUNCE_MS` | `--debounce-ms` | `watch` | `500` |
| Watch retry attempts | `RAGBOX_WATCH_RETRY_ATTEMPTS` | `--retry-attempts` | `watch` | `0` |
| Watch retry delay | `RAGBOX_WATCH_RETRY_DELAY_MS` | `--retry-delay-ms` | `watch` | `1000` |
| Watch lock file | `RAGBOX_WATCH_LOCK_FILE` | `--lock-file` | `watch` | none |
| Watch staging | `RAGBOX_WATCH_STAGING` | `--staging` | `watch` | off |
| Watch staging output | `RAGBOX_WATCH_STAGING_OUTPUT_DIR` | `--staging-output-dir` | `watch` | `<outputDir>.staging` |
| Watch health file | `RAGBOX_WATCH_HEALTH_FILE` | `--health-file` | `watch` | none |
| Watch webhook | `RAGBOX_WATCH_WEBHOOK_URL` | `--webhook` | `watch` | none |

For production, prefer environment variables or a secret manager for API keys. Passing `--api-key` is useful for local testing, but command-line secrets can appear in shell history and process listings.

## Commands

### `ragbox init`

Creates a `ragbox.config.json` file.

```bash
ragbox init
ragbox init --docs-dir ./content --output-dir ./.idx
ragbox init --output ./configs/ragbox.config.json --force
```

### `ragbox index <folder>`

Indexes Markdown/MDX files.

```bash
ragbox index ./docs
ragbox index ./docs --output-dir ./.ragbox-index
ragbox index ./docs --output-dir ./.ragbox-index --json
ragbox index ./docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox index ./docs --pageindex-python /opt/venvs/pageindex/bin/python
ragbox index ./docs --base-url https://api.openai.com/v1 --model gpt-4o-mini
```

`index` scans `**/*.md` and `**/*.mdx`, hashes files, re-indexes new/modified/failed files, skips unchanged ready files, and removes deleted files from the manifest.

Use `--json` to print a versioned machine-readable result with output paths and counts:

```json
{
  "version": 1,
  "command": "index",
  "rootDir": "/repo/docs",
  "outputDir": "/repo/.ragbox-index",
  "manifestPath": "/repo/.ragbox-index/manifest.json",
  "rootTreePath": "/repo/.ragbox-index/root-tree.json",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "counts": {
    "total": 12,
    "ready": 12,
    "failed": 0,
    "added": 12,
    "modified": 0,
    "retryFailed": 0,
    "unchanged": 0,
    "deleted": 0
  }
}
```

### `ragbox inspect [target]`

Prints manifest and document-level details for an index.

```bash
ragbox inspect ./.ragbox-index
ragbox inspect --source api
ragbox inspect --all-sources --json
```

### `ragbox status [target]`

Validates local index files and reports whether each target is query-ready.

```bash
ragbox status ./.ragbox-index
ragbox status --all-sources
ragbox status --json
```

### `ragbox doctor [target]`

Runs local diagnostics for config, PageIndex CLI configuration, LLM settings, API key presence, and index validity. It does not call the network.

```bash
ragbox doctor
ragbox doctor --source docs --json
ragbox doctor --all-sources
```

### `ragbox query [target] <question>`

Answers from either a docs folder with a default `.pageindex` index, or an existing ragbox output directory.

```bash
ragbox query ./docs "How do I configure authentication?"
ragbox query ./.ragbox-index "What are the deployment steps?"
ragbox query ./docs/.pageindex "How do I configure authentication?"
ragbox query ./.ragbox-index "How do I configure authentication?" --model gpt-4o-mini --api-key sk-...
ragbox query ./.ragbox-index "How do I configure authentication?" --json
ragbox query ./.ragbox-index "How do I configure authentication?" --trace
ragbox trace query ./.ragbox-index "How do I configure authentication?"
ragbox query "What are the deployment steps?"
ragbox query --source docs,api "How does authentication work end to end?"
ragbox query --all-sources "What are the deployment steps?"
```

Use the same `--base-url` value that you use for indexing. It should normally be the OpenAI-compatible root, such as `https://api.openai.com/v1`; `query` also accepts a full `/chat/completions` URL for proxy setups that require it.

When passing an explicit target, it can be:

- a docs folder containing `.pageindex/manifest.json` and `.pageindex/root-tree.json`
- an output directory containing:

```text
manifest.json
root-tree.json
indexes/
```

`query` reads `root-tree.json`, asks the LLM to choose likely documents, reads their PageIndex JSON, strips `text` fields before node selection, then extracts the selected node text for the final answer.

For multiple configured sources, `ragbox query "..."` queries all sources by default. Pass comma-separated names with `--source` to limit the search, or use `--all-sources` when you want the global behavior to be explicit. Multi-source query runs the normal structured query flow per source, then asks the LLM to synthesize one final answer from the selected source excerpts. Source references are prefixed with the source name, for example `api:auth.md#n1`.

Use `--json` to print a versioned result contract. Single-source queries return `QueryResult`; multi-source queries return a result with a fused `answer`, per-source `results`, prefixed `sources`, `warnings`, and `timingsMs`.

Single-source `QueryResult` fields:

- `answer`: final answer text
- `contextBytes` and `contextTokens`: size of the final answer context; tokens are estimated
- `selectedDocuments`: document ids selected from `root-tree.json`, including `selectionReason` and optional `skipReason`
- `selectedNodes`: PageIndex nodes selected per document, including `selectionReason`, optional `skipReason`, and `textBytes`
- `sources`: source references and extracted node text used as answer context
- `warnings`: unavailable documents, missing nodes, or empty context
- `timingsMs`: resolve, selection, and answer timings
- `trace`: only present with `--trace` or `ragbox trace query`; includes raw document/node selection LLM responses, prompt/response byte counts, context size, and non-fatal failure records

Fatal query errors include the stage that failed, for example `Query failed during select-documents: ...`.

### `ragbox serve [target]`

Starts a foreground HTTP server for external systems. Index first with `ragbox index`, or keep the index fresh with `ragbox watch`.

```bash
ragbox serve ./.ragbox-index \
  --host 127.0.0.1 \
  --port 8787 \
  --auth-token dev-token
```

For multiple configured sources, serve the config instead of a single target:

```bash
ragbox serve --config ./ragbox.config.json --host 0.0.0.0 --port 8787
```

Public HTTP contract:

- `GET /health`: public readiness endpoint for load balancers, Kubernetes, systemd, and smoke checks. Returns 200 when all known indexes are query-ready, otherwise 503.
- `GET /indexes`: returns the current validated index snapshot. Requires `Authorization: Bearer <token>` when a token is configured.
- `POST /query`: answers from one target, selected sources, or all configured sources. Requires auth when configured.
- `POST /reload`: re-reads config/source targets and refreshes the server-side validation snapshot. Requires auth when configured.

Single-index requests:

```bash
curl http://127.0.0.1:8787/health

curl -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:8787/indexes

curl -X POST http://127.0.0.1:8787/query \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"question":"How do I configure authentication?","trace":true}'
```

Multi-source requests:

```bash
curl -X POST http://localhost:8787/query \
  -H "Content-Type: application/json" \
  -d '{"source":"api","question":"How does OAuth work?"}'

curl -X POST http://localhost:8787/query \
  -H "Content-Type: application/json" \
  -d '{"source":["docs","api"],"question":"How does authentication work end to end?"}'

curl -X POST http://localhost:8787/query \
  -H "Content-Type: application/json" \
  -d '{"allSources":true,"question":"What are the deployment steps?"}'

curl -X POST http://localhost:8787/reload
```

`serve` is designed for local services, internal services, container sidecars, and docs backends. Do not expose `.ragbox-index` as static files, because it can contain source document text. Browser widgets should call your own backend first; the backend can enforce user auth, rate limits, and audit logging before forwarding requests to `ragbox serve`. In production, bind to localhost or an internal network address and configure `--auth-token` or `RAGBOX_SERVE_TOKEN`.

### `ragbox watch <folder>`

Runs an initial index and keeps it updated.

```bash
ragbox watch ./docs
ragbox watch ./docs --output-dir ./.ragbox-index
ragbox watch ./docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox watch ./docs --base-url https://api.openai.com/v1 --model gpt-4o-mini
ragbox watch ./docs --output-dir ./.ragbox-index --jsonl
ragbox watch ./docs \
  --output-dir /var/lib/ragbox/docs-index \
  --staging \
  --retry-attempts 3 \
  --retry-delay-ms 2000 \
  --lock-file /var/run/ragbox/docs.lock \
  --health-file /var/run/ragbox/docs-health.json \
  --jsonl
```

Watch mode listens for Markdown/MDX add, change, and unlink events. It ignores `node_modules`, `.git`, `.pageindex`, `dist`, `build`, and a custom output directory when it is inside the watched root.

Use `--jsonl` to stream versioned JSON Lines events for integrations. The stream includes `watch-start`, `watch-lock-acquired`, `watch-file-event`, `watch-index-start`, `watch-index-retry`, `watch-index-partial-failure`, `watch-output-promoted`, `watch-index-done`, `watch-index-failed`, `watch-health`, `watch-webhook-failed`, `watch-lock-released`, `watch-stop`, and `index-progress` events.

Production watch options:

- `--retry-attempts` and `--retry-delay-ms` retry thrown index errors and runs that leave failed documents.
- `--lock-file` creates an exclusive lock while watch is running. A second watcher exits if the lock already exists.
- `--staging` indexes into a staging directory and only promotes it after a clean run with zero failed documents. The default staging directory is `<outputDir>.staging`; keep it on the same filesystem as `outputDir` for rename-based promotion.
- `--health-file` writes a readiness JSON file with `status`, `ok`, `pid`, `lastSuccessAt`, `lastFailureAt`, and latest counts.
- `--webhook` POSTs every watch event as JSON. Webhook delivery failures are reported as `watch-webhook-failed` events and do not stop watch.
- `--debounce-ms` controls how long watch waits after file changes before reindexing.

`ragbox watch` intentionally runs in the foreground, which works well as a systemd service or container process. Use your supervisor's restart policy instead of shell-level daemonization.

## Output

Default output:

```text
docs/.pageindex/
  manifest.json
  root-tree.json
  indexes/
    <stable-doc-id>.pageindex.json
  state/
    file-state.json
```

Custom output:

```bash
ragbox index ./docs --output-dir ./.ragbox-index
ragbox query ./.ragbox-index "..."
```

The output directory can contain source document text. Do not serve it publicly if your docs are private.

## Production

Common patterns:

- Index during deploy, then serve/query the completed output directory with `ragbox serve` or SDK calls.
- Run `ragbox watch` as a background service if docs change outside deploys.
- For long-running watch, prefer `--jsonl`, `--lock-file`, `--health-file`, `--retry-attempts`, and `--staging`.
- Store the output directory outside the source tree, for example `/var/lib/ragbox/docs-index`.
- Mount or copy the completed output directory to every app replica that needs querying.
- Keep API keys in environment variables or your secret manager.
- Use `RAGBOX_SERVE_TOKEN` or `--auth-token` when `serve` is reachable beyond localhost.
- Start with `--concurrency 1`; raise it only after checking PageIndex and API rate limits.

Example deploy-time indexing:

```bash
export PAGEINDEX_CLI=/opt/PageIndex/run_pageindex.py
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1

ragbox index /srv/app/docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox query /var/lib/ragbox/docs-index "How do I configure authentication?"
```

SDK use:

```js
const {
  createIndex,
  inspectIndex,
  queryIndex,
  startServe,
  validateIndex,
  watchIndex
} = require("@bndynet/ragbox");

await createIndex("/srv/app/docs", {
  configPath: "./ragbox.config.json",
  outputDir: "/var/lib/ragbox/docs-index",
  pageIndexCli: "/opt/PageIndex/run_pageindex.py"
});

const result = await queryIndex(
  "/var/lib/ragbox/docs-index",
  "How do I configure authentication?"
);

console.log(result.answer);
console.log(result.sources);

const validation = await validateIndex("/var/lib/ragbox/docs-index");
console.log(validation.ok);

const server = await startServe({
  target: "/var/lib/ragbox/docs-index",
  port: 8787,
  authToken: process.env.RAGBOX_SERVE_TOKEN
});
console.log(server.url);
await server.close();

const inspect = await inspectIndex("/var/lib/ragbox/docs-index");
console.log(inspect.counts);

const watcher = await watchIndex("/srv/app/docs", {
  outputDir: "/var/lib/ragbox/docs-index",
  pageIndexCli: "/opt/PageIndex/run_pageindex.py",
  onEvent: (event) => console.log(event)
});
await watcher.ready;
await watcher.close();
```

The package root exports the product SDK API. Lower-level helpers are still available under `advanced` for custom integrations:

```js
const { advanced } = require("@bndynet/ragbox");

const location = await advanced.resolveQueryIndexLocation("/var/lib/ragbox/docs-index");
```

## How It Works

`ragbox` starts from document structure:

- one Markdown/MDX file -> one PageIndex tree
- one docs folder -> one `manifest.json` and one `root-tree.json`
- query flow -> select documents, select PageIndex nodes, answer from selected node text

No vector database is required for the basic flow. For Markdown indexing, ragbox asks PageIndex to include `node_id` and `text` by default. During query, `text` is stripped from the node-selection prompt and only added back for the final answer context.

## Compared With Vector DB RAG

Traditional vector RAG usually chunks documents, embeds chunks, and retrieves by vector similarity. `ragbox` preserves the source document hierarchy and lets the LLM select over that structure.

| Area | Vector DB RAG | `ragbox` |
| --- | --- | --- |
| Index unit | Text chunks | Markdown/MDX file plus PageIndex nodes |
| Retrieval signal | Embedding similarity | LLM selection over document and node trees |
| Storage | Vector database plus document store | Local JSON files under the output directory |
| Context shape | Flat retrieved chunks | Structured nodes with file paths and node ids |
| Strength | Fast fuzzy recall across large collections | Preserves document hierarchy and source references |
| Tradeoff | Requires embedding/index infrastructure | Depends on PageIndex quality and LLM selection |

The two approaches can also be combined: use vector search for broad candidate recall, then use PageIndex trees for structured filtering, context packing, and citations.

## Troubleshooting

- `PAGEINDEX_CLI is required to run PageIndex`: set `PAGEINDEX_CLI=/path/to/run_pageindex.py`.
- `OPENAI_API_KEY is required for query`: set `OPENAI_API_KEY` or pass `--api-key`.
- `Expected a docs folder... or a ragbox output directory`: pass either the docs folder with `.pageindex/`, or the output directory itself.
- `PageIndex completed but no generated JSON result was found`: if your PageIndex CLI does not use the default `--output` flag, set `PAGEINDEX_OUTPUT_ARG` to the supported output-path flag.

## Limitations

- PageIndex must already be installed/configured locally.
- Query quality depends on PageIndex JSON shape and the configured LLM.
- The basic flow uses tree selection, not vector search.

## Local Development

```bash
npm install
npm run build
npm run ragbox -- --help
```

### Real E2E Validation

Use the helper script:

```bash
cp .env.e2e.local.example .env.e2e.local 2>/dev/null || true
npm run test:e2e
```

`npm run test:e2e` runs `./scripts/e2e.sh`, which reads `.env.e2e.local`. Or edit/export the variables directly before running it:

```bash
export RAGBOX_E2E=1
export PAGEINDEX_CLI=/path/to/PageIndex/run_pageindex.py
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1
export PAGEINDEX_MODEL=gpt-4o-mini
export RAGBOX_E2E_QUERY_MODEL=gpt-4o-mini
export RAGBOX_E2E_DOCS_DIR=./examples
export RAGBOX_E2E_OUTPUT_DIR=./examples/.pageindex
export RAGBOX_E2E_EXPECTED_TEXT=PKCE
export RAGBOX_VERBOSE=1

# Optional:
export RAGBOX_E2E_PAGEINDEX_PYTHON=/path/to/python
export RAGBOX_E2E_HEARTBEAT_MS=10000
export RAGBOX_E2E_COMMAND_TIMEOUT_MS=300000

npm run test:e2e
```

`.env.e2e.local` is ignored by git. Use `npm run test:e2e:raw` only when you intentionally want to bypass the helper script.

The test defaults to `./examples`, runs `ragbox index ./examples --output-dir ./examples/.pageindex`, queries the generated JSON directory, then queries the docs directory itself. It prints live stage logs, per-document index progress, query progress, and heartbeat lines while long commands are still running. `./examples` contains a small multi-source fixture with `docs`, `api`, and `web` directories; for a faster OAuth-only check, set `RAGBOX_E2E_DOCS_DIR=./examples/packages/api/docs/authentication`.

The default e2e question is intentionally fuzzy: "What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk?" The final answer is printed in the e2e log for both the output-directory query and the docs-directory query.
