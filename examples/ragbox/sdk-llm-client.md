# SDK and Custom LlmClient

The package root exports a product SDK for Node.js services. Applications can create indexes, query docs, validate indexes, watch folders, and start the HTTP server programmatically.

Common SDK functions include:

- `createIndex(folder, options)`: build or update a local index.
- `queryIndex(target, question, options)`: answer a question from an index.
- `validateIndex(target)`: check whether an index is query-ready.
- `watchIndex(folder, options)`: keep an index updated while files change.
- `startServe(options)`: start the HTTP query service.

`LlmClient` is a thin SDK-only provider boundary for query-time chat completions. It lets applications route direct query calls through a local model, model gateway, retry wrapper, timeout wrapper, logging layer, or test mock.

Example:

```js
const { queryIndex, startServe } = require("@bndynet/ragbox");

const llmClient = {
  async chatCompletion(request) {
    return await callInternalModelGateway(request);
  }
};

const result = await queryIndex(
  "/var/lib/ragbox/docs-index",
  "What does ragbox start do?",
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

The CLI does not load provider plugins from config files. CLI commands continue to use the OpenAI-compatible settings from flags, config, and environment variables.
