#!/usr/bin/env node
import { Command } from "commander";
import { indexFolder } from "./folder-index/indexer";
import { queryFolder } from "./folder-index/query";
import { watchFolder } from "./folder-index/watch";
import { IndexCounts, IndexFolderResult, IndexProgressEvent, PageIndexOptions } from "./folder-index/types";

function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return parsed;
}

function isVerbose(): boolean {
  return process.env.RAGBOX_VERBOSE === "1" || process.env.RAGBOX_E2E_VERBOSE === "1";
}

function logProgress(event: IndexProgressEvent): void {
  if (!isVerbose()) {
    return;
  }

  switch (event.type) {
    case "scan":
      console.error(
        `[ragbox] scan root=${event.rootDir} output=${event.outputDir} total=${event.total} toIndex=${event.toIndex} unchanged=${event.unchanged} deleted=${event.deleted}`
      );
      break;
    case "index-start":
      console.error(`[ragbox] index start ${event.index}/${event.total} ${event.path}`);
      break;
    case "index-done":
      console.error(`[ragbox] index done ${event.index}/${event.total} ${event.path}`);
      if (event.summary) {
        console.error(`[ragbox] summary ${event.path}: ${event.summary}`);
      }
      break;
    case "index-failed":
      console.error(`[ragbox] index failed ${event.index}/${event.total} ${event.path}: ${event.error}`);
      break;
    case "write":
      console.error(`[ragbox] wrote manifest=${event.manifestPath}`);
      console.error(`[ragbox] wrote rootTree=${event.rootTreePath}`);
      break;
  }
}

type SharedCommandOptions = {
  apiKey?: string;
  baseUrl?: string;
  json?: boolean;
  model?: string;
};

type IndexCommandOptions = SharedCommandOptions & {
  concurrency?: number;
  outputDir?: string;
  pageindexPython?: string;
};

type WatchCommandOptions = IndexCommandOptions & {
  jsonl?: boolean;
};

type IndexJsonOutput = {
  version: 1;
  command: "index";
  rootDir: string;
  outputDir: string;
  manifestPath: string;
  rootTreePath: string;
  generatedAt: string;
  counts: IndexCounts;
};

function addLlmOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "OpenAI-compatible API key")
    .option("--base-url <url>", "OpenAI-compatible API base URL")
    .option("--model <model>", "LLM model");
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function writeJsonLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

function indexCounts(result: IndexFolderResult): IndexCounts {
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

function indexJsonOutput(result: IndexFolderResult): IndexJsonOutput {
  return {
    version: 1,
    command: "index",
    rootDir: result.manifest.rootDir,
    outputDir: result.outputDir,
    manifestPath: result.manifestPath,
    rootTreePath: result.rootTreePath,
    generatedAt: result.manifest.generatedAt,
    counts: indexCounts(result)
  };
}

function logProgressAsJsonLine(event: IndexProgressEvent): void {
  writeJsonLine({
    version: 1,
    timestamp: new Date().toISOString(),
    type: "index-progress",
    event
  });
}

function buildOptions(commandOptions: IndexCommandOptions, progress: (event: IndexProgressEvent) => void = logProgress): PageIndexOptions {
  return {
    apiKey: commandOptions.apiKey,
    baseUrl: commandOptions.baseUrl,
    concurrency: commandOptions.concurrency,
    model: commandOptions.model,
    outputDir: commandOptions.outputDir,
    pythonPath: commandOptions.pageindexPython,
    progress
  };
}

function buildQueryOptions(commandOptions: SharedCommandOptions): PageIndexOptions {
  return {
    apiKey: commandOptions.apiKey,
    baseUrl: commandOptions.baseUrl,
    model: commandOptions.model
  };
}

async function main(): Promise<void> {
  const program = new Command();

  program.name("ragbox").description("Index and query a Markdown/MDX folder with PageIndex").version("0.1.0");

  addLlmOptions(
    program
      .command("index")
      .argument("<folder>", "folder to index")
      .option("-c, --concurrency <number>", "PageIndex concurrency", parseConcurrency)
      .option("-o, --output-dir <folder>", "folder for ragbox index files")
      .option("--pageindex-python <path>", "Python executable used to run PageIndex")
      .option("--json", "print a stable JSON result")
  )
    .action(async (folder: string, commandOptions: IndexCommandOptions) => {
      const result = await indexFolder(folder, buildOptions(commandOptions));
      if (commandOptions.json) {
        writeJson(indexJsonOutput(result));
        return;
      }
      console.log(`Indexed ${folder}`);
      console.log(`ready=${result.ready}`);
      console.log(`failed=${result.failed}`);
      console.log(`added=${result.added}`);
      console.log(`modified=${result.modified}`);
      console.log(`retryFailed=${result.retryFailed}`);
      console.log(`deleted=${result.deleted}`);
      console.log(`unchanged=${result.unchanged}`);
    });

  addLlmOptions(
    program
      .command("query")
      .argument("<target>", "docs folder or ragbox output directory")
      .argument("<question>", "question to answer")
      .option("--json", "print a stable JSON result with selections and sources")
  )
    .action(async (target: string, question: string, commandOptions: SharedCommandOptions) => {
      const result = await queryFolder(target, question, buildQueryOptions(commandOptions));
      if (commandOptions.json) {
        writeJson(result);
        return;
      }
      console.log(result.answer);
    });

  addLlmOptions(
    program
      .command("watch")
      .argument("<folder>", "folder to watch")
      .option("-c, --concurrency <number>", "PageIndex concurrency", parseConcurrency)
      .option("-o, --output-dir <folder>", "folder for ragbox index files")
      .option("--pageindex-python <path>", "Python executable used to run PageIndex")
      .option("--jsonl", "print stable JSON Lines watch and index progress events")
  )
    .action(async (folder: string, commandOptions: WatchCommandOptions) => {
      const options = buildOptions(commandOptions, commandOptions.jsonl ? logProgressAsJsonLine : logProgress);
      if (commandOptions.jsonl) {
        options.watchProgress = writeJsonLine;
      }
      await watchFolder(folder, options);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
