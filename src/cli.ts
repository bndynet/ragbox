#!/usr/bin/env node
import fs from "node:fs/promises";
import { Command } from "commander";
import { resolveRagboxConfig, writeDefaultRagboxConfig } from "./config-file";
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
  source?: string;
};

type IndexCommandOptions = SharedCommandOptions & {
  concurrency?: number;
  outputDir?: string;
  pageindexCli?: string;
  pageindexPython?: string;
};

type WatchCommandOptions = IndexCommandOptions & {
  jsonl?: boolean;
};

type InitCommandOptions = {
  docsDir?: string;
  force?: boolean;
  output?: string;
  outputDir?: string;
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

function addProjectOptions(command: Command): Command {
  return command.option("--source <name>", "ragbox config source");
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

async function loadCommandConfig(command: Command, commandOptions: SharedCommandOptions): Promise<{
  rootDir?: string;
  options: PageIndexOptions;
}> {
  const globalOptions = command.parent?.opts<{ config?: string }>() ?? {};
  const resolved = await resolveRagboxConfig({
    configPath: globalOptions.config,
    source: commandOptions.source
  });

  return {
    rootDir: resolved.rootDir,
    options: resolved.pageIndexOptions
  };
}

function mergeDefined<T extends object>(...values: T[]): T {
  const merged: Record<string, unknown> = {};
  for (const value of values) {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (nestedValue !== undefined) {
        merged[key] = nestedValue;
      }
    }
  }
  return merged as T;
}

function buildOptions(
  configOptions: PageIndexOptions,
  commandOptions: IndexCommandOptions,
  progress: (event: IndexProgressEvent) => void = logProgress
): PageIndexOptions {
  return mergeDefined<PageIndexOptions>({
    ...configOptions,
    progress
  }, {
    apiKey: commandOptions.apiKey,
    baseUrl: commandOptions.baseUrl,
    concurrency: commandOptions.concurrency,
    cliPath: commandOptions.pageindexCli,
    model: commandOptions.model,
    outputDir: commandOptions.outputDir,
    pythonPath: commandOptions.pageindexPython
  });
}

function buildQueryOptions(configOptions: PageIndexOptions, commandOptions: SharedCommandOptions): PageIndexOptions {
  return mergeDefined<PageIndexOptions>({
    ...configOptions
  }, {
    apiKey: commandOptions.apiKey,
    baseUrl: commandOptions.baseUrl,
    model: commandOptions.model
  });
}

function requireFolder(folder: string | undefined, commandName: string): string {
  if (!folder) {
    throw new Error(`Missing folder. Pass a folder argument or configure a source rootDir before running ragbox ${commandName}.`);
  }
  return folder;
}

function requireTarget(target: string | undefined): string {
  if (!target) {
    throw new Error("Missing query target. Pass a target argument or configure a source with outputDir/rootDir.");
  }
  return target;
}

function requireQuestion(question: string | undefined): string {
  if (!question) {
    throw new Error("Missing question.");
  }
  return question;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("ragbox")
    .description("Index and query a Markdown/MDX folder with PageIndex")
    .version("0.1.0")
    .option("--config <path-or-name>", "ragbox config file path, or a name like prod for ragbox.config.prod.json");

  program
    .command("init")
    .description("create a ragbox.config.json file")
    .option("--docs-dir <folder>", "default docs folder in the generated config", "./docs")
    .option("-f, --force", "overwrite an existing config file")
    .option("-o, --output <path>", "config file path")
    .option("--output-dir <folder>", "default index output directory in the generated config", "./.ragbox-index")
    .action(async (commandOptions: InitCommandOptions) => {
      const configPath = await writeDefaultRagboxConfig({
        configPath: commandOptions.output,
        docsDir: commandOptions.docsDir,
        force: commandOptions.force,
        outputDir: commandOptions.outputDir
      });
      console.log(`Created ${configPath}`);
    });

  addProjectOptions(
    addLlmOptions(
      program
      .command("index")
      .argument("[folder]", "folder to index")
      .option("-c, --concurrency <number>", "PageIndex concurrency", parseConcurrency)
      .option("--pageindex-cli <path>", "PageIndex script path")
      .option("-o, --output-dir <folder>", "folder for ragbox index files")
      .option("--pageindex-python <path>", "Python executable used to run PageIndex")
      .option("--json", "print a stable JSON result")
    )
  )
    .action(async (folder: string | undefined, commandOptions: IndexCommandOptions, command: Command) => {
      const loaded = await loadCommandConfig(command, commandOptions);
      const indexFolderPath = requireFolder(folder ?? loaded.rootDir, "index");
      const result = await indexFolder(indexFolderPath, buildOptions(loaded.options, commandOptions));
      if (commandOptions.json) {
        writeJson(indexJsonOutput(result));
        return;
      }
      console.log(`Indexed ${indexFolderPath}`);
      console.log(`ready=${result.ready}`);
      console.log(`failed=${result.failed}`);
      console.log(`added=${result.added}`);
      console.log(`modified=${result.modified}`);
      console.log(`retryFailed=${result.retryFailed}`);
      console.log(`deleted=${result.deleted}`);
      console.log(`unchanged=${result.unchanged}`);
    });

  addProjectOptions(
    addLlmOptions(
      program
      .command("query")
      .argument("[target]", "docs folder or ragbox output directory")
      .argument("[question]", "question to answer")
      .option("--json", "print a stable JSON result with selections and sources")
    )
  )
    .action(async (target: string | undefined, question: string | undefined, commandOptions: SharedCommandOptions, command: Command) => {
      const loaded = await loadCommandConfig(command, commandOptions);
      let queryTarget = target;
      let queryQuestion = question;
      const configuredTarget = loaded.options.outputDir ?? loaded.rootDir;

      if (!queryQuestion && queryTarget && configuredTarget) {
        const singleArgIsQuestion = commandOptions.source || !(await pathExists(queryTarget));
        if (singleArgIsQuestion) {
          queryQuestion = queryTarget;
          queryTarget = undefined;
        }
      }

      queryTarget ??= configuredTarget;
      const result = await queryFolder(requireTarget(queryTarget), requireQuestion(queryQuestion), buildQueryOptions(loaded.options, commandOptions));
      if (commandOptions.json) {
        writeJson(result);
        return;
      }
      console.log(result.answer);
    });

  addProjectOptions(
    addLlmOptions(
      program
      .command("watch")
      .argument("[folder]", "folder to watch")
      .option("-c, --concurrency <number>", "PageIndex concurrency", parseConcurrency)
      .option("--pageindex-cli <path>", "PageIndex script path")
      .option("-o, --output-dir <folder>", "folder for ragbox index files")
      .option("--pageindex-python <path>", "Python executable used to run PageIndex")
      .option("--jsonl", "print stable JSON Lines watch and index progress events")
    )
  )
    .action(async (folder: string | undefined, commandOptions: WatchCommandOptions, command: Command) => {
      const loaded = await loadCommandConfig(command, commandOptions);
      const watchFolderPath = requireFolder(folder ?? loaded.rootDir, "watch");
      const options = buildOptions(loaded.options, commandOptions, commandOptions.jsonl ? logProgressAsJsonLine : logProgress);
      if (commandOptions.jsonl) {
        options.watchProgress = writeJsonLine;
      }
      await watchFolder(watchFolderPath, options);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
