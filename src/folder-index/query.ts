import fs from "node:fs/promises";
import path from "node:path";
import { loadPageIndexConfig } from "./config";
import { chatCompletion } from "./llm-client";
import { MANIFEST_FILE, PAGEINDEX_DIR, resolveDocumentIndexPath, ROOT_TREE_FILE } from "./manifest";
import { createTreeRetriever } from "./retrieval";
import { QueryStageError, runQueryStage } from "./query-stage";
import {
  buildNodeMap,
  byteLength,
  estimateTokenCount,
  extractNodeText,
  extractNodeTextFromMarkdown,
  JsonObject,
  logVerbose,
  readJson
} from "./query-utils";
import {
  DocumentRecord,
  Manifest,
  PageIndexOptions,
  QueryResult,
  QuerySelectedDocument,
  QuerySelectedNode,
  QuerySource,
  QueryTimings,
  QueryTrace,
  QueryTraceFailure,
  RetrievalCandidate,
  RetrievalResult,
  Retriever,
  RootTreeNode
} from "./types";

export { QueryStageError } from "./query-stage";
export { buildNodeMap, extractNodeTextFromMarkdown, stripText } from "./query-utils";

export type QueryIndexLocation = {
  rootDir: string;
  outputDir?: string;
  manifestPath: string;
  rootTreePath: string;
};

type DocumentIndexCache = {
  pageIndexJson: unknown;
  nodeMap: Map<string, JsonObject>;
  sourceMarkdown?: string;
};

const defaultRetriever = createTreeRetriever();

function addTraceFailure(trace: QueryTrace | undefined, failure: QueryTraceFailure): void {
  trace?.failures.push(failure);
}

function applyRetrievalTrace(trace: QueryTrace | undefined, retrievalResult: RetrievalResult): void {
  if (!trace) {
    return;
  }

  trace.documentSelection = retrievalResult.trace.documentSelection;
  trace.nodeSelections.push(...retrievalResult.trace.nodeSelections);
  trace.failures.push(...retrievalResult.trace.failures);
}

async function readSourceMarkdown(rootDir: string, record: DocumentRecord): Promise<string | undefined> {
  const candidates = [path.join(rootDir, record.path), record.absolutePath];
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      // Try the next path. The manifest may have been moved with the index.
    }
  }
  return undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasQueryIndexFiles(outputDir: string): Promise<boolean> {
  return (await pathExists(path.join(outputDir, MANIFEST_FILE))) && (await pathExists(path.join(outputDir, ROOT_TREE_FILE)));
}

async function readQueryIndexLocation(rootDir: string, outputDir: string): Promise<QueryIndexLocation> {
  const manifestPath = path.join(outputDir, MANIFEST_FILE);
  const rootTreePath = path.join(outputDir, ROOT_TREE_FILE);
  const manifest = await readJson<Manifest>(manifestPath);

  return {
    rootDir: manifest.rootDir ? path.resolve(manifest.rootDir) : rootDir,
    outputDir,
    manifestPath,
    rootTreePath
  };
}

export async function resolveQueryIndexLocation(target: string): Promise<QueryIndexLocation> {
  const resolvedTarget = path.resolve(target);
  const defaultOutputDir = path.join(resolvedTarget, PAGEINDEX_DIR);

  if (await hasQueryIndexFiles(resolvedTarget)) {
    return await readQueryIndexLocation(resolvedTarget, resolvedTarget);
  }

  if (await hasQueryIndexFiles(defaultOutputDir)) {
    return await readQueryIndexLocation(resolvedTarget, defaultOutputDir);
  }

  throw new Error(
    `Expected a docs folder with ${PAGEINDEX_DIR}/${MANIFEST_FILE} and ${PAGEINDEX_DIR}/${ROOT_TREE_FILE}, or a ragbox output directory with ${MANIFEST_FILE} and ${ROOT_TREE_FILE}: ${target}`
  );
}

function createTrace(options: PageIndexOptions): QueryTrace | undefined {
  return options.trace
    ? {
        version: 1,
        nodeSelections: [],
        context: {
          sourceCount: 0,
          bytes: 0,
          tokens: 0
        },
        failures: []
      }
    : undefined;
}

function seedDocumentIndexCache(retrievalResult: RetrievalResult): Map<string, DocumentIndexCache> {
  const cache = new Map<string, DocumentIndexCache>();

  for (const documentIndex of retrievalResult.documentIndexes ?? []) {
    cache.set(documentIndex.docId, {
      pageIndexJson: documentIndex.pageIndexJson,
      nodeMap: buildNodeMap(documentIndex.pageIndexJson)
    });
  }

  return cache;
}

async function getDocumentIndexCache(
  location: QueryIndexLocation,
  cache: Map<string, DocumentIndexCache>,
  candidate: RetrievalCandidate
): Promise<DocumentIndexCache> {
  const cached = cache.get(candidate.docId);
  if (cached) {
    return cached;
  }

  const pageIndexJson = await runQueryStage(
    "read-document-index",
    async () => await readJson<unknown>(resolveDocumentIndexPath(location.rootDir, candidate.indexPath, location.outputDir))
  );
  const next = {
    pageIndexJson,
    nodeMap: buildNodeMap(pageIndexJson)
  };
  cache.set(candidate.docId, next);
  return next;
}

async function extractSourcesFromCandidates(
  location: QueryIndexLocation,
  manifest: Manifest,
  retrievalResult: RetrievalResult,
  selectedNodes: QuerySelectedNode[],
  sources: QuerySource[],
  warnings: string[],
  trace: QueryTrace | undefined
): Promise<void> {
  const manifestByDocId = new Map<string, DocumentRecord>(manifest.documents.map((record) => [record.docId, record]));
  const documentIndexCache = seedDocumentIndexCache(retrievalResult);

  for (const candidate of retrievalResult.candidates) {
    const manifestRecord = manifestByDocId.get(candidate.docId);
    const reference = candidate.reference || `${candidate.path}#${candidate.nodeId}`;
    const selectedNode: QuerySelectedNode = {
      docId: candidate.docId,
      path: candidate.path,
      nodeId: candidate.nodeId,
      found: false,
      hasText: false,
      reference,
      selectionReason: candidate.selectionReason
    };

    if (!manifestRecord) {
      selectedNode.skipReason = "node_not_found";
      selectedNodes.push(selectedNode);
      warnings.push(`Selected node was not found: ${reference}`);
      addTraceFailure(trace, {
        stage: "extract-context",
        code: "node_not_found",
        message: `Selected node was not found: ${reference}`,
        docId: candidate.docId,
        nodeId: candidate.nodeId,
        path: candidate.path,
        reference
      });
      continue;
    }

    const cached = await getDocumentIndexCache(location, documentIndexCache, candidate);
    const node = cached.nodeMap.get(candidate.nodeId);
    if (!node) {
      selectedNode.skipReason = "node_not_found";
      selectedNodes.push(selectedNode);
      warnings.push(`Selected node was not found: ${reference}`);
      addTraceFailure(trace, {
        stage: "extract-context",
        code: "node_not_found",
        message: `Selected node was not found: ${reference}`,
        docId: candidate.docId,
        nodeId: candidate.nodeId,
        path: candidate.path,
        reference
      });
      continue;
    }

    selectedNode.found = true;
    let text = extractNodeText(node);
    if (!text) {
      cached.sourceMarkdown ??= await readSourceMarkdown(location.rootDir, manifestRecord);
      text = cached.sourceMarkdown ? extractNodeTextFromMarkdown(node, cached.pageIndexJson, cached.sourceMarkdown) : undefined;
      if (text) {
        logVerbose(`query fallback markdown text path=${manifestRecord.path} node=${candidate.nodeId}`);
      }
    }
    if (!text) {
      selectedNode.skipReason = "missing_text";
      selectedNodes.push(selectedNode);
      warnings.push(`Selected node has no extractable text: ${reference}`);
      addTraceFailure(trace, {
        stage: "extract-context",
        code: "missing_text",
        message: `Selected node has no extractable text: ${reference}`,
        docId: candidate.docId,
        nodeId: candidate.nodeId,
        path: candidate.path,
        reference
      });
      continue;
    }

    selectedNode.hasText = true;
    selectedNode.textBytes = byteLength(text);
    selectedNodes.push(selectedNode);
    sources.push({
      path: candidate.path,
      nodeId: candidate.nodeId,
      reference,
      text
    });
  }
}

function answerContext(sources: QuerySource[]): string {
  return sources.length > 0 ? sources.map((source) => `Source: ${source.reference}\n${source.text}`).join("\n\n---\n\n") : "(no relevant context found)";
}

function selectedRetriever(config: PageIndexOptions): Retriever {
  return config.retriever ?? defaultRetriever;
}

export async function queryFolder(target: string, question: string, options: PageIndexOptions = {}): Promise<QueryResult> {
  const totalStartedAt = Date.now();
  const timings: QueryTimings = {
    resolve: 0,
    selectDocuments: 0,
    selectNodes: 0,
    answer: 0,
    total: 0
  };
  const warnings: string[] = [];
  const selectedDocuments: QuerySelectedDocument[] = [];
  const selectedNodes: QuerySelectedNode[] = [];
  const sources: QuerySource[] = [];
  const config = loadPageIndexConfig(options);
  const resolvedTarget = path.resolve(target);
  const trace = createTrace(options);

  logVerbose(`query resolve target=${path.resolve(target)}`);
  const resolveStartedAt = Date.now();
  const location = await runQueryStage("resolve", async () => await resolveQueryIndexLocation(target));
  logVerbose(`query index root=${location.rootDir} output=${location.outputDir ?? "(default)"}`);
  const { manifest, rootTree } = await runQueryStage("read-index", async () => ({
    manifest: await readJson<Manifest>(location.manifestPath),
    rootTree: await readJson<RootTreeNode>(location.rootTreePath)
  }));
  timings.resolve = Date.now() - resolveStartedAt;

  const retriever = selectedRetriever(config);
  const retrievalResult = await runQueryStage(
    "select-documents",
    async () =>
      await retriever.retrieve(
        question,
        {
          rootDir: location.rootDir,
          outputDir: location.outputDir,
          manifest,
          rootTree
        },
        config
      )
  );
  timings.selectDocuments = retrievalResult.timings.selectDocuments;
  timings.selectNodes = retrievalResult.timings.selectNodes;
  selectedDocuments.push(...retrievalResult.selectedDocuments);
  warnings.push(...retrievalResult.warnings);
  applyRetrievalTrace(trace, retrievalResult);

  await extractSourcesFromCandidates(location, manifest, retrievalResult, selectedNodes, sources, warnings, trace);

  if (sources.length === 0) {
    warnings.push("No relevant context was extracted from the selected index nodes.");
    addTraceFailure(trace, {
      stage: "extract-context",
      code: "empty_context",
      message: "No relevant context was extracted from the selected index nodes."
    });
  }

  const context = answerContext(sources);
  const contextBytes = byteLength(context);
  const contextTokens = estimateTokenCount(context);
  if (trace) {
    trace.context = {
      sourceCount: sources.length,
      bytes: contextBytes,
      tokens: contextTokens
    };
  }
  logVerbose(`query final answer contextParts=${sources.length}`);
  const finalPrompt = `Answer the user question using only the provided context.
If the context is insufficient, say that you could not find enough information in the available documentation.
Do not expose implementation details about how the documentation was found or prepared.
Include source references using the file path and node_id when possible.
User question:
${question}
Context:
${context}`;

  const answerStartedAt = Date.now();
  const answer = await runQueryStage("answer", async () => await chatCompletion([{ role: "user", content: finalPrompt }], options));
  if (trace) {
    trace.answer = {
      promptBytes: byteLength(finalPrompt),
      responseBytes: byteLength(answer)
    };
  }
  timings.answer = Date.now() - answerStartedAt;
  timings.total = Date.now() - totalStartedAt;

  return {
    version: 1,
    target: resolvedTarget,
    rootDir: location.rootDir,
    outputDir: location.outputDir ?? path.join(location.rootDir, PAGEINDEX_DIR),
    question,
    model: config.model,
    answer,
    contextBytes,
    contextTokens,
    selectedDocuments,
    selectedNodes,
    sources,
    warnings,
    timingsMs: timings,
    ...(trace ? { trace } : {})
  };
}
