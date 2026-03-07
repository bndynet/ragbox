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

export type PageIndexOptions = {
  pythonPath?: string;
  cliPath?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  concurrency?: number;
  outputDir?: string;
  outputArg?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  progress?: (event: IndexProgressEvent) => void;
  watchProgress?: (event: WatchProgressEvent) => void;
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
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-index-done";
      rootDir: string;
      outputDir: string;
      reason: "initial" | "change";
      result: IndexCounts;
      manifestPath: string;
      rootTreePath: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-index-failed";
      rootDir: string;
      outputDir: string;
      reason: "initial" | "change";
      error: string;
    }
  | {
      version: 1;
      timestamp: string;
      type: "watch-stop";
      rootDir: string;
      outputDir: string;
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
};

export type QuerySelectedNode = {
  docId: string;
  path: string;
  nodeId: string;
  found: boolean;
  hasText: boolean;
  reference?: string;
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

export type QueryResult = {
  version: 1;
  target: string;
  rootDir: string;
  outputDir: string;
  question: string;
  model: string;
  answer: string;
  selectedDocuments: QuerySelectedDocument[];
  selectedNodes: QuerySelectedNode[];
  sources: QuerySource[];
  warnings: string[];
  timingsMs: QueryTimings;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
