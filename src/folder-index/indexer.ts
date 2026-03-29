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
import { runPageIndex, readPageIndexSummary, runPageIndexBatchPool } from "./pageindex-runner";
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

async function findStaleIndexFiles(rootDir: string, files: ScannedFile[], outputDir?: string): Promise<ScannedFile[]> {
  const staleFiles: ScannedFile[] = [];

  for (const file of files) {
    try {
      const stat = await fs.stat(resolveDocumentIndexPath(rootDir, file.indexPath, outputDir));
      if (stat.mtimeMs < file.mtimeMs - 1) {
        staleFiles.push(file);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        staleFiles.push(file);
        continue;
      }
      throw error;
    }
  }

  return staleFiles;
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
  const staleIndexFiles = await findStaleIndexFiles(rootDir, diff.unchanged, config.outputDir);
  const staleIndexPaths = new Set(staleIndexFiles.map((file) => file.path));
  const unchanged = diff.unchanged.filter((file) => !staleIndexPaths.has(file.path));
  const toIndex = [...diff.toIndex, ...staleIndexFiles];
  const previousByPath = new Map(previousManifest.documents.map((record) => [record.path, record]));

  reportProgress(config, {
    type: "scan",
    rootDir,
    outputDir,
    total: scannedFiles.length,
    toIndex: toIndex.length,
    unchanged: unchanged.length,
    deleted: diff.deleted.length
  });

  await fs.mkdir(path.join(outputDir, INDEXES_DIR), { recursive: true });
  await removeDeletedIndexFiles(rootDir, diff.deleted, config.outputDir);

  async function indexOne(scannedFile: ScannedFile, index: number): Promise<DocumentRecord> {
    const absoluteOutputPath = resolveDocumentIndexPath(rootDir, scannedFile.indexPath, config.outputDir);
    const progressIndex = index + 1;
    const progressTotal = toIndex.length;

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

  async function indexBatch(): Promise<DocumentRecord[]> {
    const outputPaths = toIndex.map((scannedFile) => resolveDocumentIndexPath(rootDir, scannedFile.indexPath, config.outputDir));
    const results = await runPageIndexBatchPool(
      toIndex.map((scannedFile, index) => ({
        inputPath: scannedFile.absolutePath,
        outputPath: outputPaths[index]
      })),
      config,
      {
        onJobStart: (_job, index) => {
          reportProgress(config, { type: "index-start", path: toIndex[index].path, index: index + 1, total: toIndex.length });
        }
      }
    );

    const records: DocumentRecord[] = [];
    for (let index = 0; index < toIndex.length; index += 1) {
      const scannedFile = toIndex[index];
      const result = results[index];
      if (result.ok) {
        const summary = await readPageIndexSummary(outputPaths[index]);
        reportProgress(config, {
          type: "index-done",
          path: scannedFile.path,
          index: index + 1,
          total: toIndex.length,
          summary
        });
        records.push(recordFromScannedFile(scannedFile, { status: "ready", summary }));
      } else {
        const previous = previousByPath.get(scannedFile.path);
        reportProgress(config, {
          type: "index-failed",
          path: scannedFile.path,
          index: index + 1,
          total: toIndex.length,
          error: result.error
        });
        records.push(
          recordFromScannedFile(scannedFile, {
            status: "failed",
            summary: previous?.summary,
            error: result.error
          })
        );
      }
    }
    return records;
  }

  const indexedRecords =
    config.pageIndexRunner === "single" || toIndex.length < 2
      ? await runWithConcurrency<ScannedFile, DocumentRecord>(toIndex, config.concurrency, indexOne)
      : await indexBatch();

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
    modified: diff.modified.length + staleIndexFiles.length,
    retryFailed: diff.retryFailed.length,
    unchanged: unchanged.length,
    deleted: diff.deleted.length,
    failed: documents.filter((record) => record.status === "failed").length,
    ready: documents.filter((record) => record.status === "ready").length
  };
}
