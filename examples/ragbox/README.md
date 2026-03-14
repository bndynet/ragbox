# ragbox Example Docs

This source documents the ragbox repository itself. It is intentionally small, stable, and useful for end-to-end tests that ask about CLI workflows, query diagnostics, service mode, and SDK integration.

Use this source when you want to verify that ragbox can answer questions about its own product behavior, such as:

- what `ragbox start` does
- when to use `index`, `watch`, `serve`, or `start`
- how `query --trace` explains document and node selection
- how the HTTP API is meant to be integrated
- how to inject a custom `LlmClient` from the SDK

The source is configured as `ragbox` in `examples/ragbox.config.json`.
