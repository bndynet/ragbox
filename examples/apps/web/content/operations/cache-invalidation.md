# Cache Invalidation

The web source can cache answers for repeated questions, but cache entries must be invalidated after an index reload.

Use the index generation timestamp from `manifest.json` as part of the cache key. When a new manifest becomes active, old cached answers should stop matching automatically.

## Preview Environments

Preview deployments should use a separate cache namespace so draft indexes cannot affect production answers.

## Failure Mode

If a user reports stale answers, compare the active manifest timestamp with the cache key version and reload the widget runtime if they differ.
