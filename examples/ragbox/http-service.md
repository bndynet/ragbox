# HTTP Service Mode

`ragbox serve` exposes an existing index through a small HTTP API. It is useful when another backend, docs site, or internal tool needs to query indexed documentation over REST.

The basic service flow is:

```bash
ragbox index ./docs --output-dir ./.ragbox-index
ragbox serve ./.ragbox-index --host 127.0.0.1 --port 8787 --auth-token dev-token
```

The public HTTP contract is:

- `GET /health`: readiness endpoint for load balancers, Kubernetes, systemd, and smoke checks.
- `GET /indexes`: returns the validated index snapshot.
- `POST /query`: answers a question from one source, selected sources, or all configured sources.
- `POST /reload`: refreshes the server-side index snapshot after config or index changes.

When an auth token is configured, every endpoint except `/health` requires `Authorization: Bearer <token>`.

Browser widgets should not call `ragbox serve` directly with the ragbox token. A docs site widget should call its own application backend, and that backend can enforce user authentication, rate limits, and audit logging before forwarding to `ragbox serve`.

`ragbox start` includes service mode automatically. Use `serve` directly when indexing is handled separately, such as during CI or deployment.
