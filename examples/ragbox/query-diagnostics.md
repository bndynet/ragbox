# Query Diagnostics and Trace Output

RAG answers are easier to trust when users can see what the tool selected. `ragbox query --json` returns structured answer details, while `ragbox query --trace` and `ragbox trace query` add diagnostic internals for tuning.

The query flow is:

1. Resolve the docs folder or index output directory.
2. Read `manifest.json` and `root-tree.json`.
3. Ask the LLM to select likely documents.
4. Ask the LLM to select likely PageIndex nodes inside each document.
5. Extract node text and build the answer context.
6. Ask the LLM to produce the final answer using only that context.

Useful JSON fields include:

- `selectedDocuments`: document ids selected from the root tree, with selection and skip reasons.
- `selectedNodes`: selected PageIndex nodes, text size, and skip reasons.
- `sources`: exact source references and text used as final answer context.
- `contextBytes` and `contextTokens`: the final context size.
- `warnings`: missing documents, missing nodes, or empty context conditions.
- `timingsMs`: time spent resolving, selecting, and answering.

Trace mode adds raw document selection responses, raw node selection responses, prompt and response byte counts, and non-fatal failure records. This helps users answer questions such as "why did ragbox choose this file?" or "why was there no useful context?"

Example:

```bash
ragbox query --source ragbox --trace "What does ragbox start do?"
ragbox trace query --source ragbox "How does query explain selected nodes?"
```
