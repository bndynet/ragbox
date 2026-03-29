# Getting Started With ragbox

`ragbox` turns Markdown and MDX documentation into a local queryable index. A typical user starts by creating a config file, editing it for their docs and model provider, and then starting the full local service loop.

The shortest project workflow is:

```bash
ragbox init
# edit ragbox.config.json
ragbox start
```

`ragbox init` creates `ragbox.config.json`. Users should set the docs path, the index output path, the local PageIndex script, the model base URL, the model name, and any preferred `serve.host` / `serve.port` / `serve.authToken`. The API key and serve token can be supplied from the environment or from a server-only config file.

`ragbox start` is the easiest way to run an interactive project. It performs the initial index, watches the docs for changes, and starts the HTTP query API in one foreground process.

For one-off checks, users can still run the lower-level commands directly:

```bash
ragbox index ./docs --output-dir ./.ragbox-index
ragbox query ./.ragbox-index "How do I configure authentication?"
ragbox watch ./docs --output-dir ./.ragbox-index
ragbox serve ./.ragbox-index --auth-token dev-token
```

The lower-level commands remain useful for CI, production deployments, and debugging because they let users separate indexing, querying, watching, and serving.
