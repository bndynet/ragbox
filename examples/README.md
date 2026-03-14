# Ragbox Examples

This directory is a small multi-source documentation fixture for local indexing, querying, and e2e smoke tests.

## Sources

- `ragbox`: documentation about this repository, including `start`, `serve`, query diagnostics, and SDK usage.
- `icharts`: chart-library documentation used as a second, larger source for multi-source tests.

The sample config is stored inside this directory so relative paths resolve from `examples/`.

```bash
ragbox --config ./examples/ragbox.config.json index --source ragbox
ragbox --config ./examples/ragbox.config.json index --source icharts
ragbox --config ./examples/ragbox.config.json query --source ragbox "What does ragbox start do?"
ragbox --config ./examples/ragbox.config.json query --all-sources "How do ragbox and icharts handle runtime workflows?"
```

## E2E Config

Use `ragbox.config.e2e.json` as a safe template for a real local run. Keep real secrets in the ignored local file `ragbox.config.e2e.local.json`.

```bash
cp examples/ragbox.config.e2e.json examples/ragbox.config.e2e.local.json
# Edit examples/ragbox.config.e2e.local.json:
# - pageIndex.cli
# - pageIndex.python
# - llm.apiKey
# - llm.baseUrl / llm.model if needed
```

ragbox automatically handles both common PageIndex output styles: wrappers that accept an output-path flag and scripts that write into a `results/` directory. If you use a custom wrapper with a non-default output flag, set `pageIndex.outputArg` to that flag, for example `"--out"`.

In this workspace, `examples/ragbox.config.e2e.local.json` can be generated from the root `.env.e2e.local` values for PageIndex and LLM settings. The local config is ignored by git so it can contain the real server-side API key.

Run a focused ragbox e2e check:

```bash
npm run build
npm run ragbox -- --config ./examples/ragbox.config.e2e.local.json index --source ragbox
npm run ragbox -- --config ./examples/ragbox.config.e2e.local.json query --source ragbox "What does ragbox start do?"
```

Run the full local service loop:

```bash
npm run ragbox -- --config ./examples/ragbox.config.local.json start --source ragbox --port 8787 --auth-token dev-token
```

The repository e2e helper indexes `./examples` as one folder by default. For a faster ragbox-only check, set:

```bash
export RAGBOX_E2E_DOCS_DIR=./examples/ragbox
export RAGBOX_E2E_EXPECTED_TEXT=start
export RAGBOX_E2E_QUESTION="What does ragbox start do?"
```
