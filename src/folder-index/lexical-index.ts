import fs from "node:fs/promises";
import { atomicWriteJson, getPageIndexPath, resolveDocumentIndexPath } from "./manifest";
import { buildNodeMap, extractNodeText, isObject, JsonObject, readJson } from "./query-utils";
import { DocumentRecord, LexicalIndexOptions, Manifest } from "./types";

export const LEXICAL_INDEX_FILE = "lexical-index.json";

export type LexicalIndexEntry = {
  docId: string;
  path: string;
  indexPath: string;
  nodeId: string;
  terms: string[];
};

export type LexicalIndex = {
  version: 1;
  rootDir: string;
  generatedAt: string;
  entries: LexicalIndexEntry[];
};

export type LexicalMatch = LexicalIndexEntry & {
  score: number;
  matchedTerms: string[];
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "where",
  "with"
]);

const DEFAULT_MIN_TERM_LENGTH = 2;

function normalizeOptions(options: LexicalIndexOptions = {}): Required<Pick<LexicalIndexOptions, "minTermLength">> & LexicalIndexOptions {
  return {
    ...options,
    minTermLength: options.minTermLength ?? DEFAULT_MIN_TERM_LENGTH
  };
}

function addTerm(terms: Set<string>, value: string, options: Required<Pick<LexicalIndexOptions, "minTermLength">> & LexicalIndexOptions): void {
  const term = value.toLowerCase().trim();
  if (term.length < options.minTermLength || STOP_WORDS.has(term)) {
    return;
  }
  if (options.maxTermLength !== undefined && term.length > options.maxTermLength) {
    return;
  }
  terms.add(term);
}

export function extractLexicalTerms(value: string, options: LexicalIndexOptions = {}): string[] {
  const normalizedOptions = normalizeOptions(options);
  const terms = new Set<string>();
  const matches = value.match(/--?[A-Za-z0-9][A-Za-z0-9_./:-]*|\/[A-Za-z0-9_./:-]+|[A-Za-z0-9][A-Za-z0-9_./:-]{1,}/g) ?? [];

  for (const rawMatch of matches) {
    const match = rawMatch.replace(/^[^\w/-]+|[^\w/.:-]+$/g, "");
    if (!match) {
      continue;
    }
    addTerm(terms, match, normalizedOptions);

    for (const part of match.split(/[./:-]+/)) {
      const normalizedPart = part.replace(/^-+/, "");
      addTerm(terms, normalizedPart, normalizedOptions);
    }
  }

  const sortedTerms = [...terms].sort();
  return normalizedOptions.maxTermsPerNode === undefined ? sortedTerms : sortedTerms.slice(0, normalizedOptions.maxTermsPerNode);
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

function hasLineNumber(value: JsonObject): boolean {
  for (const key of ["line_num", "lineNum", "line"]) {
    const lineNumber = value[key];
    if (typeof lineNumber === "number" && Number.isFinite(lineNumber) && lineNumber > 0) {
      return true;
    }
    if (typeof lineNumber === "string") {
      const parsed = Number.parseInt(lineNumber, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return true;
      }
    }
  }
  return false;
}

function stringField(value: JsonObject, key: string): string | undefined {
  const nestedValue = value[key];
  return typeof nestedValue === "string" && nestedValue.trim() ? nestedValue.trim() : undefined;
}

function collectIndexableNodes(tree: unknown): JsonObject[] {
  const nodes: JsonObject[] = [];
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
    if (getNodeId(value) && (extractNodeText(value) || hasLineNumber(value))) {
      nodes.push(value);
    }

    for (const nestedValue of Object.values(value)) {
      if (typeof nestedValue === "object" && nestedValue !== null) {
        visit(nestedValue);
      }
    }
  }

  visit(tree);
  return nodes;
}

function termsForNode(record: DocumentRecord, node: JsonObject, options: LexicalIndexOptions): string[] {
  const textParts = [
    record.path,
    record.title,
    record.summary,
    stringField(node, "title"),
    stringField(node, "summary"),
    extractNodeText(node)
  ].filter((value): value is string => Boolean(value));
  return extractLexicalTerms(textParts.join("\n"), options);
}

async function entriesForDocument(
  rootDir: string,
  outputDir: string | undefined,
  record: DocumentRecord,
  options: LexicalIndexOptions
): Promise<LexicalIndexEntry[]> {
  const pageIndexJson = await readJson<unknown>(resolveDocumentIndexPath(rootDir, record.indexPath, outputDir));
  const nodeMap = buildNodeMap(pageIndexJson);
  const entries: LexicalIndexEntry[] = [];

  for (const node of collectIndexableNodes(pageIndexJson)) {
    const nodeId = getNodeId(node);
    if (!nodeId || !nodeMap.has(nodeId)) {
      continue;
    }
    const terms = termsForNode(record, node, options);
    if (terms.length === 0) {
      continue;
    }
    entries.push({
      docId: record.docId,
      path: record.path,
      indexPath: record.indexPath,
      nodeId,
      terms
    });
  }

  return entries;
}

export async function buildLexicalIndex(rootDir: string, manifest: Manifest, outputDir?: string, options: LexicalIndexOptions = {}): Promise<LexicalIndex> {
  const entries: LexicalIndexEntry[] = [];

  for (const record of manifest.documents) {
    if (record.status !== "ready") {
      continue;
    }
    entries.push(...await entriesForDocument(rootDir, outputDir, record, options));
  }

  entries.sort((left, right) => left.path.localeCompare(right.path) || left.nodeId.localeCompare(right.nodeId));

  return {
    version: 1,
    rootDir: manifest.rootDir,
    generatedAt: manifest.generatedAt,
    entries
  };
}

export async function writeLexicalIndex(rootDir: string, manifest: Manifest, outputDir?: string, options: LexicalIndexOptions = {}): Promise<LexicalIndex> {
  const lexicalIndex = await buildLexicalIndex(rootDir, manifest, outputDir, options);
  await atomicWriteJson(getPageIndexPath(rootDir, LEXICAL_INDEX_FILE, outputDir), lexicalIndex);
  return lexicalIndex;
}

export async function readLexicalIndex(rootDir: string, outputDir?: string): Promise<LexicalIndex | undefined> {
  try {
    return await readJson<LexicalIndex>(getPageIndexPath(rootDir, LEXICAL_INDEX_FILE, outputDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function lexicalIndexExists(rootDir: string, outputDir?: string): Promise<boolean> {
  try {
    await fs.access(getPageIndexPath(rootDir, LEXICAL_INDEX_FILE, outputDir));
    return true;
  } catch {
    return false;
  }
}

export function searchLexicalIndex(
  lexicalIndex: LexicalIndex,
  question: string,
  options: {
    maxCandidates: number;
    maxDocuments: number;
    minScore: number;
  }
): LexicalMatch[] {
  const queryTerms = extractLexicalTerms(question);
  if (queryTerms.length === 0) {
    return [];
  }

  const matches: LexicalMatch[] = [];
  for (const entry of lexicalIndex.entries) {
    const entryTerms = new Set(entry.terms);
    const matchedTerms = queryTerms.filter((term) => entryTerms.has(term));
    const score = matchedTerms.length;
    if (score < options.minScore) {
      continue;
    }
    matches.push({
      ...entry,
      score,
      matchedTerms
    });
  }

  matches.sort((left, right) =>
    right.score - left.score ||
    left.path.localeCompare(right.path) ||
    left.nodeId.localeCompare(right.nodeId)
  );

  const selected: LexicalMatch[] = [];
  const selectedDocs = new Set<string>();
  for (const match of matches) {
    if (!selectedDocs.has(match.docId) && selectedDocs.size >= options.maxDocuments) {
      continue;
    }
    selected.push(match);
    selectedDocs.add(match.docId);
    if (selected.length >= options.maxCandidates) {
      break;
    }
  }

  return selected;
}
