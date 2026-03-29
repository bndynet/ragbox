export type DocumentStatus = "ready" | "failed" | "deleted";

export type Manifest = {
  version: 1;
  rootDir: string;
  generatedAt: string;
  documents: DocumentRecord[];
};

export type DocumentRecord = {
  docId: string;
  path: string;
  absolutePath: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
  title: string;
  summary?: string;
  indexPath: string;
  status: DocumentStatus;
  error?: string;
};

export type RootTreeNode = {
  node_id: string;
  type: "root" | "directory" | "document";
  title: string;
  summary?: string;
  path?: string;
  index_path?: string;
  children?: RootTreeNode[];
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmChatRequest = {
  messages: ChatMessage[];
  model: string;
  temperature: number;
};

export type LlmClient = {
  chatCompletion: (request: LlmChatRequest) => Promise<string>;
};

export type PageIndexRunner = "auto" | "single" | "batch";

export type PageIndexOptions = {
  pythonPath?: string;
  cliPath?: string;
  pageIndexRunner?: PageIndexRunner;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  llmClient?: LlmClient;
  concurrency?: number;
  exclude?: string[];
  include?: string[];
  outputDir?: string;
  outputArg?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  progress?: (event: IndexProgressEvent) => void;
  trace?: boolean;
  watchDebounceMs?: number;
  watchHealthFile?: string;
  watchLockFile?: string;
  watchProgress?: (event: WatchProgressEvent) => void;
  watchRetryAttempts?: number;
  watchRetryDelayMs?: number;
  watchStaging?: boolean;
  watchStagingOutputDir?: string;
  watchWebhookUrl?: string;
};

export type IndexProgressEvent =
  | {
      type: "scan";
      rootDir: string;
      outputDir: string;
      total: number;
      toIndex: number;
      unchanged: number;
      deleted: number;
    }
  | {
      type: "index-start";
      path: string;
      index: number;
      total: number;
    }
  | {
      type: "index-done";
      path: string;
      index: number;
      total: number;
      summary?: string;
    }
  | {
      type: "index-failed";
      path: string;
      index: number;
      total: number;
      error: string;
    }
  | {
      type: "write";
      manifestPath: string;
      rootTreePath: string;
    };

export type WatchProgressEvent =
  | {
      version: 1;
      timestamp: string;
      type: "watch-start";
      rootDir: string;
      outputDir: string;
      pid?: number;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-lock-acquired";
      rootDir: string;
      outputDir: string;
      lockFile: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-lock-released";
      rootDir: string;
      outputDir: string;
      lockFile: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-file-event";
      rootDir: string;
      outputDir: string;
      eventName: "add" | "change" | "unlink";
      path: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-index-start";
      rootDir: string;
      outputDir: string;
      reason: "initial" | "change";
      attempt: number;
      maxAttempts: number;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-index-retry";
      rootDir: string;
      outputDir: string;
      reason: "initial" | "change";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-index-done";
      rootDir: string;
      outputDir: string;
      reason: "initial" | "change";
      attempt: number;
      maxAttempts: number;
      result: IndexCounts;
      manifestPath: string;
      rootTreePath: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-index-partial-failure";
      rootDir: string;
      outputDir: string;
      reason: "initial" | "change";
      attempt: number;
      maxAttempts: number;
      failed: number;
      result: IndexCounts;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-index-failed";
      rootDir: string;
      outputDir: string;
      reason: "initial" | "change";
      attempt: number;
      maxAttempts: number;
      error: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-output-promoted";
      rootDir: string;
      outputDir: string;
      stagingOutputDir: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-health";
      rootDir: string;
      outputDir: string;
      healthFile: string;
      status: WatchHealthStatus;
      ok: boolean;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-health-failed";
      rootDir: string;
      outputDir: string;
      healthFile: string;
      error: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-webhook-failed";
      rootDir: string;
      outputDir: string;
      url: string;
      error: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-stop";
      rootDir: string;
      outputDir: string;
    };

export type WatchHealthStatus = "starting" | "indexing" | "ready" | "degraded" | "failed" | "stopped";

export type WatchHealthFile = {
  version: 1;
  ok: boolean;
  status: WatchHealthStatus;
  rootDir: string;
  outputDir: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  reason?: "initial" | "change";
  result?: IndexCounts;
  error?: string;
};

export type ScannedFile = {
  docId: string;
  path: string;
  absolutePath: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
  title: string;
  indexPath: string;
};

export type ManifestDiff = {
  added: ScannedFile[];
  modified: ScannedFile[];
  retryFailed: ScannedFile[];
  unchanged: ScannedFile[];
  deleted: DocumentRecord[];
  toIndex: ScannedFile[];
};

export type IndexCounts = {
  total: number;
  ready: number;
  failed: number;
  added: number;
  modified: number;
  retryFailed: number;
  unchanged: number;
  deleted: number;
};

export type IndexFolderResult = {
  manifest: Manifest;
  rootTree: RootTreeNode;
  outputDir: string;
  manifestPath: string;
  rootTreePath: string;
  added: number;
  modified: number;
  retryFailed: number;
  unchanged: number;
  deleted: number;
  failed: number;
  ready: number;
};

export type QuerySelectedDocument = {
  docId: string;
  available: boolean;
  path?: string;
  title?: string;
  status?: DocumentStatus;
  indexPath?: string;
  selectionReason: "selected_by_document_planner";
  skipReason?: "missing_root_tree_document" | "missing_manifest_record" | "missing_index_path" | "document_not_ready";
};

export type QuerySelectedNode = {
  docId: string;
  path: string;
  nodeId: string;
  found: boolean;
  hasText: boolean;
  reference?: string;
  selectionReason: "selected_by_node_planner" | "matched_query_text";
  skipReason?: "node_not_found" | "missing_text";
  textBytes?: number;
};

export type QuerySource = {
  path: string;
  nodeId: string;
  reference: string;
  text: string;
};

export type QueryTimings = {
  resolve: number;
  selectDocuments: number;
  selectNodes: number;
  answer: number;
  total: number;
};

export type QueryFailureStage =
  | "resolve"
  | "read-index"
  | "select-documents"
  | "read-document-index"
  | "select-nodes"
  | "extract-context"
  | "answer";

export type QueryTraceFailure = {
  stage: QueryFailureStage;
  code: string;
  message: string;
  docId?: string;
  nodeId?: string;
  path?: string;
  reference?: string;
};

export type QueryDocumentSelectionTrace = {
  promptBytes: number;
  responseBytes: number;
  rawResponse: string;
  selectedDocumentIds: string[];
};

export type QueryNodeSelectionTrace = {
  docId: string;
  path: string;
  promptBytes: number;
  responseBytes: number;
  rawResponse: string;
  selectedNodeIds: string[];
};

export type QueryContextTrace = {
  sourceCount: number;
  bytes: number;
  tokens: number;
};

export type QueryAnswerTrace = {
  promptBytes: number;
  responseBytes: number;
};

export type QueryTrace = {
  version: 1;
  documentSelection?: QueryDocumentSelectionTrace;
  nodeSelections: QueryNodeSelectionTrace[];
  context: QueryContextTrace;
  answer?: QueryAnswerTrace;
  failures: QueryTraceFailure[];
};

export type QueryResult = {
  version: 1;
  target: string;
  rootDir: string;
  outputDir: string;
  question: string;
  model: string;
  answer: string;
  contextBytes: number;
  contextTokens: number;
  selectedDocuments: QuerySelectedDocument[];
  selectedNodes: QuerySelectedNode[];
  sources: QuerySource[];
  warnings: string[];
  timingsMs: QueryTimings;
  trace?: QueryTrace;
};
