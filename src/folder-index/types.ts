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

export type IndexFolderResult = {
  manifest: Manifest;
  rootTree: RootTreeNode;
  added: number;
  modified: number;
  retryFailed: number;
  unchanged: number;
  deleted: number;
  failed: number;
  ready: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
