# Ragbox Examples

This directory is a small multi-source documentation fixture for local indexing, querying, and e2e smoke tests.

## Sources

- `docs`: product docs, deployment notes, and operator workflows.
- `api`: API authentication, endpoints, errors, and retry behavior.
- `web`: docs-site widget installation and web runtime notes.

The sample config is intentionally stored inside this directory so relative paths resolve from `examples/`:

```bash
ragbox --config ./examples/ragbox.config.json index --source docs
ragbox --config ./examples/ragbox.config.json index --source api
ragbox --config ./examples/ragbox.config.json index --source web
ragbox --config ./examples/ragbox.config.json query --all-sources "How does authentication work end to end?"
```

The repository e2e helper still indexes `./examples` as one folder by default. For a faster OAuth-only check, set:

```bash
export RAGBOX_E2E_DOCS_DIR=./examples/packages/api/docs/authentication
export RAGBOX_E2E_EXPECTED_TEXT=PKCE
```
