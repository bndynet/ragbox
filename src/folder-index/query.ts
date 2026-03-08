import fs from "node:fs/promises";
import path from "node:path";
import { loadPageIndexConfig } from "./config";
import { chatCompletion } from "./llm-client";
import { MANIFEST_FILE, PAGEINDEX_DIR, resolveDocumentIndexPath, ROOT_TREE_FILE } from "./manifest";
import {
  DocumentRecord,
  Manifest,
  PageIndexOptions,
  QueryFailureStage,
  QueryResult,
  QuerySelectedDocument,
  QuerySelectedNode,
  QuerySource,
  QueryTimings,
  QueryTrace,
  QueryTraceFailure,
  RootTreeNode
} from "./types";

type JsonObject = Record<string, unknown>;

type DocumentSelection = {
  documents: string[];
};

type NodeSelection = {
  nodes: string[];
};

type SelectionResult = {
  ids: string[];
  promptBytes: number;
  rawResponse: string;
  responseBytes: number;
};

export type QueryIndexLocation = {
  rootDir: string;
  outputDir?: string;
  manifestPath: string;
  rootTreePath: string;
};

export class QueryStageError extends Error {
  readonly stage: QueryFailureStage;
  readonly cause: unknown;

  constructor(stage: QueryFailureStage, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`Query failed during ${stage}: ${message}`);
    this.name = "QueryStageError";
    this.stage = stage;
    this.cause = error;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerbose(): boolean {
  return process.env.RAGBOX_VERBOSE === "1" || process.env.RAGBOX_E2E_VERBOSE === "1";
}

function logVerbose(message: string): void {
  if (isVerbose()) {
    console.error(`[ragbox] ${message}`);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function estimateTokenCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

async function runQueryStage<T>(stage: QueryFailureStage, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof QueryStageError) {
      throw error;
    }
    throw new QueryStageError(stage, error);
  }
}

function addTraceFailure(trace: QueryTrace | undefined, failure: QueryTraceFailure): void {
  trace?.failures.push(failure);
}

export function stripText<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripText(item)) as T;
  }

  if (!isObject(value)) {
    return value;
  }

  const stripped: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "text") {
      continue;
    }
    stripped[key] = stripText(nestedValue);
  }
  return stripped as T;
}

function getNodeId(value: JsonObject): string | undefined {
  for (const key of ["node_id", "nodeId", "id"]) {
    const nodeId = value[key];
    if (typeof nodeId === "string" && nodeId.length > 0) {
      return nodeId;
    }
  }
  return undefined;
}

export function buildNodeMap(tree: unknown): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  const seen = new Set<unknown>();

  function visit(value: unknown): void {
    if (!value || seen.has(value)) {
      return;
    }

    if (Array.isArray(value)) {
      seen.add(value);
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (!isObject(value)) {
      return;
    }

    seen.add(value);
    const nodeId = getNodeId(value);
    if (nodeId) {
      map.set(nodeId, value);
    }

    for (const nestedValue of Object.values(value)) {
      if (typeof nestedValue === "object" && nestedValue !== null) {
        visit(nestedValue);
      }
    }
  }

  visit(tree);
  return map;
}

function parseJsonObject<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new Error(`Expected JSON object from LLM, got: ${raw}`);
  }
}

function lightweightRootTree(node: RootTreeNode): RootTreeNode {
  const base: RootTreeNode = {
    node_id: node.node_id,
    type: node.type,
    title: node.title
  };

  if (node.type === "document") {
    base.summary = node.summary;
    base.path = node.path;
  }

  if (node.children?.length) {
    base.children = node.children.map(lightweightRootTree);
  }

  return base;
}

function findDocumentNodes(rootTree: RootTreeNode): Map<string, RootTreeNode> {
  const documents = new Map<string, RootTreeNode>();

  function visit(node: RootTreeNode): void {
    if (node.type === "document") {
      documents.set(node.node_id, node);
    }

    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(rootTree);
  return documents;
}

function extractNodeText(node: JsonObject): string | undefined {
  const text = node.text;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function getLineNumber(value: JsonObject): number | undefined {
  for (const key of ["line_num", "lineNum", "line"]) {
    const lineNumber = value[key];
    if (typeof lineNumber === "number" && Number.isFinite(lineNumber) && lineNumber > 0) {
      return Math.floor(lineNumber);
    }
    if (typeof lineNumber === "string") {
      const parsed = Number.parseInt(lineNumber, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function collectLineNumbers(tree: unknown): number[] {
  const lineNumbers = new Set<number>();
  const seen = new Set<unknown>();

  function visit(value: unknown): void {
    if (!value || seen.has(value)) {
      return;
    }

    if (Array.isArray(value)) {
      seen.add(value);
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (!isObject(value)) {
      return;
    }

    seen.add(value);
    const lineNumber = getLineNumber(value);
    if (lineNumber) {
      lineNumbers.add(lineNumber);
    }

    for (const nestedValue of Object.values(value)) {
      if (typeof nestedValue === "object" && nestedValue !== null) {
        visit(nestedValue);
      }
    }
  }

  visit(tree);
  return [...lineNumbers].sort((left, right) => left - right);
}

export function extractNodeTextFromMarkdown(node: JsonObject, tree: unknown, markdown: string): string | undefined {
  const startLine = getLineNumber(node);
  if (!startLine) {
    return undefined;
  }

  const lines = markdown.split(/\r?\n/);
  const nextLine = collectLineNumbers(tree).find((lineNumber) => lineNumber > startLine) ?? lines.length + 1;
  const text = lines.slice(startLine - 1, Math.max(startLine, nextLine - 1)).join("\n").trim();
  return text || undefined;
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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
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

async function selectDocuments(question: string, rootTree: RootTreeNode, options: PageIndexOptions): Promise<SelectionResult> {
  const prompt = `You are given a user question and a root documentation tree.
Each document node has:
- node_id
- title
- summary
- path
Select the documents most likely to contain the answer.
Return only valid JSON:
{
  "documents": ["node_id_1", "node_id_2"]
}
User question:
${question}
Root tree:
${JSON.stringify(lightweightRootTree(rootTree), null, 2)}`;

  const response = await chatCompletion([{ role: "user", content: prompt }], options);
  const parsed = parseJsonObject<DocumentSelection>(response);
  return {
    ids: Array.isArray(parsed.documents) ? parsed.documents.filter((id) => typeof id === "string") : [],
    promptBytes: byteLength(prompt),
    rawResponse: response,
    responseBytes: byteLength(response)
  };
}

async function selectPageIndexNodes(question: string, treeWithoutText: unknown, options: PageIndexOptions): Promise<SelectionResult> {
  const prompt = `You are given a user question and a document tree.
Each node has:
- node_id
- title
- summary
- child nodes
Select the nodes most likely to contain the answer.
Return only valid JSON:
{
  "nodes": ["node_id_1", "node_id_2"]
}
User question:
${question}
Document tree:
${JSON.stringify(treeWithoutText, null, 2)}`;

  const response = await chatCompletion([{ role: "user", content: prompt }], options);
  const parsed = parseJsonObject<NodeSelection>(response);
  return {
    ids: Array.isArray(parsed.nodes) ? parsed.nodes.filter((id) => typeof id === "string") : [],
    promptBytes: byteLength(prompt),
    rawResponse: response,
    responseBytes: byteLength(response)
  };
}

function elapsedSince(startedAt: number): number {
  return Date.now() - startedAt;
}

function documentSkipReason(
  documentNode: RootTreeNode | undefined,
  manifestRecord: DocumentRecord | undefined,
  indexPath: string | undefined
): QuerySelectedDocument["skipReason"] | undefined {
  if (!documentNode) {
    return "missing_root_tree_document";
  }
  if (!manifestRecord) {
    return "missing_manifest_record";
  }
  if (!indexPath) {
    return "missing_index_path";
  }
  if (manifestRecord.status !== "ready") {
    return "document_not_ready";
  }
  return undefined;
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
  const trace: QueryTrace | undefined = options.trace
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

  logVerbose(`query resolve target=${path.resolve(target)}`);
  const resolveStartedAt = Date.now();
  const location = await runQueryStage("resolve", async () => await resolveQueryIndexLocation(target));
  logVerbose(`query index root=${location.rootDir} output=${location.outputDir ?? "(default)"}`);
  const { manifest, rootTree } = await runQueryStage("read-index", async () => ({
    manifest: await readJson<Manifest>(location.manifestPath),
    rootTree: await readJson<RootTreeNode>(location.rootTreePath)
  }));
  timings.resolve = elapsedSince(resolveStartedAt);

  const documentNodes = findDocumentNodes(rootTree);
  const manifestByDocId = new Map<string, DocumentRecord>(manifest.documents.map((record) => [record.docId, record]));
  logVerbose(`query select documents total=${manifest.documents.length}`);
  const selectDocumentsStartedAt = Date.now();
  const documentSelection = await runQueryStage("select-documents", async () => await selectDocuments(question, rootTree, options));
  const selectedDocumentIds = documentSelection.ids;
  if (trace) {
    trace.documentSelection = {
      promptBytes: documentSelection.promptBytes,
      responseBytes: documentSelection.responseBytes,
      rawResponse: documentSelection.rawResponse,
      selectedDocumentIds
    };
  }
  timings.selectDocuments = elapsedSince(selectDocumentsStartedAt);
  logVerbose(`query selected documents count=${selectedDocumentIds.length} ids=${selectedDocumentIds.join(",")}`);

  for (const docId of selectedDocumentIds) {
    const documentNode = documentNodes.get(docId);
    const manifestRecord = manifestByDocId.get(docId);
    const indexPath = documentNode?.index_path ?? manifestRecord?.indexPath;
    const available = Boolean(documentNode && manifestRecord && indexPath && manifestRecord.status === "ready");
    const skipReason = documentSkipReason(documentNode, manifestRecord, indexPath);

    const selectedDocument: QuerySelectedDocument = {
      docId,
      available,
      path: manifestRecord?.path ?? documentNode?.path,
      title: manifestRecord?.title ?? documentNode?.title,
      status: manifestRecord?.status,
      indexPath,
      selectionReason: "selected_by_document_planner"
    };
    if (skipReason) {
      selectedDocument.skipReason = skipReason;
    }
    selectedDocuments.push(selectedDocument);

    if (!available || !documentNode || !manifestRecord || !indexPath) {
      logVerbose(`query skip unavailable document id=${docId}`);
      warnings.push(`Selected document is unavailable: ${docId}`);
      addTraceFailure(trace, {
        stage: "read-document-index",
        code: skipReason ?? "document_unavailable",
        message: `Selected document is unavailable: ${docId}`,
        docId,
        path: manifestRecord?.path ?? documentNode?.path
      });
      continue;
    }

    logVerbose(`query read pageindex path=${manifestRecord.path}`);
    const pageIndexJson = await runQueryStage(
      "read-document-index",
      async () => await readJson<unknown>(resolveDocumentIndexPath(location.rootDir, indexPath, location.outputDir))
    );
    logVerbose(`query select nodes path=${manifestRecord.path}`);
    const selectNodesStartedAt = Date.now();
    const treeWithoutText = stripText(pageIndexJson);
    const nodeSelection = await runQueryStage("select-nodes", async () => await selectPageIndexNodes(question, treeWithoutText, options));
    const selectedNodeIds = nodeSelection.ids;
    trace?.nodeSelections.push({
      docId,
      path: manifestRecord.path,
      promptBytes: nodeSelection.promptBytes,
      responseBytes: nodeSelection.responseBytes,
      rawResponse: nodeSelection.rawResponse,
      selectedNodeIds
    });
    timings.selectNodes += elapsedSince(selectNodesStartedAt);
    logVerbose(`query selected nodes path=${manifestRecord.path} count=${selectedNodeIds.length} ids=${selectedNodeIds.join(",")}`);
    const nodeMap = buildNodeMap(pageIndexJson);
    let sourceMarkdown: string | undefined;

    for (const nodeId of selectedNodeIds) {
      const node = nodeMap.get(nodeId);
      const reference = `${manifestRecord.path}#${nodeId}`;
      const selectedNode: QuerySelectedNode = {
        docId,
        path: manifestRecord.path,
        nodeId,
        found: Boolean(node),
        hasText: false,
        reference,
        selectionReason: "selected_by_node_planner"
      };

      if (!node) {
        selectedNode.skipReason = "node_not_found";
        selectedNodes.push(selectedNode);
        warnings.push(`Selected node was not found: ${reference}`);
        addTraceFailure(trace, {
          stage: "extract-context",
          code: "node_not_found",
          message: `Selected node was not found: ${reference}`,
          docId,
          nodeId,
          path: manifestRecord.path,
          reference
        });
        continue;
      }

      let text = extractNodeText(node);
      if (!text) {
        sourceMarkdown ??= await readSourceMarkdown(location.rootDir, manifestRecord);
        text = sourceMarkdown ? extractNodeTextFromMarkdown(node, pageIndexJson, sourceMarkdown) : undefined;
        if (text) {
          logVerbose(`query fallback markdown text path=${manifestRecord.path} node=${nodeId}`);
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
          docId,
          nodeId,
          path: manifestRecord.path,
          reference
        });
        continue;
      }

      selectedNode.hasText = true;
      selectedNode.textBytes = byteLength(text);
      selectedNodes.push(selectedNode);
      sources.push({
        path: manifestRecord.path,
        nodeId,
        reference,
        text
      });
    }
  }

  if (sources.length === 0) {
    warnings.push("No relevant context was extracted from the selected index nodes.");
    addTraceFailure(trace, {
      stage: "extract-context",
      code: "empty_context",
      message: "No relevant context was extracted from the selected index nodes."
    });
  }

  const context = sources.length > 0 ? sources.map((source) => `Source: ${source.reference}\n${source.text}`).join("\n\n---\n\n") : "(no relevant context found)";
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
If the context is insufficient, say that the indexed documents do not contain enough information.
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
  timings.answer = elapsedSince(answerStartedAt);
  timings.total = elapsedSince(totalStartedAt);

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
