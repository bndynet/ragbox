import fs from "node:fs/promises";
import path from "node:path";
import { chatCompletion } from "./llm-client";
import { MANIFEST_FILE, PAGEINDEX_DIR, resolveDocumentIndexPath, ROOT_TREE_FILE } from "./manifest";
import { DocumentRecord, Manifest, PageIndexOptions, RootTreeNode } from "./types";

type JsonObject = Record<string, unknown>;

type DocumentSelection = {
  documents: string[];
};

type NodeSelection = {
  nodes: string[];
};

export type QueryIndexLocation = {
  rootDir: string;
  outputDir?: string;
  manifestPath: string;
  rootTreePath: string;
};

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

async function selectDocuments(question: string, rootTree: RootTreeNode, options: PageIndexOptions): Promise<string[]> {
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
  return Array.isArray(parsed.documents) ? parsed.documents.filter((id) => typeof id === "string") : [];
}

async function selectPageIndexNodes(question: string, treeWithoutText: unknown, options: PageIndexOptions): Promise<string[]> {
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
  return Array.isArray(parsed.nodes) ? parsed.nodes.filter((id) => typeof id === "string") : [];
}

export async function queryFolder(target: string, question: string, options: PageIndexOptions = {}): Promise<string> {
  logVerbose(`query resolve target=${path.resolve(target)}`);
  const location = await resolveQueryIndexLocation(target);
  logVerbose(`query index root=${location.rootDir} output=${location.outputDir ?? "(default)"}`);
  const manifest = await readJson<Manifest>(location.manifestPath);
  const rootTree = await readJson<RootTreeNode>(location.rootTreePath);
  const documentNodes = findDocumentNodes(rootTree);
  const manifestByDocId = new Map<string, DocumentRecord>(manifest.documents.map((record) => [record.docId, record]));
  logVerbose(`query select documents total=${manifest.documents.length}`);
  const selectedDocumentIds = await selectDocuments(question, rootTree, options);
  logVerbose(`query selected documents count=${selectedDocumentIds.length} ids=${selectedDocumentIds.join(",")}`);
  const contextParts: string[] = [];

  for (const docId of selectedDocumentIds) {
    const documentNode = documentNodes.get(docId);
    const manifestRecord = manifestByDocId.get(docId);
    const indexPath = documentNode?.index_path ?? manifestRecord?.indexPath;

    if (!documentNode || !manifestRecord || !indexPath || manifestRecord.status !== "ready") {
      logVerbose(`query skip unavailable document id=${docId}`);
      continue;
    }

    logVerbose(`query read pageindex path=${manifestRecord.path}`);
    const pageIndexJson = await readJson<unknown>(resolveDocumentIndexPath(location.rootDir, indexPath, location.outputDir));
    logVerbose(`query select nodes path=${manifestRecord.path}`);
    const selectedNodeIds = await selectPageIndexNodes(question, stripText(pageIndexJson), options);
    logVerbose(`query selected nodes path=${manifestRecord.path} count=${selectedNodeIds.length} ids=${selectedNodeIds.join(",")}`);
    const nodeMap = buildNodeMap(pageIndexJson);
    let sourceMarkdown: string | undefined;

    for (const nodeId of selectedNodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) {
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
        continue;
      }

      contextParts.push(`Source: ${manifestRecord.path}#${nodeId}\n${text}`);
    }
  }

  const context = contextParts.length > 0 ? contextParts.join("\n\n---\n\n") : "(no relevant context found)";
  logVerbose(`query final answer contextParts=${contextParts.length}`);
  const finalPrompt = `Answer the user question using only the provided context.
If the context is insufficient, say that the indexed documents do not contain enough information.
Include source references using the file path and node_id when possible.
User question:
${question}
Context:
${context}`;

  return await chatCompletion([{ role: "user", content: finalPrompt }], options);
}
