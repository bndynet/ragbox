import fs from "node:fs/promises";
import path from "node:path";
import { resolveRagboxConfig } from "./config-file";
import { indexFolder } from "./folder-index/indexer";
import {
  MANIFEST_FILE,
  PAGEINDEX_DIR,
  resolveDocumentIndexPath,
  ROOT_TREE_FILE
} from "./folder-index/manifest";
import { resolveQueryIndexLocation, queryFolder } from "./folder-index/query";
import { startWatchFolder, WatchFolderHandle, WatchFolderReadyResult } from "./folder-index/watch";
import {
  DocumentRecord,
  IndexCounts,
  IndexFolderResult,
  IndexProgressEvent,
  LlmChatRequest,
  LlmClient,
  Manifest,
  PageIndexOptions,
  QueryResult,
  RootTreeNode,
  WatchProgressEvent
} from "./folder-index/types";

export type {
  IndexCounts,
  IndexProgressEvent,
  LlmChatRequest,
  LlmClient,
  QueryResult,
  WatchProgressEvent
} from "./folder-index/types";

export type SdkOptions = {
  apiKey?: string;
  baseUrl?: string;
  configPath?: string;
  model?: string;
  outputDir?: string;
  source?: string;
  env?: NodeJS.ProcessEnv;
  llmClient?: LlmClient;
};

export type CreateIndexOptions = SdkOptions & {
  exclude?: string[];
  include?: string[];
  pageIndexCli?: string;
  pageIndexPython?: string;
  pageIndexOutputArg?: string;
  pageIndexExtraArgs?: string[];
  concurrency?: number;
  onProgress?: (event: IndexProgressEvent) => void;
};

export type QueryIndexOptions = SdkOptions & {
  trace?: boolean;
};

export type WatchIndexOptions = CreateIndexOptions & {
  debounceMs?: number;
  healthFile?: string;
  lockFile?: string;
  onEvent?: (event: WatchProgressEvent) => void;
  retryAttempts?: number;
  retryDelayMs?: number;
  staging?: boolean;
  stagingOutputDir?: string;
  webhookUrl?: string;
};

export type CreateIndexResult = {
  version: 1;
  rootDir: string;
  outputDir: string;
  manifestPath: string;
  rootTreePath: string;
  generatedAt: string;
  counts: IndexCounts;
  manifest: Manifest;
  rootTree: RootTreeNode;
};

export type WatchIndexReadyResult =
  | {
      ok: true;
      result: CreateIndexResult;
    }
  | {
      ok: false;
      error: string;
    };

export type WatchIndexHandle = {
  rootDir: string;
  outputDir: string;
  ready: Promise<WatchIndexReadyResult>;
  closed: Promise<void>;
  close: () => Promise<void>;
};

export type InspectIndexDocument = {
  docId: string;
  path: string;
  title: string;
  status: DocumentRecord["status"];
  indexPath: string;
  summary?: string;
  size: number;
  mtimeMs: number;
};

export type InspectIndexResult = {
  version: 1;
  target: string;
  rootDir: string;
  outputDir: string;
  manifestPath: string;
  rootTreePath: string;
  generatedAt: string;
  counts: IndexCounts;
  documents: InspectIndexDocument[];
};

export type ValidationIssue = {
  code: string;
  message: string;
  path?: string;
  docId?: string;
};

export type ValidateIndexResult = {
  version: 1;
  target: string;
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  inspect?: InspectIndexResult;
};

type ReadJsonResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      issue: ValidationIssue;
    };

function mergeDefined<T extends object>(...values: T[]): T {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (nestedValue !== undefined) {
        merged[key] = nestedValue;
      }
    }
  }
  return merged as T;
}

async function toPageIndexOptions(options: CreateIndexOptions | QueryIndexOptions | WatchIndexOptions = {}): Promise<PageIndexOptions> {
  const createOptions = options as CreateIndexOptions;
  const queryOptions = options as QueryIndexOptions;
  const watchOptions = options as WatchIndexOptions;
  const resolved = await resolveRagboxConfig({
    configPath: options.configPath,
    source: options.source
  });

  return mergeDefined<PageIndexOptions>(resolved.pageIndexOptions, {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    cliPath: createOptions.pageIndexCli,
    concurrency: createOptions.concurrency,
    env: options.env,
    exclude: createOptions.exclude,
    extraArgs: createOptions.pageIndexExtraArgs,
    include: createOptions.include,
    llmClient: options.llmClient,
    model: options.model,
    outputArg: createOptions.pageIndexOutputArg,
    outputDir: options.outputDir,
    progress: createOptions.onProgress,
    pythonPath: createOptions.pageIndexPython,
    trace: queryOptions.trace,
    watchDebounceMs: watchOptions.debounceMs,
    watchHealthFile: watchOptions.healthFile,
    watchLockFile: watchOptions.lockFile,
    watchProgress: watchOptions.onEvent,
    watchRetryAttempts: watchOptions.retryAttempts,
    watchRetryDelayMs: watchOptions.retryDelayMs,
    watchStaging: watchOptions.staging,
    watchStagingOutputDir: watchOptions.stagingOutputDir,
    watchWebhookUrl: watchOptions.webhookUrl
  });
}

function toIndexCounts(result: IndexFolderResult | Manifest): IndexCounts {
  if ("documents" in result) {
    const ready = result.documents.filter((record) => record.status === "ready").length;
    const failed = result.documents.filter((record) => record.status === "failed").length;

    return {
      total: result.documents.length,
      ready,
      failed,
      added: 0,
      modified: 0,
      retryFailed: 0,
      unchanged: 0,
      deleted: 0
    };
  }

  return {
    total: result.manifest.documents.length,
    ready: result.ready,
    failed: result.failed,
    added: result.added,
    modified: result.modified,
    retryFailed: result.retryFailed,
    unchanged: result.unchanged,
    deleted: result.deleted
  };
}

function toCreateIndexResult(result: IndexFolderResult): CreateIndexResult {
  return {
    version: 1,
    rootDir: result.manifest.rootDir,
    outputDir: result.outputDir,
    manifestPath: result.manifestPath,
    rootTreePath: result.rootTreePath,
    generatedAt: result.manifest.generatedAt,
    counts: toIndexCounts(result),
    manifest: result.manifest,
    rootTree: result.rootTree
  };
}

async function readJson<T>(filePath: string, code: string, label: string): Promise<ReadJsonResult<T>> {
  try {
    return {
      ok: true,
      value: JSON.parse(await fs.readFile(filePath, "utf8")) as T
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issue: {
        code,
        message: `${label} is not readable JSON: ${message}`,
        path: filePath
      }
    };
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveIndexFiles(target: string): Promise<{
  target: string;
  rootDir: string;
  outputDir: string;
  manifestPath: string;
  rootTreePath: string;
}> {
  const resolvedTarget = path.resolve(target);
  const candidates = [resolvedTarget, path.join(resolvedTarget, PAGEINDEX_DIR)];

  for (const outputDir of candidates) {
    const manifestPath = path.join(outputDir, MANIFEST_FILE);
    const rootTreePath = path.join(outputDir, ROOT_TREE_FILE);
    if ((await pathExists(manifestPath)) || (await pathExists(rootTreePath))) {
      return {
        target: resolvedTarget,
        rootDir: outputDir === candidates[1] ? resolvedTarget : outputDir,
        outputDir,
        manifestPath,
        rootTreePath
      };
    }
  }

  return {
    target: resolvedTarget,
    rootDir: resolvedTarget,
    outputDir: resolvedTarget,
    manifestPath: path.join(resolvedTarget, MANIFEST_FILE),
    rootTreePath: path.join(resolvedTarget, ROOT_TREE_FILE)
  };
}

function documentSummaries(manifest: Manifest): InspectIndexDocument[] {
  return manifest.documents.map((record) => ({
    docId: record.docId,
    path: record.path,
    title: record.title,
    status: record.status,
    indexPath: record.indexPath,
    summary: record.summary,
    size: record.size,
    mtimeMs: record.mtimeMs
  }));
}

function collectDocumentNodes(rootTree: RootTreeNode): RootTreeNode[] {
  const nodes: RootTreeNode[] = [];

  function visit(node: RootTreeNode): void {
    if (node.type === "document") {
      nodes.push(node);
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  }

  visit(rootTree);
  return nodes;
}

export async function createIndex(folder: string, options: CreateIndexOptions = {}): Promise<CreateIndexResult> {
  return toCreateIndexResult(await indexFolder(folder, await toPageIndexOptions(options)));
}

export async function queryIndex(target: string, question: string, options: QueryIndexOptions = {}): Promise<QueryResult> {
  return await queryFolder(target, question, await toPageIndexOptions(options));
}

export async function watchIndex(folder: string, options: WatchIndexOptions = {}): Promise<WatchIndexHandle> {
  const handle: WatchFolderHandle = await startWatchFolder(folder, await toPageIndexOptions(options));

  return {
    rootDir: handle.rootDir,
    outputDir: handle.outputDir,
    ready: handle.ready.then((ready: WatchFolderReadyResult): WatchIndexReadyResult => {
      if (!ready.ok) {
        return ready;
      }
      return {
        ok: true,
        result: toCreateIndexResult(ready.result)
      };
    }),
    closed: handle.closed,
    close: handle.close
  };
}

export async function inspectIndex(target: string): Promise<InspectIndexResult> {
  const location = await resolveQueryIndexLocation(target);
  const manifest = JSON.parse(await fs.readFile(location.manifestPath, "utf8")) as Manifest;

  await fs.access(location.rootTreePath);

  return {
    version: 1,
    target: path.resolve(target),
    rootDir: location.rootDir,
    outputDir: location.outputDir ?? path.join(location.rootDir, PAGEINDEX_DIR),
    manifestPath: location.manifestPath,
    rootTreePath: location.rootTreePath,
    generatedAt: manifest.generatedAt,
    counts: toIndexCounts(manifest),
    documents: documentSummaries(manifest)
  };
}

export async function validateIndex(target: string): Promise<ValidateIndexResult> {
  const location = await resolveIndexFiles(target);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let manifest: Manifest | undefined;
  let rootTree: RootTreeNode | undefined;

  if (!(await pathExists(location.manifestPath))) {
    errors.push({
      code: "missing_manifest",
      message: `Missing ${MANIFEST_FILE}`,
      path: location.manifestPath
    });
  } else {
    const result = await readJson<Manifest>(location.manifestPath, "invalid_manifest_json", "manifest");
    if (result.ok) {
      manifest = result.value;
      if (manifest.version !== 1) {
        errors.push({
          code: "invalid_manifest_version",
          message: `Unsupported manifest version: ${String(manifest.version)}`,
          path: location.manifestPath
        });
      }
      if (!Array.isArray(manifest.documents)) {
        errors.push({
          code: "invalid_manifest_documents",
          message: "Manifest documents must be an array",
          path: location.manifestPath
        });
      }
    } else {
      errors.push(result.issue);
    }
  }

  if (!(await pathExists(location.rootTreePath))) {
    errors.push({
      code: "missing_root_tree",
      message: `Missing ${ROOT_TREE_FILE}`,
      path: location.rootTreePath
    });
  } else {
    const result = await readJson<RootTreeNode>(location.rootTreePath, "invalid_root_tree_json", "root tree");
    if (result.ok) {
      rootTree = result.value;
      if (rootTree.node_id !== "root" || rootTree.type !== "root") {
        errors.push({
          code: "invalid_root_tree",
          message: "Root tree must have node_id=root and type=root",
          path: location.rootTreePath
        });
      }
    } else {
      errors.push(result.issue);
    }
  }

  if (manifest) {
    const rootDir = manifest.rootDir ? path.resolve(manifest.rootDir) : location.rootDir;
    for (const record of manifest.documents ?? []) {
      if (record.status !== "ready") {
        continue;
      }

      const indexPath = resolveDocumentIndexPath(rootDir, record.indexPath, location.outputDir);
      if (!(await pathExists(indexPath))) {
        errors.push({
          code: "missing_document_index",
          message: `Missing PageIndex JSON for ready document: ${record.path}`,
          path: indexPath,
          docId: record.docId
        });
      }
    }
  }

  if (manifest && rootTree) {
    const manifestByDocId = new Map(manifest.documents.map((record) => [record.docId, record]));
    const rootTreeDocumentNodes = collectDocumentNodes(rootTree);
    const rootTreeDocumentIds = new Set(rootTreeDocumentNodes.map((node) => node.node_id));

    for (const node of rootTreeDocumentNodes) {
      const record = manifestByDocId.get(node.node_id);
      if (!record) {
        errors.push({
          code: "root_tree_unknown_document",
          message: `Root tree references a document missing from manifest: ${node.node_id}`,
          path: node.path,
          docId: node.node_id
        });
        continue;
      }
      if (node.index_path && node.index_path !== record.indexPath) {
        errors.push({
          code: "root_tree_index_path_mismatch",
          message: `Root tree index path differs from manifest for ${record.path}`,
          path: node.path,
          docId: record.docId
        });
      }
    }

    for (const record of manifest.documents) {
      if (record.status === "ready" && !rootTreeDocumentIds.has(record.docId)) {
        errors.push({
          code: "manifest_document_missing_from_root_tree",
          message: `Ready document is missing from root tree: ${record.path}`,
          path: record.path,
          docId: record.docId
        });
      }
    }
  }

  const inspect =
    errors.length === 0 && manifest
      ? {
          version: 1 as const,
          target: location.target,
          rootDir: manifest.rootDir ? path.resolve(manifest.rootDir) : location.rootDir,
          outputDir: location.outputDir,
          manifestPath: location.manifestPath,
          rootTreePath: location.rootTreePath,
          generatedAt: manifest.generatedAt,
          counts: toIndexCounts(manifest),
          documents: documentSummaries(manifest)
        }
      : undefined;

  return {
    version: 1,
    target: location.target,
    ok: errors.length === 0,
    errors,
    warnings,
    inspect
  };
}
