# Getting Started

Ragbox indexes Markdown and MDX folders into local PageIndex JSON files, then answers questions using an OpenAI-compatible chat model.

The normal workflow has three steps:

1. Write or collect source documents.
2. Run `ragbox index` to build a local folder index.
3. Run `ragbox query` against either the docs folder or the generated output directory.

For a single source, a project can rely on the top-level `docs` object in `ragbox.config.json`. For multiple sources, use the `sources` map and choose a named source with `--source`.

## Local Output

The default index directory is `.pageindex` under the indexed folder. Production projects often set `outputDir` to a separate path such as `.ragbox-index/docs` so generated files stay out of the source tree.

## Query Behavior

During query, ragbox first selects relevant documents from `root-tree.json`, then selects nodes from each selected PageIndex tree, extracts text, and asks the model to answer using only that context.
