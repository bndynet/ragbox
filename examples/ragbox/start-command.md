# The `ragbox start` Command

`ragbox start` runs the full local service loop for a configured documentation project. It is designed for local development, internal services, and container processes where one foreground process should own indexing, watching, and serving.

When `ragbox start` runs, it does three things:

1. It indexes the configured source or sources.
2. It starts watch mode so later Markdown or MDX changes update the index.
3. It starts the HTTP service for `/health`, `/indexes`, `/query`, and `/reload`.

The command waits for the initial index to finish before starting the HTTP service. After watch mode completes a successful reindex, `start` reloads the service snapshot so new queries use the latest index.

Common examples:

```bash
ragbox start
ragbox start --source ragbox
ragbox start --all-sources
ragbox start --host 127.0.0.1 --port 8787 --auth-token dev-token
ragbox start ./docs --output-dir ./.ragbox-index
```

When the config contains multiple sources, `ragbox start` starts all configured sources by default. Use `--source ragbox,icharts` to limit the running sources, or `--all-sources` to make the global behavior explicit.

`start` does not create or edit the config file. The recommended first-run flow is `ragbox init`, modify `ragbox.config.json`, then `ragbox start`.
