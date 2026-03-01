import chokidar from "chokidar";
import path from "node:path";
import { loadPageIndexConfig } from "./config";
import { indexFolder } from "./indexer";
import { resolvePageIndexDir } from "./manifest";
import { isStrictSubPath, isSubPath } from "./path-utils";
import { PageIndexOptions } from "./types";

const WATCH_IGNORED = /(^|[/\\])(node_modules|\.git|\.pageindex|dist|build)([/\\]|$)/;

export async function watchFolder(folder: string, options: PageIndexOptions = {}): Promise<void> {
  const rootDir = path.resolve(folder);
  const config = loadPageIndexConfig(options);
  const outputDir = resolvePageIndexDir(rootDir, config.outputDir);
  const shouldIgnoreOutputDir = isStrictSubPath(rootDir, outputDir);
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

  async function runIndex(): Promise<void> {
    if (running) {
      pending = true;
      return;
    }

    running = true;
    pending = false;

    try {
      const result = await indexFolder(rootDir, options);
      console.log(
        `Indexed ${rootDir}: ready=${result.ready}, failed=${result.failed}, added=${result.added}, modified=${result.modified}, deleted=${result.deleted}, unchanged=${result.unchanged}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Index failed: ${message}`);
    } finally {
      running = false;
      if (pending) {
        await runIndex();
      }
    }
  }

  function scheduleIndex(eventName: string, changedPath: string): void {
    console.log(`${eventName}: ${changedPath}`);

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void runIndex();
    }, 500);
  }

  await runIndex();

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
