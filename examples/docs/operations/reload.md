# Reload Operations

Reload is the process of making a newly generated index visible to query workers.

Operators should reload after:

- A scheduled documentation sync.
- A manual content fix.
- A PageIndex or ragbox version upgrade.
- A failed query investigation that required reindexing.

## Safe Reload Pattern

The safe pattern is stage, validate, switch, and observe. Build the new index in a staging output directory, validate the manifest and root tree, switch traffic to the new directory, then watch query errors and latency.

## Rollback

If reload introduces missing sources or query failures, restore the previous output directory and rerun the smoke query before resuming normal traffic.
