import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAbsolutePath, normalizeRelativePath } from "./path-utils";
import { DocumentRecord, Manifest, ManifestDiff, ScannedFile } from "./types";

export const PAGEINDEX_DIR = ".pageindex";
export const INDEXES_DIR = "indexes";
export const MANIFEST_FILE = "manifest.json";
export const ROOT_TREE_FILE = "root-tree.json";
export const FILE_STATE_FILE = path.join("state", "file-state.json");

export function createEmptyManifest(rootDir: string): Manifest {
  return {
    version: 1,
    rootDir: normalizeAbsolutePath(rootDir),
    generatedAt: new Date().toISOString(),
    documents: []
  };
}

export function resolvePageIndexDir(rootDir: string, outputDir?: string): string {
  return path.resolve(outputDir ?? path.join(rootDir, PAGEINDEX_DIR));
}

export function getPageIndexPath(rootDir: string, relativePath: string, outputDir?: string): string {
  return path.join(resolvePageIndexDir(rootDir, outputDir), relativePath);
}

export function resolveDocumentIndexPath(rootDir: string, indexPath: string, outputDir?: string): string {
  if (path.isAbsolute(indexPath)) {
    return indexPath;
  }

  const normalizedIndexPath = normalizeRelativePath(indexPath);
  if (normalizedIndexPath === PAGEINDEX_DIR || normalizedIndexPath.startsWith(`${PAGEINDEX_DIR}/`)) {
    return path.join(rootDir, normalizedIndexPath);
  }

  return path.join(resolvePageIndexDir(rootDir, outputDir), normalizedIndexPath);
}

export async function readManifest(rootDir: string, outputDir?: string): Promise<Manifest> {
  const manifestPath = getPageIndexPath(rootDir, MANIFEST_FILE, outputDir);

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as Manifest;
    return {
      ...manifest,
      documents: Array.isArray(manifest.documents) ? manifest.documents : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyManifest(rootDir);
    }
    throw error;
  }
}

export function diffManifest(previous: Manifest, scannedFiles: ScannedFile[]): ManifestDiff {
  const previousByPath = new Map(previous.documents.map((record) => [record.path, record]));
  const scannedByPath = new Map(scannedFiles.map((file) => [file.path, file]));

  const added: ScannedFile[] = [];
  const modified: ScannedFile[] = [];
  const retryFailed: ScannedFile[] = [];
  const unchanged: ScannedFile[] = [];
  const deleted: DocumentRecord[] = [];

  for (const scannedFile of scannedFiles) {
    const previousRecord = previousByPath.get(scannedFile.path);

    if (!previousRecord) {
      added.push(scannedFile);
      continue;
    }

    if (previousRecord.status === "failed") {
      retryFailed.push(scannedFile);
      continue;
    }

    if (previousRecord.contentHash !== scannedFile.contentHash) {
      modified.push(scannedFile);
      continue;
    }

    unchanged.push(scannedFile);
  }

  for (const record of previous.documents) {
    if (!scannedByPath.has(record.path)) {
      deleted.push(record);
    }
  }

  return {
    added,
    modified,
    retryFailed,
    unchanged,
    deleted,
    toIndex: [...added, ...modified, ...retryFailed]
  };
}

export function recordFromScannedFile(scannedFile: ScannedFile, fields: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    docId: scannedFile.docId,
    path: scannedFile.path,
    absolutePath: scannedFile.absolutePath,
    contentHash: scannedFile.contentHash,
    size: scannedFile.size,
    mtimeMs: scannedFile.mtimeMs,
    title: scannedFile.title,
    indexPath: scannedFile.indexPath,
    status: fields.status ?? "ready",
    summary: fields.summary,
    error: fields.error
  };
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function writeManifest(rootDir: string, manifest: Manifest, outputDir?: string): Promise<void> {
  await atomicWriteJson(getPageIndexPath(rootDir, MANIFEST_FILE, outputDir), manifest);
}

export async function writeFileState(rootDir: string, manifest: Manifest, outputDir?: string): Promise<void> {
  const state = {
    version: 1,
    generatedAt: manifest.generatedAt,
    files: manifest.documents.map((record) => ({
      path: record.path,
      absolutePath: record.absolutePath,
      docId: record.docId,
      contentHash: record.contentHash,
      size: record.size,
      mtimeMs: record.mtimeMs,
      indexPath: record.indexPath,
      status: record.status,
      error: record.error
    }))
  };

  await atomicWriteJson(getPageIndexPath(rootDir, FILE_STATE_FILE, outputDir), state);
}

export async function removeDeletedIndexFiles(rootDir: string, deletedRecords: DocumentRecord[], outputDir?: string): Promise<void> {
  await Promise.all(
    deletedRecords.map(async (record) => {
      try {
        await fs.rm(resolveDocumentIndexPath(rootDir, record.indexPath, outputDir), { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    })
  );
}
