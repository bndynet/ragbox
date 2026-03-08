# Configuration

Ragbox reads configuration from `ragbox.config.json` unless `--config` points to another file.

Configuration resolution order is:

1. CLI flags.
2. Ragbox config file values.
3. Environment variables.
4. Built-in defaults.

## Single Source

A single-source project can use:

```json
{
  "version": 1,
  "docs": {
    "rootDir": "./docs",
    "outputDir": "./.ragbox-index"
  }
}
```

## Multiple Sources

A multi-source project can define `docs`, `api`, and `web` entries under `sources`. Querying with no explicit source searches every configured source. Passing `--source api` limits the query to API docs, and passing `--source docs,api` searches those two sources.

## Secrets

API keys should usually be provided with `OPENAI_API_KEY` or command-line flags in local test environments. Avoid committing real keys to config files.
