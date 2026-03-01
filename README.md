# ragbox

Structure-first RAG for Markdown/MDX folders.

`ragbox` indexes a docs folder into local PageIndex JSON files, then answers questions from that index with an OpenAI-compatible chat model. It keeps one PageIndex tree per source file and one folder-level `root-tree.json` for document selection.

[中文文档](./README.zh-CN.md)

## Why

Traditional vector RAG usually chunks documents, embeds chunks, and retrieves by vector similarity. `ragbox` starts from document structure:

- one Markdown/MDX file -> one PageIndex tree
- one docs folder -> one `manifest.json` and one `root-tree.json`
- query flow -> select documents, select PageIndex nodes, answer from selected node text

No vector database is required for the basic flow.

## Compared With Vector DB RAG

| Area | Vector DB RAG | `ragbox` |
| --- | --- | --- |
| Index unit | Text chunks | Markdown/MDX file plus PageIndex nodes |
| Retrieval signal | Embedding similarity | LLM selection over document and node trees |
| Storage | Vector database plus document store | Local JSON files under the output directory |
| Context shape | Flat retrieved chunks | Structured nodes with file paths and node ids |
| Strength | Fast fuzzy recall across large corpora | Preserves document hierarchy and source references |
| Tradeoff | Requires embedding/index infrastructure | Depends on PageIndex quality and LLM selection |

The two approaches can also be combined: use vector search for broad candidate recall, then use PageIndex trees for structured filtering, context packing, and citations.

## Install

```bash
npm install -g @bndynet/ragbox
```

Local development:

```bash
npm install
npm run build
npm run ragbox -- --help
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

## Configuration

Command-line flags override environment variables.

| Setting | Env | CLI flag | Used by | Default |
| --- | --- | --- | --- | --- |
| PageIndex script | `PAGEINDEX_CLI` | none | `index`, `watch` | required when indexing |
| Python executable | `PAGEINDEX_PYTHON` | `--pageindex-python` | `index`, `watch` | `python3` |
| Output directory | `RAGBOX_OUTPUT_DIR` | `--output-dir` | `index`, `watch` | `<folder>/.pageindex` |
| Concurrency | `PAGEINDEX_CONCURRENCY` | `--concurrency` | `index`, `watch` | `1` |
| PageIndex output flag | `PAGEINDEX_OUTPUT_ARG` | none | `index`, `watch` | none |
| API base URL | `OPENAI_BASE_URL` | `--base-url` | `index`, `watch`, `query` | `https://api.openai.com/v1` |
| API key | `OPENAI_API_KEY` | `--api-key` | `index`, `watch`, `query` | required for query and usually PageIndex |
| Model | `PAGEINDEX_MODEL`, `LLM_MODEL` | `--model` | `index`, `watch`, `query` | `gpt-4o-mini` |

For production, prefer environment variables or a secret manager for API keys. Passing `--api-key` is useful for local testing, but command-line secrets can appear in shell history and process listings.

## Commands

### `ragbox index <folder>`

Indexes Markdown/MDX files.

```bash
ragbox index ./docs
ragbox index ./docs --output-dir ./.ragbox-index
ragbox index ./docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox index ./docs --pageindex-python /opt/venvs/pageindex/bin/python
ragbox index ./docs --base-url https://api.openai.com/v1 --model gpt-4o-mini
```

`index` scans `**/*.md` and `**/*.mdx`, hashes files, re-indexes new/modified/failed files, skips unchanged ready files, and removes deleted files from the manifest.

### `ragbox query <target> <question>`

Answers from either a docs folder with a default `.pageindex` index, or an existing ragbox output directory.

```bash
ragbox query ./docs "How do I configure authentication?"
ragbox query ./.ragbox-index "What are the deployment steps?"
ragbox query ./docs/.pageindex "How do I configure authentication?"
ragbox query ./.ragbox-index "How do I configure authentication?" --model gpt-4o-mini --api-key sk-...
```

Use the same `--base-url` value that you use for indexing. It should normally be the OpenAI-compatible root, such as `https://api.openai.com/v1`; `query` also accepts a full `/chat/completions` URL for proxy setups that require it.

The first argument can be:

- a docs folder containing `.pageindex/manifest.json` and `.pageindex/root-tree.json`
- an output directory containing:

```text
manifest.json
root-tree.json
indexes/
```

`query` reads `root-tree.json`, asks the LLM to choose likely documents, reads their PageIndex JSON, strips `text` fields before node selection, then extracts the selected node text for the final answer.

### `ragbox watch <folder>`

Runs an initial index and keeps it updated.

```bash
ragbox watch ./docs
ragbox watch ./docs --output-dir ./.ragbox-index
ragbox watch ./docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox watch ./docs --base-url https://api.openai.com/v1 --model gpt-4o-mini
```

Watch mode listens for Markdown/MDX add, change, and unlink events. It ignores `node_modules`, `.git`, `.pageindex`, `dist`, `build`, and a custom output directory when it is inside the watched root.

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

- Index during deploy, then serve/query the completed output directory.
- Run `ragbox watch` as a background service if docs change outside deploys.
- Store the output directory outside the source tree, for example `/var/lib/ragbox/docs-index`.
- Mount or copy the completed output directory to every app replica that needs querying.
- Keep API keys in environment variables or your secret manager.
- Start with `--concurrency 1`; raise it only after checking PageIndex and API rate limits.

Example deploy-time indexing:

```bash
export PAGEINDEX_CLI=/opt/PageIndex/run_pageindex.py
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1

ragbox index /srv/app/docs --output-dir /var/lib/ragbox/docs-index --concurrency 2
ragbox query /var/lib/ragbox/docs-index "How do I configure authentication?"
```

Library use:

```js
const { queryFolder } = require("@bndynet/ragbox");

const answer = await queryFolder(
  "/var/lib/ragbox/docs-index",
  "How do I configure authentication?"
);
```

## Real E2E Validation

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
export PAGEINDEX_OUTPUT_ARG=--output
export RAGBOX_E2E_PAGEINDEX_PYTHON=/path/to/python
export RAGBOX_E2E_HEARTBEAT_MS=10000
export RAGBOX_E2E_COMMAND_TIMEOUT_MS=300000

npm run test:e2e
```

`.env.e2e.local` is ignored by git. Use `npm run test:e2e:raw` only when you intentionally want to bypass the helper script.

The test defaults to `./examples`, runs `ragbox index ./examples --output-dir ./examples/.pageindex`, queries the generated JSON directory, then queries the docs directory itself. It prints live stage logs, per-document index progress, query progress, and heartbeat lines while long commands are still running. `./examples` currently contains 100 Markdown demo documents; for a faster OAuth-only check, set `RAGBOX_E2E_DOCS_DIR=./examples/authentication/oauth2`.

The default e2e question is intentionally fuzzy: "What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk?" The final answer is printed in the e2e log for both the output-directory query and the docs-directory query.

For Markdown indexing, ragbox asks PageIndex to include `node_id` and `text` by default. During query, `text` is stripped from the node-selection prompt and only added back for the final answer context.

## Troubleshooting

- `PAGEINDEX_CLI is required to run PageIndex`: set `PAGEINDEX_CLI=/path/to/run_pageindex.py`.
- `OPENAI_API_KEY is required for query`: set `OPENAI_API_KEY` or pass `--api-key`.
- `Expected a docs folder... or a ragbox output directory`: pass either the docs folder with `.pageindex/`, or the output directory itself.
- `PageIndex completed but no generated JSON result was found`: set `PAGEINDEX_OUTPUT_ARG` if your PageIndex CLI supports an explicit output path flag.

## Limitations

- PageIndex must already be installed/configured locally.
- Query quality depends on PageIndex JSON shape and the configured LLM.
- The basic flow uses tree selection, not vector search.
