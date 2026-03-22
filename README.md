# ragbox

Ask questions about your Markdown/MDX docs from the terminal, an HTTP service, or a Node.js app.

`ragbox` turns a documentation folder into a local queryable index. You can use it to search product docs, API guides, runbooks, internal handbooks, and multi-package docs without setting up a vector database.

Use `ragbox` when you want to:

- answer questions from a local docs folder
- inspect which docs and sections were used for an answer
- keep an index fresh while docs change
- expose docs Q&A to an internal backend through HTTP
- run the same workflow locally, in CI, and in a container

[中文文档](./README.zh-CN.md)

## Quick Start

The default path is meant to work out of the box: install `ragbox`, let it prepare PageIndex locally, then index and query your docs.

```bash
# Install the CLI.
npm install -g @bndynet/ragbox

# Clone PageIndex into ./.ragbox/PageIndex, create a Python venv,
# install PageIndex dependencies, and write ragbox.config.json.
ragbox setup pageindex
```

Before continuing, edit `ragbox.config.json`: add your model settings and point `docs.rootDir` / `docs.outputDir` at your documentation and index locations.

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "./.ragbox/PageIndex/run_pageindex.py",
    "python": "./.ragbox/pageindex-venv/bin/python"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "sk-..."
  },
  "docs": {
    "rootDir": "./docs",
    "outputDir": "./.ragbox-index"
  }
}
```

If you have more than one docs folder, use the `sources` map described in [Project Config](#project-config). Then index and query:

```bash
# Build the local index from the configured docs/source.
ragbox index

# Ask a question.
ragbox query "How do I configure authentication?"

# Optional: keep the index fresh while docs change.
ragbox watch --jsonl
```

Use `start` when you want one foreground process for indexing, watching, and serving the query API:

```bash
ragbox start
```

You can still pass explicit paths when you want to override the config for one command:

```bash
ragbox index ./docs --output-dir ./.ragbox-index
ragbox query ./.ragbox-index "How do I configure authentication?"
```

If you do not want to store credentials in JSON, the same model settings can be supplied with environment variables or flags:

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1

ragbox index ./docs \
  --output-dir ./.ragbox-index \
  --model gpt-4o-mini

ragbox query ./.ragbox-index "How do I configure authentication?" \
  --api-key sk-... \
  --base-url https://api.openai.com/v1 \
  --model gpt-4o-mini
```

## What Setup Does

`ragbox setup pageindex` prepares the local PageIndex dependency for you:

- clones PageIndex into `./.ragbox/PageIndex`
- creates `./.ragbox/pageindex-venv`
- installs PageIndex Python dependencies
- writes `pageIndex.cli` and `pageIndex.python` into `ragbox.config.json`
- adds `.ragbox/` to `.gitignore`

If you already have a PageIndex checkout, use `ragbox setup pageindex --dir ../PageIndex --skip-install`, or set `PAGEINDEX_CLI` manually.

## Requirements

The default setup needs:

- Node.js 18 or newer
- Git, for cloning PageIndex
- Python 3 with `venv` and `pip`, for PageIndex dependencies
- a docs folder containing `.md` or `.mdx` files
- an OpenAI-compatible `/chat/completions` endpoint
- an API key for that endpoint

## Common Workflows

| Goal | Use |
| --- | --- |
| Start from nothing | `npm install -g @bndynet/ragbox`, then `ragbox setup pageindex` |
| Try ragbox on one docs folder | `ragbox index ./docs --output-dir ./.ragbox-index`, then `ragbox query ./.ragbox-index "..."` |
| Avoid repeating paths | use the `ragbox.config.json` written by `ragbox setup pageindex`, or run `ragbox init` |
| Query several docs folders together | Configure `sources`, run `ragbox index --source <name>`, then `ragbox query --all-sources "..."` |
| Debug answer quality | `ragbox query --trace --json "..."` or `ragbox trace query "..."` |
| Check whether an index is usable | `ragbox status ./.ragbox-index` |
| Diagnose local setup issues | `ragbox doctor` |
| Keep docs indexed while editing | `ragbox watch ./docs --output-dir ./.ragbox-index --jsonl` |
| Run the full local service loop | `ragbox start --auth-token <token>` |
| Serve an already-built index only | `ragbox serve ./.ragbox-index --auth-token <token>` |

## Project Config

`ragbox setup pageindex` creates or updates `ragbox.config.json` for the default local setup. After adding your model credentials, a typical config looks like this:

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "./.ragbox/PageIndex/run_pageindex.py",
    "python": "./.ragbox/pageindex-venv/bin/python"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "sk-..."
  },
  "docs": {
    "rootDir": "./docs",
    "outputDir": "./.ragbox-index"
  }
}
```

You can also create a config without installing PageIndex:

```bash
ragbox init
ragbox init --docs-dir ./content --output-dir ./.idx
```

Relative paths are resolved from the config file directory. Server-side deployments can keep `baseUrl`, `model`, and `apiKey` together in a private `ragbox.config.json` or environment-specific config such as `ragbox.config.prod.json`. If a config file is committed or shared, keep `apiKey` in environment variables or a secret manager instead.

For one documentation source, use the top-level `docs` object. No `--source` flag is needed. If a project needs multiple named sources, use the optional `sources` map.

After that, commands can use the configured docs automatically:

```bash
ragbox index
ragbox query "How do I configure authentication?"
ragbox watch --jsonl
ragbox start
ragbox --config ./ragbox.config.json index
```

For multiple documentation directories, name each one under `sources`. This is useful for monorepos, product docs plus API docs, or separate app/package documentation:

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "./.ragbox/PageIndex/run_pageindex.py",
    "python": "./.ragbox/pageindex-venv/bin/python"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "sk-..."
  },
  "sources": {
    "ragbox": {
      "rootDir": "./ragbox",
      "outputDir": "./.ragbox-index/ragbox",
      "include": ["**/*.md", "**/*.mdx"]
    },
    "icharts": {
      "rootDir": "./icharts",
      "outputDir": "./.ragbox-index/icharts",
      "include": ["**/*.md", "**/*.mdx"]
    }
  }
}
```

A runnable copy of this multi-source layout lives in `./examples/ragbox.config.json`.

Index named sources separately, then query globally or narrow to selected sources:

```bash
ragbox index --source ragbox
ragbox index --source icharts

ragbox query "What does ragbox start do?"
ragbox query --source ragbox "How does query tracing work?"
ragbox query --source ragbox,icharts "How do these projects handle runtime workflows?"
ragbox query --all-sources "What documentation topics are available?"
ragbox start --all-sources
```

When multiple sources are configured, `ragbox query "..."` queries all of them. `--all-sources` is an explicit alias for the same behavior; use `--source` to limit the search.

You can keep environment-specific files too:

```bash
ragbox --config prod index
ragbox --config ./ragbox.config.prod.json query "How do I deploy?"
```

## Configuration

For server-side use, keep the stable settings in `ragbox.config.json`: PageIndex paths, docs paths, LLM `baseUrl`, `model`, and, when the file is private, `apiKey`. Environment variables and CLI flags are still supported for overrides, secret managers, and one-off runs.

Resolution order is command-line flags, then `ragbox.config.json`, then environment variables, then defaults.

| Setting | Env | CLI flag | Used by | Default |
| --- | --- | --- | --- | --- |
| PageIndex script | `PAGEINDEX_CLI` | `ragbox setup pageindex` writes config | `index`, `watch` | required when indexing |
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

For private server config, putting `llm.apiKey` in JSON keeps the deployment self-contained. For shared repositories, containers, or managed secret stores, leave `apiKey` out of JSON and provide `OPENAI_API_KEY` at runtime. Passing `--api-key` is useful for local testing, but command-line secrets can appear in shell history and process listings.

## Commands

Use this section as a command reference. If you are new to `ragbox`, start with [Quick Start](#quick-start) and [Common Workflows](#common-workflows).

### `ragbox setup pageindex`

Clones PageIndex into `./.ragbox/PageIndex`, creates `./.ragbox/pageindex-venv`, installs PageIndex Python dependencies, updates `ragbox.config.json`, and adds `.ragbox/` to `.gitignore`.

```bash
ragbox setup pageindex
ragbox setup pageindex --ref v0.1.0
ragbox setup pageindex --skip-install
ragbox setup pageindex --dir ../PageIndex --no-write-config
```

Use `--json` for automation. Use `--no-gitignore` if your project manages generated local tooling another way.

### `ragbox init`

Creates a `ragbox.config.json` file without installing PageIndex. Use this when you want to hand-edit paths or manage PageIndex yourself.

```bash
ragbox init
ragbox init --docs-dir ./content --output-dir ./.idx
ragbox init --output ./configs/ragbox.config.json --force
```

### `ragbox index <folder>`

Builds or updates the local index for a Markdown/MDX folder. Run this before `query` or `serve`.

```bash
ragbox index ./docs
ragbox index ./docs --output-dir ./.ragbox-index
ragbox index ./docs --output-dir ./.ragbox-index --json
ragbox index ./docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox index ./docs --pageindex-python /opt/venvs/pageindex/bin/python
ragbox index ./docs --base-url https://api.openai.com/v1 --model gpt-4o-mini
```

`index` scans `**/*.md` and `**/*.mdx`, hashes files, re-indexes new/modified/failed files, skips unchanged ready files, and removes deleted files from the manifest.

If any document fails, normal output keeps the counts on stdout and prints failed document paths plus PageIndex errors on stderr.

Use `--json` to print a versioned machine-readable result with output paths, counts, and failed document details:

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
  },
  "failures": []
}
```

### `ragbox inspect [target]`

Shows what is inside an index, including document status and counts. Use it when an index exists but you want to see what was actually indexed.

```bash
ragbox inspect ./.ragbox-index
ragbox inspect --source ragbox
ragbox inspect --all-sources --json
```

### `ragbox status [target]`

Checks whether an index is ready to query. This is useful in CI, deploy scripts, and smoke checks.

```bash
ragbox status ./.ragbox-index
ragbox status --all-sources
ragbox status --json
```

### `ragbox doctor [target]`

Checks the local setup: config, PageIndex CLI path, LLM settings, API key presence, and index validity. It does not call the network.

```bash
ragbox doctor
ragbox doctor --source ragbox --json
ragbox doctor --all-sources
```

### `ragbox query [target] <question>`

Answers a question from either a docs folder with a default `.pageindex` index, or an existing ragbox output directory.

```bash
ragbox query ./docs "How do I configure authentication?"
ragbox query ./.ragbox-index "What are the deployment steps?"
ragbox query ./docs/.pageindex "How do I configure authentication?"
ragbox query ./.ragbox-index "How do I configure authentication?" --model gpt-4o-mini --api-key sk-...
ragbox query ./.ragbox-index "How do I configure authentication?" --json
ragbox query ./.ragbox-index "How do I configure authentication?" --trace
ragbox trace query ./.ragbox-index "How do I configure authentication?"
ragbox query "What are the deployment steps?"
ragbox query --source ragbox,icharts "How do these projects handle runtime workflows?"
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

For multiple configured sources, `ragbox query "..."` queries all sources by default. Pass comma-separated names with `--source` to limit the search, or use `--all-sources` when you want the global behavior to be explicit. Multi-source query runs the normal structured query flow per source, then asks the LLM to synthesize one final answer from the selected source excerpts. Source references are prefixed with the source name, for example `ragbox:start-command.md#n1`.

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

### `ragbox start [folder]`

Runs the complete local service loop: index first, watch for future changes, and serve the HTTP query API.

```bash
ragbox start
ragbox start --auth-token dev-token
ragbox start --host 127.0.0.1 --port 8787 --jsonl
ragbox start --source ragbox
ragbox start --all-sources
ragbox start ./docs --output-dir ./.ragbox-index
```

Use `start` after `ragbox setup pageindex` when you want one foreground process for local development, an internal service, or a container. It waits for the initial index run before starting HTTP `serve`, then reloads the serve index snapshot after successful watch updates.

With multiple configured sources, `ragbox start` starts all sources by default. Use `--source ragbox,icharts` to limit the running sources, or `--all-sources` to make the global behavior explicit.

`start` does not create or edit `ragbox.config.json`; run `ragbox setup pageindex` for the default local setup, or `ragbox init` when you want to manage PageIndex yourself.

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

- `GET /`: public service entrypoint with health summary and endpoint list.
- `GET /health`: public readiness endpoint for load balancers, Kubernetes, systemd, and smoke checks. Returns 200 when all known indexes are query-ready, otherwise 503.
- `GET /indexes`: returns the current validated index snapshot. Requires `Authorization: Bearer <token>` when a token is configured.
- `POST /query`: answers from one target, selected sources, or all configured sources. Requires auth when configured.
- `POST /reload`: re-reads config/source targets and refreshes the server-side validation snapshot. Requires auth when configured.

Single-index requests:

```bash
curl http://127.0.0.1:8787/
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
  -d '{"source":"ragbox","question":"What does ragbox start do?"}'

curl -X POST http://localhost:8787/query \
  -H "Content-Type: application/json" \
  -d '{"source":["ragbox","icharts"],"question":"How do these projects handle runtime workflows?"}'

curl -X POST http://localhost:8787/query \
  -H "Content-Type: application/json" \
  -d '{"allSources":true,"question":"What documentation topics are available?"}'

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

- Run `ragbox start` when one foreground process should index, watch, and serve.
- Index during deploy, then serve/query the completed output directory with `ragbox serve` or SDK calls.
- Run `ragbox watch` as a background service if docs change outside deploys.
- For long-running watch, prefer `--jsonl`, `--lock-file`, `--health-file`, `--retry-attempts`, and `--staging`.
- Store the output directory outside the source tree, for example `/var/lib/ragbox/docs-index`.
- Mount or copy the completed output directory to every app replica that needs querying.
- Keep API keys in a private server config, environment variables, or your secret manager. Do not commit real keys.
- Use `RAGBOX_SERVE_TOKEN` or `--auth-token` when `serve` is reachable beyond localhost.
- Start with `--concurrency 1`; raise it only after checking PageIndex and API rate limits.

Example private server config:

```json
{
  "version": 1,
  "pageIndex": {
    "cli": "/opt/PageIndex/run_pageindex.py",
    "python": "/opt/pageindex-venv/bin/python"
  },
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "sk-..."
  },
  "docs": {
    "rootDir": "/srv/app/docs",
    "outputDir": "/var/lib/ragbox/docs-index"
  }
}
```

```bash
ragbox --config ./ragbox.config.prod.json index --concurrency 2
ragbox --config ./ragbox.config.prod.json query "How do I configure authentication?"
```

### Run In The Background

`ragbox start` intentionally runs in the foreground. For a server, run it under a process supervisor so it survives terminal closes, SSH disconnects, and crashes.

For quick testing, `nohup` is enough:

```bash
nohup ragbox --config ./ragbox.config.prod.json start > ragbox.log 2>&1 &
```

For Linux servers, prefer `systemd`:

```ini
[Unit]
Description=ragbox service
After=network.target

[Service]
WorkingDirectory=/srv/ragbox
ExecStart=/usr/local/bin/ragbox --config ./ragbox.config.prod.json start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable ragbox
sudo systemctl start ragbox
sudo systemctl status ragbox
```

Node-oriented deployments can use `pm2`:

```bash
pm2 start "ragbox --config ./ragbox.config.prod.json start" --name ragbox
pm2 save
pm2 startup
```

Containers should keep `ragbox start` as the foreground command and use the platform restart policy, such as Docker `--restart unless-stopped` or Kubernetes `restartPolicy`.

## Use ragbox from Node.js

Use the SDK when another Node.js service should create indexes, query docs, validate indexes, or run `serve` programmatically.

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

Custom LLM client:

```js
const { queryIndex, startServe } = require("@bndynet/ragbox");

const llmClient = {
  async chatCompletion(request) {
    // request.messages, request.model, request.temperature
    return await callYourModelGateway(request);
  }
};

const result = await queryIndex(
  "/var/lib/ragbox/docs-index",
  "How do I configure authentication?",
  {
    llmClient,
    model: "internal-docs-model"
  }
);

const server = await startServe({
  target: "/var/lib/ragbox/docs-index",
  llmClient,
  model: "internal-docs-model",
  port: 8787
});
```

`llmClient` is a thin SDK-only provider boundary for direct query-time chat completions. It is useful for local models, model gateways, retries, timeouts, logging, and tests. `ragbox` does not load provider plugins from config files; CLI commands still use the OpenAI-compatible settings from flags, config, and environment variables.

The package root exports the stable product SDK API. Lower-level helpers are still available under `advanced` for custom integrations:

```js
const { advanced } = require("@bndynet/ragbox");

const location = await advanced.resolveQueryIndexLocation("/var/lib/ragbox/docs-index");
```

## What Happens During Query

At a high level, `ragbox` keeps the structure of your docs instead of flattening everything into anonymous chunks:

- each Markdown/MDX file becomes a structured PageIndex tree
- the docs folder gets a small index manifest
- a query first selects likely documents, then likely sections inside those documents
- the final answer is generated only from the selected section text

This is why `--trace` can show which documents and nodes were selected. It is also why the basic flow does not require a vector database.

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

- `PAGEINDEX_CLI is required to run PageIndex`: run `ragbox setup pageindex`, or set `PAGEINDEX_CLI=/path/to/run_pageindex.py`.
- `OPENAI_API_KEY is required for query`: add `llm.apiKey` to a private `ragbox.config.json`, set `OPENAI_API_KEY`, or pass `--api-key`.
- `Expected a docs folder... or a ragbox output directory`: pass either the docs folder with `.pageindex/`, or the output directory itself.
- `PageIndex completed but no generated JSON result was found`: by default, ragbox reads the JSON that PageIndex writes into `results/`. If you use a custom wrapper that only writes to an explicit output path, set `PAGEINDEX_OUTPUT_ARG` or `pageIndex.outputArg` to its output-path flag.

## Limitations

- PageIndex must be installed/configured locally; `ragbox setup pageindex` can prepare the default local checkout and virtual environment.
- Query quality depends on PageIndex JSON shape and the configured LLM.
- The basic flow uses tree selection, not vector search.

## For Contributors

```bash
npm install
npm run build
npm run ragbox -- --help
```

### Examples

Runnable local fixtures and smoke-test commands live in [`examples/README.md`](./examples/README.md). Use that guide when you want to test indexing, query, multi-source config, or the `start` service loop with real PageIndex and LLM settings.
