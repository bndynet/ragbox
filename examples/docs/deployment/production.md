# Production Deployment

Production deployments should keep generated index files outside the application source directory when possible.

Recommended deployment steps:

1. Build or sync the latest documentation source.
2. Run `ragbox index` with an explicit `--output-dir`.
3. Run a smoke query against the generated output directory.
4. Publish the application with the new index path configured.
5. Keep the previous index directory available until the new deployment passes health checks.

## Atomic Switch

When index generation happens in automation, write to a staging output directory first. After indexing and smoke checks pass, switch the active output path by renaming the staging directory or updating a symlink.

## Query Health

A production smoke query should verify that the answer includes at least one source reference and that the expected domain term appears in the result.
