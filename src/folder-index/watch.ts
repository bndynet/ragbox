import chokidar from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import { loadPageIndexConfig } from "./config";
import { indexFolder } from "./indexer";
import { atomicWriteJson, MANIFEST_FILE, resolvePageIndexDir, ROOT_TREE_FILE } from "./manifest";
import { isStrictSubPath, isSubPath } from "./path-utils";
import { isIncludedPath } from "./scan";
import { IndexCounts, IndexFolderResult, PageIndexOptions, WatchHealthFile, WatchHealthStatus, WatchProgressEvent } from "./types";

const WATCH_IGNORED = /(^|[/\\])(node_modules|\.git|\.pageindex|dist|build)([/\\]|$)/;

type WatchProgressEventInput = WatchProgressEvent extends infer Event
  ? Event extends WatchProgressEvent
    ? Omit<Event, "version" | "timestamp">
    : never
  : never;

type WatchIndexRunResult = {
  attempt: number;
  maxAttempts: number;
  result: IndexFolderResult;
};

class WatchIndexRunError extends Error {
  readonly attempt: number;
  readonly maxAttempts: number;

  constructor(error: unknown, attempt: number, maxAttempts: number) {
    super(errorMessage(error));
    this.name = "WatchIndexRunError";
    this.attempt = attempt;
    this.maxAttempts = maxAttempts;
  }
}

export type WatchFolderReadyResult =
  | {
      ok: true;
      result: IndexFolderResult;
    }
  | {
      ok: false;
      error: string;
    };

export type WatchFolderHandle = {
  rootDir: string;
  outputDir: string;
  ready: Promise<WatchFolderReadyResult>;
  closed: Promise<void>;
  close: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIndexCounts(result: IndexFolderResult): IndexCounts {
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

function createWatchEvent(event: WatchProgressEventInput): WatchProgressEvent {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    ...event
  } as WatchProgressEvent;
}

function reportWatchProgress(options: PageIndexOptions, event: WatchProgressEvent, sendWebhook = true): void {
  try {
    options.watchProgress?.(event);
  } catch {
    // Watch progress reporting must never change watch behavior.
  }

  if (!sendWebhook || !options.watchWebhookUrl) {
    return;
  }

  void (async () => {
    try {
      const response = await fetch(options.watchWebhookUrl as string, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event)
      });
      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }
    } catch (error) {
      reportWatchProgress(
        options,
        createWatchEvent({
          type: "watch-webhook-failed",
          rootDir: event.rootDir,
          outputDir: event.outputDir,
          url: options.watchWebhookUrl as string,
          error: errorMessage(error)
        }),
        false
      );
    }
  })();
}

async function acquireLock(lockFile: string, rootDir: string, outputDir: string): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockFile, "wx");
    await handle.writeFile(
      `${JSON.stringify(
        {
          version: 1,
          pid: process.pid,
          rootDir,
          outputDir,
          startedAt: new Date().toISOString()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Watch lock already exists: ${lockFile}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }

  return async () => {
    await fs.rm(lockFile, { force: true });
  };
}

async function prepareStagingOutput(outputDir: string, stagingOutputDir: string): Promise<void> {
  await fs.rm(stagingOutputDir, { force: true, recursive: true });
  if (await pathExists(outputDir)) {
    await fs.cp(outputDir, stagingOutputDir, { recursive: true });
    return;
  }
  await fs.mkdir(stagingOutputDir, { recursive: true });
}

async function promoteStagingOutput(outputDir: string, stagingOutputDir: string): Promise<void> {
  const backupDir = `${outputDir}.previous-${process.pid}-${Date.now()}`;

  if (!(await pathExists(outputDir))) {
    await fs.rename(stagingOutputDir, outputDir);
    return;
  }

  await fs.rm(backupDir, { force: true, recursive: true });
  await fs.rename(outputDir, backupDir);
  try {
    await fs.rename(stagingOutputDir, outputDir);
    await fs.rm(backupDir, { force: true, recursive: true });
  } catch (error) {
    try {
      if (await pathExists(backupDir)) {
        await fs.rm(outputDir, { force: true, recursive: true });
        await fs.rename(backupDir, outputDir);
      }
    } catch {
      // Preserve the original promotion error; rollback best-effort failed.
    }
    throw error;
  }
}

function withOutputDir(result: IndexFolderResult, outputDir: string): IndexFolderResult {
  return {
    ...result,
    outputDir,
    manifestPath: path.join(outputDir, MANIFEST_FILE),
    rootTreePath: path.join(outputDir, ROOT_TREE_FILE)
  };
}

export async function startWatchFolder(folder: string, options: PageIndexOptions = {}): Promise<WatchFolderHandle> {
  const rootDir = path.resolve(folder);
  const config = loadPageIndexConfig(options);
  const outputDir = resolvePageIndexDir(rootDir, config.outputDir);
  const lockFile = config.watchLockFile ? path.resolve(config.watchLockFile) : undefined;
  const healthFile = config.watchHealthFile ? path.resolve(config.watchHealthFile) : undefined;
  const retryAttempts = Math.max(0, config.watchRetryAttempts ?? 0);
  const retryDelayMs = Math.max(0, config.watchRetryDelayMs ?? 1000);
  const maxAttempts = retryAttempts + 1;
  const debounceMs = Math.max(0, config.watchDebounceMs ?? 500);
  const stagingOutputDir = config.watchStaging
    ? path.resolve(config.watchStagingOutputDir ?? `${outputDir}.staging`)
    : undefined;
  const ignoredOutputDirs = [outputDir, stagingOutputDir]
    .filter((value): value is string => Boolean(value))
    .filter((candidate) => isStrictSubPath(rootDir, candidate));
  const hasStructuredProgress = Boolean(config.watchProgress);
  const startedAt = new Date().toISOString();
  let watcher: chokidar.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  let stopped = false;
  let stopReported = false;
  let readySettled = false;
  let closeStarted: Promise<void> | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  let lastSuccessAt: string | undefined;
  let lastFailureAt: string | undefined;
  let lastHealthResult: IndexCounts | undefined;
  let lastHealthError: string | undefined;
  let resolveReady!: (value: WatchFolderReadyResult) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<WatchFolderReadyResult>((resolve) => {
    resolveReady = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  async function writeHealth(
    status: WatchHealthStatus,
    reason?: "initial" | "change",
    fields: {
      error?: string;
      result?: IndexCounts;
    } = {}
  ): Promise<void> {
    if (!healthFile) {
      return;
    }

    const updatedAt = new Date().toISOString();
    if (fields.result) {
      lastHealthResult = fields.result;
    }
    if (fields.error) {
      lastHealthError = fields.error;
    }

    const health: WatchHealthFile = {
      version: 1,
      ok: status === "ready",
      status,
      rootDir,
      outputDir,
      pid: process.pid,
      startedAt,
      updatedAt,
      lastSuccessAt,
      lastFailureAt,
      reason,
      result: fields.result ?? lastHealthResult,
      error: fields.error ?? lastHealthError
    };

    try {
      await atomicWriteJson(healthFile, health);
      reportWatchProgress(
        config,
        createWatchEvent({
          type: "watch-health",
          rootDir,
          outputDir,
          healthFile,
          status,
          ok: health.ok
        })
      );
    } catch (error) {
      reportWatchProgress(
        config,
        createWatchEvent({
          type: "watch-health-failed",
          rootDir,
          outputDir,
          healthFile,
          error: errorMessage(error)
        })
      );
    }
  }

  async function finishClose(): Promise<void> {
    if (closeStarted) {
      return await closeStarted;
    }

    closeStarted = (async () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (watcher) {
        await watcher.close();
        watcher = undefined;
      }
      if (!stopReported) {
        stopReported = true;
        await writeHealth("stopped");
        reportWatchProgress(
          config,
          createWatchEvent({
            type: "watch-stop",
            rootDir,
            outputDir
          })
        );
      }
      if (releaseLock && lockFile) {
        await releaseLock();
        releaseLock = undefined;
        reportWatchProgress(
          config,
          createWatchEvent({
            type: "watch-lock-released",
            rootDir,
            outputDir,
            lockFile
          })
        );
      }
      resolveClosed();
    })();

    return await closeStarted;
  }

  async function close(): Promise<void> {
    stopped = true;
    finishReady({ ok: false, error: "Watch closed before initial index completed" });
    if (!running) {
      await finishClose();
    }
    return await closed;
  }

  function finishReady(value: WatchFolderReadyResult): void {
    if (!readySettled) {
      readySettled = true;
      resolveReady(value);
    }
  }

  function isIgnored(candidatePath: string): boolean {
    if (WATCH_IGNORED.test(candidatePath)) {
      return true;
    }

    if (ignoredOutputDirs.length === 0) {
      return false;
    }

    const absoluteCandidatePath = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(rootDir, candidatePath);
    return ignoredOutputDirs.some((ignoredOutputDir) => isSubPath(ignoredOutputDir, absoluteCandidatePath));
  }

  async function runIndexAttempt(reason: "initial" | "change", attempt: number): Promise<IndexFolderResult> {
    reportWatchProgress(
      config,
      createWatchEvent({
        type: "watch-index-start",
        rootDir,
        outputDir,
        reason,
        attempt,
        maxAttempts
      })
    );
    await writeHealth("indexing", reason);

    if (!stagingOutputDir) {
      return await indexFolder(rootDir, config);
    }

    await prepareStagingOutput(outputDir, stagingOutputDir);
    const stagedResult = await indexFolder(rootDir, {
      ...config,
      outputDir: stagingOutputDir
    });

    if (stagedResult.failed > 0) {
      return stagedResult;
    }

    await promoteStagingOutput(outputDir, stagingOutputDir);
    reportWatchProgress(
      config,
      createWatchEvent({
        type: "watch-output-promoted",
        rootDir,
        outputDir,
        stagingOutputDir
      })
    );
    return withOutputDir(stagedResult, outputDir);
  }

  async function reportRetry(reason: "initial" | "change", attempt: number, error: string): Promise<void> {
    reportWatchProgress(
      config,
      createWatchEvent({
        type: "watch-index-retry",
        rootDir,
        outputDir,
        reason,
        attempt,
        maxAttempts,
        delayMs: retryDelayMs,
        error
      })
    );

    if (retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  async function runIndexWithRetry(reason: "initial" | "change"): Promise<WatchIndexRunResult> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await runIndexAttempt(reason, attempt);
        if (result.failed > 0) {
          const counts = toIndexCounts(result);
          const message = `Index completed with ${result.failed} failed document(s)`;
          reportWatchProgress(
            config,
            createWatchEvent({
              type: "watch-index-partial-failure",
              rootDir,
              outputDir,
              reason,
              attempt,
              maxAttempts,
              failed: result.failed,
              result: counts
            })
          );

          if (attempt < maxAttempts && !stopped) {
            await reportRetry(reason, attempt, message);
            continue;
          }

          if (stagingOutputDir) {
            throw new Error(`${message}; staging output was not promoted`);
          }
        }

        return {
          attempt,
          maxAttempts,
          result
        };
      } catch (error) {
        if (attempt < maxAttempts && !stopped) {
          await reportRetry(reason, attempt, errorMessage(error));
          continue;
        }
        throw new WatchIndexRunError(error, attempt, maxAttempts);
      }
    }

    throw new WatchIndexRunError("Index did not run", maxAttempts, maxAttempts);
  }

  async function runIndex(reason: "initial" | "change"): Promise<void> {
    if (running) {
      pending = true;
      return;
    }
    if (stopped) {
      return;
    }

    running = true;
    pending = false;

    try {
      const run = await runIndexWithRetry(reason);
      const counts = toIndexCounts(run.result);
      const healthStatus: WatchHealthStatus = run.result.failed > 0 ? "degraded" : "ready";
      if (healthStatus === "ready") {
        lastSuccessAt = new Date().toISOString();
        lastHealthError = undefined;
      } else {
        lastFailureAt = new Date().toISOString();
        lastHealthError = `Index completed with ${run.result.failed} failed document(s)`;
      }
      await writeHealth(healthStatus, reason, { result: counts, error: lastHealthError });
      reportWatchProgress(
        config,
        createWatchEvent({
          type: "watch-index-done",
          rootDir,
          outputDir,
          reason,
          attempt: run.attempt,
          maxAttempts: run.maxAttempts,
          result: counts,
          manifestPath: run.result.manifestPath,
          rootTreePath: run.result.rootTreePath
        })
      );
      if (reason === "initial") {
        finishReady({ ok: true, result: run.result });
      }
      if (!hasStructuredProgress) {
        console.log(
          `Indexed ${rootDir}: ready=${run.result.ready}, failed=${run.result.failed}, added=${run.result.added}, modified=${run.result.modified}, deleted=${run.result.deleted}, unchanged=${run.result.unchanged}`
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      const attempt = error instanceof WatchIndexRunError ? error.attempt : maxAttempts;
      const failedMaxAttempts = error instanceof WatchIndexRunError ? error.maxAttempts : maxAttempts;
      lastFailureAt = new Date().toISOString();
      lastHealthError = message;
      await writeHealth("failed", reason, { error: message });
      reportWatchProgress(
        config,
        createWatchEvent({
          type: "watch-index-failed",
          rootDir,
          outputDir,
          reason,
          attempt,
          maxAttempts: failedMaxAttempts,
          error: message
        })
      );
      if (reason === "initial") {
        finishReady({ ok: false, error: message });
      }
      if (!hasStructuredProgress) {
        console.error(`Index failed: ${message}`);
      }
    } finally {
      running = false;
      if (pending && !stopped) {
        await runIndex("change");
      } else if (stopped) {
        await finishClose();
      }
    }
  }

  function scheduleIndex(eventName: "add" | "change" | "unlink", changedPath: string): void {
    if (stopped) {
      return;
    }
    if (!isIncludedPath(changedPath, { exclude: config.exclude, include: config.include })) {
      return;
    }

    reportWatchProgress(
      config,
      createWatchEvent({
        type: "watch-file-event",
        rootDir,
        outputDir,
        eventName,
        path: changedPath
      })
    );
    if (!hasStructuredProgress) {
      console.log(`${eventName}: ${changedPath}`);
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void runIndex("change");
    }, debounceMs);
  }

  if (lockFile) {
    releaseLock = await acquireLock(lockFile, rootDir, outputDir);
    reportWatchProgress(
      config,
      createWatchEvent({
        type: "watch-lock-acquired",
        rootDir,
        outputDir,
        lockFile
      })
    );
  }

  await writeHealth("starting");
  reportWatchProgress(
    config,
    createWatchEvent({
      type: "watch-start",
      rootDir,
      outputDir,
      pid: process.pid
    })
  );

  void (async () => {
    await runIndex("initial");
    if (stopped) {
      await finishClose();
      return;
    }

    watcher = chokidar.watch(["**/*.md", "**/*.mdx"], {
      cwd: rootDir,
      ignored: isIgnored,
      ignoreInitial: true,
      persistent: true
    });

    watcher
      .on("add", (changedPath) => scheduleIndex("add", changedPath))
      .on("change", (changedPath) => scheduleIndex("change", changedPath))
      .on("unlink", (changedPath) => scheduleIndex("unlink", changedPath));

    if (stopped) {
      await finishClose();
    }
  })();

  return {
    rootDir,
    outputDir,
    ready,
    closed,
    close
  };
}

export async function watchFolder(folder: string, options: PageIndexOptions = {}): Promise<void> {
  const handle = await startWatchFolder(folder, options);

  const stop = (): void => {
    void handle.close();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await handle.closed;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
