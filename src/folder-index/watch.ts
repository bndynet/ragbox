import chokidar from "chokidar";
import path from "node:path";
import { loadPageIndexConfig } from "./config";
import { indexFolder } from "./indexer";
import { resolvePageIndexDir } from "./manifest";
import { isStrictSubPath, isSubPath } from "./path-utils";
import { isIncludedPath } from "./scan";
import { IndexCounts, IndexFolderResult, PageIndexOptions, WatchProgressEvent } from "./types";

const WATCH_IGNORED = /(^|[/\\])(node_modules|\.git|\.pageindex|dist|build)([/\\]|$)/;

type WatchProgressEventInput = WatchProgressEvent extends infer Event
  ? Event extends WatchProgressEvent
    ? Omit<Event, "version" | "timestamp">
    : never
  : never;

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

function reportWatchProgress(options: PageIndexOptions, event: WatchProgressEvent): void {
  try {
    options.watchProgress?.(event);
  } catch {
    // Watch progress reporting must never change watch behavior.
  }
}

export async function startWatchFolder(folder: string, options: PageIndexOptions = {}): Promise<WatchFolderHandle> {
  const rootDir = path.resolve(folder);
  const config = loadPageIndexConfig(options);
  const outputDir = resolvePageIndexDir(rootDir, config.outputDir);
  const shouldIgnoreOutputDir = isStrictSubPath(rootDir, outputDir);
  const hasStructuredProgress = Boolean(config.watchProgress);
  let watcher: chokidar.FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  let stopped = false;
  let stopReported = false;
  let readySettled = false;
  let closeStarted: Promise<void> | undefined;
  let resolveReady!: (value: WatchFolderReadyResult) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<WatchFolderReadyResult>((resolve) => {
    resolveReady = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

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
        reportWatchProgress(
          config,
          createWatchEvent({
            type: "watch-stop",
            rootDir,
            outputDir
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

    if (!shouldIgnoreOutputDir) {
      return false;
    }

    const absoluteCandidatePath = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(rootDir, candidatePath);
    return isSubPath(outputDir, absoluteCandidatePath);
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
    reportWatchProgress(
      config,
      createWatchEvent({
        type: "watch-index-start",
        rootDir,
        outputDir,
        reason
      })
    );

    try {
      const result = await indexFolder(rootDir, options);
      if (reason === "initial") {
        finishReady({ ok: true, result });
      }
      reportWatchProgress(
        config,
        createWatchEvent({
          type: "watch-index-done",
          rootDir,
          outputDir,
          reason,
          result: toIndexCounts(result),
          manifestPath: result.manifestPath,
          rootTreePath: result.rootTreePath
        })
      );
      if (!hasStructuredProgress) {
        console.log(
          `Indexed ${rootDir}: ready=${result.ready}, failed=${result.failed}, added=${result.added}, modified=${result.modified}, deleted=${result.deleted}, unchanged=${result.unchanged}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (reason === "initial") {
        finishReady({ ok: false, error: message });
      }
      reportWatchProgress(
        config,
        createWatchEvent({
          type: "watch-index-failed",
          rootDir,
          outputDir,
          reason,
          error: message
        })
      );
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
    }, 500);
  }

  reportWatchProgress(
    config,
    createWatchEvent({
      type: "watch-start",
      rootDir,
      outputDir
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
