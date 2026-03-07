import chokidar from "chokidar";
import path from "node:path";
import { loadPageIndexConfig } from "./config";
import { indexFolder } from "./indexer";
import { resolvePageIndexDir } from "./manifest";
import { isStrictSubPath, isSubPath } from "./path-utils";
import { IndexCounts, IndexFolderResult, PageIndexOptions, WatchProgressEvent } from "./types";

const WATCH_IGNORED = /(^|[/\\])(node_modules|\.git|\.pageindex|dist|build)([/\\]|$)/;

type WatchProgressEventInput = WatchProgressEvent extends infer Event
  ? Event extends WatchProgressEvent
    ? Omit<Event, "version" | "timestamp">
    : never
  : never;

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

export async function watchFolder(folder: string, options: PageIndexOptions = {}): Promise<void> {
  const rootDir = path.resolve(folder);
  const config = loadPageIndexConfig(options);
  const outputDir = resolvePageIndexDir(rootDir, config.outputDir);
  const shouldIgnoreOutputDir = isStrictSubPath(rootDir, outputDir);
  const hasStructuredProgress = Boolean(config.watchProgress);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;

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
      if (pending) {
        await runIndex("change");
      }
    }
  }

  function scheduleIndex(eventName: "add" | "change" | "unlink", changedPath: string): void {
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
  await runIndex("initial");

  const watcher = chokidar.watch(["**/*.md", "**/*.mdx"], {
    cwd: rootDir,
    ignored: isIgnored,
    ignoreInitial: true,
    persistent: true
  });

  watcher
    .on("add", (changedPath) => scheduleIndex("add", changedPath))
    .on("change", (changedPath) => scheduleIndex("change", changedPath))
    .on("unlink", (changedPath) => scheduleIndex("unlink", changedPath));

  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
      }
      await watcher.close();
      reportWatchProgress(
        config,
        createWatchEvent({
          type: "watch-stop",
          rootDir,
          outputDir
        })
      );
      resolve();
    };

    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
  });
}
