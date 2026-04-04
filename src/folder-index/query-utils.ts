import fs from "node:fs/promises";
import { RootTreeNode } from "./types";

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isVerbose(): boolean {
  return process.env.RAGBOX_VERBOSE === "1" || process.env.RAGBOX_E2E_VERBOSE === "1";
}

export function logVerbose(message: string): void {
  if (isVerbose()) {
    console.error(`[ragbox] ${message}`);
  }
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function estimateTokenCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? Math.ceil(trimmed.length / 4) : 0;
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

export function parseJsonObject<T>(raw: string): T {
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

export function lightweightRootTree(node: RootTreeNode): RootTreeNode {
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

export function findDocumentNodes(rootTree: RootTreeNode): Map<string, RootTreeNode> {
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

export function extractNodeText(node: JsonObject): string | undefined {
  const text = node.text;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function extractLexicalQueryTerms(question: string): string[] {
  const terms = new Set<string>();
  const codeLikeMatches = question.match(/[A-Za-z0-9_./:-]{6,}/g) ?? [];
  for (const match of codeLikeMatches) {
    terms.add(match.toLowerCase());
  }
  return [...terms];
}

export function findLexicalNodeMatches(tree: unknown, question: string): Set<string> {
  const terms = extractLexicalQueryTerms(question);
  const matches = new Set<string>();
  if (terms.length === 0) {
    return matches;
  }

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
    const text = extractNodeText(value)?.toLowerCase();
    if (nodeId && text && terms.some((term) => text.includes(term))) {
      matches.add(nodeId);
    }

    for (const nestedValue of Object.values(value)) {
      if (typeof nestedValue === "object" && nestedValue !== null) {
        visit(nestedValue);
      }
    }
  }

  visit(tree);
  return matches;
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

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
