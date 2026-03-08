import fs from "node:fs/promises";
import path from "node:path";
import { loadPageIndexConfig } from "./config";
import {
  INDEXES_DIR,
  diffManifest,
  readManifest,
  recordFromScannedFile,
  removeDeletedIndexFiles,
  resolveDocumentIndexPath,
  resolvePageIndexDir,
  writeFileState,
  writeManifest
} from "./manifest";
import { runPageIndex, readPageIndexSummary } from "./pageindex-runner";
import { runWithConcurrency } from "./queue";
import { generateRootTree, writeRootTree } from "./root-tree";
import { scanMarkdownFiles } from "./scan";
import { DocumentRecord, IndexFolderResult, IndexProgressEvent, PageIndexOptions, ScannedFile } from "./types";
import { isStrictSubPath, normalizeAbsolutePath } from "./path-utils";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportProgress(options: PageIndexOptions, event: IndexProgressEvent): void {
  try {
    options.progress?.(event);
  } catch {
    // Progress reporting must never change indexing behavior.
  }
}

export async function indexFolder(folder: string, options: PageIndexOptions = {}): Promise<IndexFolderResult> {
  const rootDir = path.resolve(folder);
  const config = loadPageIndexConfig(options);
  const outputDir = resolvePageIndexDir(rootDir, config.outputDir);
  const manifestPath = path.join(outputDir, "manifest.json");
  const rootTreePath = path.join(outputDir, "root-tree.json");
  const excludedDirs = isStrictSubPath(rootDir, outputDir) ? [outputDir] : [];
  const previousManifest = await readManifest(rootDir, config.outputDir);
  const scannedFiles = await scanMarkdownFiles(rootDir, {
    exclude: config.exclude,
    excludedDirs,
    include: config.include
  });
  const diff = diffManifest(previousManifest, scannedFiles);
  const previousByPath = new Map(previousManifest.documents.map((record) => [record.path, record]));

  reportProgress(config, {
    type: "scan",
    rootDir,
    outputDir,
    total: scannedFiles.length,
    toIndex: diff.toIndex.length,
    unchanged: diff.unchanged.length,
    deleted: diff.deleted.length
  });

  await fs.mkdir(path.join(outputDir, INDEXES_DIR), { recursive: true });
  await removeDeletedIndexFiles(rootDir, diff.deleted, config.outputDir);

  const indexedRecords = await runWithConcurrency<ScannedFile, DocumentRecord>(
    diff.toIndex,
    config.concurrency,
    async (scannedFile, index) => {
      const absoluteOutputPath = resolveDocumentIndexPath(rootDir, scannedFile.indexPath, config.outputDir);
      const progressIndex = index + 1;
      const progressTotal = diff.toIndex.length;

      reportProgress(config, { type: "index-start", path: scannedFile.path, index: progressIndex, total: progressTotal });

      try {
        await runPageIndex(scannedFile.absolutePath, absoluteOutputPath, config);
        const summary = await readPageIndexSummary(absoluteOutputPath);
        reportProgress(config, {
          type: "index-done",
          path: scannedFile.path,
          index: progressIndex,
          total: progressTotal,
          summary
        });
        return recordFromScannedFile(scannedFile, { status: "ready", summary });
      } catch (error) {
        const previous = previousByPath.get(scannedFile.path);
        reportProgress(config, {
          type: "index-failed",
          path: scannedFile.path,
          index: progressIndex,
          total: progressTotal,
          error: errorMessage(error)
        });
        return recordFromScannedFile(scannedFile, {
          status: "failed",
          summary: previous?.summary,
          error: errorMessage(error)
        });
      }
    }
  );

  const indexedByPath = new Map(indexedRecords.map((record) => [record.path, record]));
  const documents: DocumentRecord[] = [];

  for (const scannedFile of scannedFiles) {
    const indexedRecord = indexedByPath.get(scannedFile.path);
    if (indexedRecord) {
      documents.push(indexedRecord);
      continue;
    }

    const previous = previousByPath.get(scannedFile.path);
    documents.push(
      recordFromScannedFile(scannedFile, {
        status: previous?.status === "ready" ? "ready" : "failed",
        summary: previous?.summary,
        error: previous?.status === "failed" ? previous.error : undefined
      })
    );
  }

  documents.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    version: 1 as const,
    rootDir: normalizeAbsolutePath(rootDir),
    generatedAt: new Date().toISOString(),
    documents
  };
  const rootTree = generateRootTree(manifest);

  await writeManifest(rootDir, manifest, config.outputDir);
  await writeRootTree(rootDir, rootTree, config.outputDir);
  await writeFileState(rootDir, manifest, config.outputDir);
  reportProgress(config, {
    type: "write",
    manifestPath,
    rootTreePath
  });

  return {
    manifest,
    rootTree,
    outputDir,
    manifestPath,
    rootTreePath,
    added: diff.added.length,
    modified: diff.modified.length,
    retryFailed: diff.retryFailed.length,
    unchanged: diff.unchanged.length,
    deleted: diff.deleted.length,
    failed: documents.filter((record) => record.status === "failed").length,
    ready: documents.filter((record) => record.status === "ready").length
  };
}
