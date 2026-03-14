#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { listRagboxConfigSourceNames, readRagboxConfig, resolveRagboxConfig, writeDefaultRagboxConfig } from "./config-file";
import { loadPageIndexConfig } from "./folder-index/config";
import { indexFolder } from "./folder-index/indexer";
import { queryMultipleIndexes, MultiQueryTarget } from "./folder-index/multi-query";
import { queryFolder } from "./folder-index/query";
import { watchFolder } from "./folder-index/watch";
import { IndexCounts, IndexFolderResult, IndexProgressEvent, PageIndexOptions } from "./folder-index/types";
import { inspectIndex, validateIndex, InspectIndexResult, ValidateIndexResult } from "./sdk";

function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return parsed;
}

function parseRetryAttempts(value: string): number {
  return parseNonNegativeInteger(value, "--retry-attempts");
}

function parseRetryDelayMs(value: string): number {
  return parseNonNegativeInteger(value, "--retry-delay-ms");
}

function parseDebounceMs(value: string): number {
  return parseNonNegativeInteger(value, "--debounce-ms");
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
  debounceMs?: number;
  healthFile?: string;
  jsonl?: boolean;
  lockFile?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  staging?: boolean;
  stagingOutputDir?: string;
  webhook?: string;
};

type QueryCommandOptions = SharedCommandOptions & {
  allSources?: boolean;
  trace?: boolean;
};

type DiagnosticCommandOptions = SharedCommandOptions & {
  allSources?: boolean;
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

type DiagnosticTarget = {
  source?: string;
  target: string;
  options: PageIndexOptions;
};

type StatusTargetOutput = {
  source?: string;
  target: string;
  ok: boolean;
  inspect?: InspectIndexResult;
  errors: ValidateIndexResult["errors"];
  warnings: ValidateIndexResult["warnings"];
};

type StatusJsonOutput = {
  version: 1;
  command: "status";
  ok: boolean;
  targets: StatusTargetOutput[];
};

type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
  path?: string;
};

type DoctorJsonOutput = {
  version: 1;
  command: "doctor";
  ok: boolean;
  checks: DoctorCheck[];
  status: StatusJsonOutput;
};

function addLlmOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "OpenAI-compatible API key")
    .option("--base-url <url>", "OpenAI-compatible API base URL")
    .option("--model <model>", "LLM model");
}

function addProjectOptions(command: Command): Command {
  return command.option("--source <name>", "ragbox config source; query accepts comma-separated names");
}

function getGlobalOptions(command: Command): { config?: string } {
  let current: Command | null | undefined = command;
  while (current) {
    const options = current.opts<{ config?: string }>();
    if (options.config) {
      return { config: options.config };
    }
    current = current.parent;
  }
  return {};
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
  const globalOptions = getGlobalOptions(command);
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
  commandOptions: IndexCommandOptions & Partial<WatchCommandOptions>,
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
    pythonPath: commandOptions.pageindexPython,
    watchDebounceMs: commandOptions.debounceMs,
    watchHealthFile: commandOptions.healthFile,
    watchLockFile: commandOptions.lockFile,
    watchRetryAttempts: commandOptions.retryAttempts,
    watchRetryDelayMs: commandOptions.retryDelayMs,
    watchStaging: commandOptions.staging ?? Boolean(commandOptions.stagingOutputDir),
    watchStagingOutputDir: commandOptions.stagingOutputDir,
    watchWebhookUrl: commandOptions.webhook
  });
}

function buildQueryOptions(configOptions: PageIndexOptions, commandOptions: SharedCommandOptions & { trace?: boolean }): PageIndexOptions {
  return mergeDefined<PageIndexOptions>({
    ...configOptions
  }, {
    apiKey: commandOptions.apiKey,
    baseUrl: commandOptions.baseUrl,
    model: commandOptions.model,
    trace: commandOptions.trace
  });
}

function parseSourceNames(source: string | undefined): string[] {
  return (source ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
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

async function loadConfiguredQueryTargets(command: Command, commandOptions: QueryCommandOptions): Promise<{
  answerOptions: PageIndexOptions;
  targets: MultiQueryTarget[];
}> {
  const globalOptions = getGlobalOptions(command);
  if (commandOptions.allSources && commandOptions.source) {
    throw new Error("Use either --source or --all-sources, not both.");
  }

  let sourceNames = parseSourceNames(commandOptions.source);
  if (commandOptions.allSources) {
    const { config } = await readRagboxConfig(globalOptions.config);
    sourceNames = listRagboxConfigSourceNames(config);
    if (sourceNames.length === 0) {
      throw new Error("No configured sources found. Add docs or sources to ragbox.config.json.");
    }
  }

  const targets: MultiQueryTarget[] = [];
  let answerOptions: PageIndexOptions | undefined;

  for (const sourceName of sourceNames) {
    const resolved = await resolveRagboxConfig({
      configPath: globalOptions.config,
      source: sourceName
    });
    const target = resolved.pageIndexOptions.outputDir ?? resolved.rootDir;
    if (!target) {
      throw new Error(`Source does not define outputDir or rootDir: ${sourceName}`);
    }

    const options = buildQueryOptions(resolved.pageIndexOptions, commandOptions);
    answerOptions ??= options;
    targets.push({
      name: sourceName,
      target,
      options
    });
  }

  return {
    answerOptions: answerOptions ?? buildQueryOptions({}, commandOptions),
    targets
  };
}

async function shouldQueryAllSourcesByDefault(
  command: Command,
  target: string | undefined,
  question: string | undefined,
  sourceNames: string[]
): Promise<boolean> {
  if (!target || question || sourceNames.length > 0) {
    return false;
  }
  if (await pathExists(target)) {
    return false;
  }

  const globalOptions = getGlobalOptions(command);
  const { config } = await readRagboxConfig(globalOptions.config);
  return listRagboxConfigSourceNames(config).length > 1;
}

async function loadDiagnosticTargets(
  command: Command,
  commandOptions: DiagnosticCommandOptions,
  target: string | undefined,
  allSourcesByDefault: boolean
): Promise<DiagnosticTarget[]> {
  if (target) {
    return [
      {
        target,
        options: buildQueryOptions({}, commandOptions)
      }
    ];
  }

  const globalOptions = getGlobalOptions(command);
  if (commandOptions.allSources && commandOptions.source) {
    throw new Error("Use either --source or --all-sources, not both.");
  }

  let sourceNames = parseSourceNames(commandOptions.source);
  if (commandOptions.allSources || (allSourcesByDefault && sourceNames.length === 0)) {
    const { config } = await readRagboxConfig(globalOptions.config);
    const configuredSourceNames = listRagboxConfigSourceNames(config);
    if (commandOptions.allSources || configuredSourceNames.length > 1) {
      sourceNames = configuredSourceNames;
    }
  }

  if (sourceNames.length > 0) {
    const targets: DiagnosticTarget[] = [];
    for (const sourceName of sourceNames) {
      const resolved = await resolveRagboxConfig({
        configPath: globalOptions.config,
        source: sourceName
      });
      const resolvedTarget = resolved.pageIndexOptions.outputDir ?? resolved.rootDir;
      if (!resolvedTarget) {
        throw new Error(`Source does not define outputDir or rootDir: ${sourceName}`);
      }
      targets.push({
        source: sourceName,
        target: resolvedTarget,
        options: buildQueryOptions(resolved.pageIndexOptions, commandOptions)
      });
    }
    return targets;
  }

  const loaded = await loadCommandConfig(command, commandOptions);
  const resolvedTarget = loaded.options.outputDir ?? loaded.rootDir;
  return [
    {
      target: requireTarget(resolvedTarget),
      options: buildQueryOptions(loaded.options, commandOptions)
    }
  ];
}

async function buildStatusOutput(targets: DiagnosticTarget[]): Promise<StatusJsonOutput> {
  const statusTargets: StatusTargetOutput[] = [];

  for (const target of targets) {
    const validation = await validateIndex(target.target);
    statusTargets.push({
      source: target.source,
      target: target.target,
      ok: validation.ok,
      inspect: validation.inspect,
      errors: validation.errors,
      warnings: validation.warnings
    });
  }

  return {
    version: 1,
    command: "status",
    ok: statusTargets.every((target) => target.ok),
    targets: statusTargets
  };
}

function printStatusOutput(status: StatusJsonOutput): void {
  for (const target of status.targets) {
    const label = target.source ? `${target.source} ${target.target}` : target.target;
    console.log(`${target.ok ? "ok" : "error"} ${label}`);
    if (target.inspect) {
      const counts = target.inspect.counts;
      console.log(`  documents=${counts.total} ready=${counts.ready} failed=${counts.failed}`);
      console.log(`  output=${target.inspect.outputDir}`);
      console.log(`  generatedAt=${target.inspect.generatedAt}`);
    }
    for (const error of target.errors) {
      console.log(`  error ${error.code}: ${error.message}`);
    }
    for (const warning of target.warnings) {
      console.log(`  warning ${warning.code}: ${warning.message}`);
    }
  }
}

function isPathLikeCommand(value: string): boolean {
  return path.isAbsolute(value) || value.startsWith(".") || value.includes("/") || value.includes("\\");
}

async function commandPathExists(value: string | undefined): Promise<boolean | undefined> {
  if (!value || !isPathLikeCommand(value)) {
    return undefined;
  }
  return await pathExists(value);
}

async function buildDoctorOutput(
  command: Command,
  commandOptions: DiagnosticCommandOptions,
  target: string | undefined
): Promise<DoctorJsonOutput> {
  const globalOptions = getGlobalOptions(command);
  const checks: DoctorCheck[] = [];
  const { configPath } = await readRagboxConfig(globalOptions.config);

  checks.push({
    name: "config",
    ok: true,
    message: configPath ? `Loaded config: ${configPath}` : "No ragbox config found; using CLI flags, environment, and defaults.",
    path: configPath
  });

  let targets: DiagnosticTarget[] = [];
  try {
    targets = await loadDiagnosticTargets(command, commandOptions, target, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "target",
      ok: false,
      message
    });
  }

  const options = targets[0]?.options ?? buildQueryOptions({}, commandOptions);
  const runtime = loadPageIndexConfig(options);
  const cliExists = await commandPathExists(runtime.cliPath);
  checks.push({
    name: "pageindex-cli",
    ok: Boolean(runtime.cliPath) && cliExists !== false,
    message: !runtime.cliPath
      ? "PAGEINDEX_CLI or pageIndex.cli is not configured."
      : cliExists === false
        ? `PageIndex CLI does not exist: ${runtime.cliPath}`
        : `PageIndex CLI configured: ${runtime.cliPath}`,
    path: runtime.cliPath
  });
  checks.push({
    name: "llm-model",
    ok: Boolean(runtime.model),
    message: `LLM model: ${runtime.model}`
  });
  checks.push({
    name: "llm-base-url",
    ok: Boolean(runtime.baseUrl),
    message: `LLM base URL: ${runtime.baseUrl}`
  });
  checks.push({
    name: "llm-api-key",
    ok: Boolean(runtime.apiKey),
    message: runtime.apiKey ? "LLM API key is configured." : "OPENAI_API_KEY or llm.apiKey is not configured."
  });

  const status = await buildStatusOutput(targets);
  checks.push({
    name: "index-status",
    ok: status.ok,
    message: status.targets.length > 0 ? `Checked ${status.targets.length} index target(s).` : "No index target was checked."
  });

  return {
    version: 1,
    command: "doctor",
    ok: checks.every((check) => check.ok),
    checks,
    status
  };
}

function printDoctorOutput(doctor: DoctorJsonOutput): void {
  for (const check of doctor.checks) {
    console.log(`${check.ok ? "ok" : "error"} ${check.name}: ${check.message}`);
  }
  printStatusOutput(doctor.status);
}

function printInspectResult(result: InspectIndexResult, source?: string): void {
  const label = source ? `${source} ${result.target}` : result.target;
  console.log(`Index ${label}`);
  console.log(`rootDir=${result.rootDir}`);
  console.log(`outputDir=${result.outputDir}`);
  console.log(`generatedAt=${result.generatedAt}`);
  console.log(`documents=${result.counts.total}`);
  console.log(`ready=${result.counts.ready}`);
  console.log(`failed=${result.counts.failed}`);
  for (const document of result.documents) {
    console.log(`- ${document.status} ${document.path}`);
  }
}

async function runQueryAction(
  target: string | undefined,
  question: string | undefined,
  commandOptions: QueryCommandOptions,
  command: Command
): Promise<void> {
  const sourceNames = parseSourceNames(commandOptions.source);
  const implicitAllSources = await shouldQueryAllSourcesByDefault(command, target, question, sourceNames);
  if (commandOptions.allSources || sourceNames.length > 1 || implicitAllSources) {
    if (question) {
      throw new Error("Multi-source query uses configured sources; pass only the question argument.");
    }

    const multiSourceOptions = implicitAllSources ? { ...commandOptions, allSources: true } : commandOptions;
    const loadedSources = await loadConfiguredQueryTargets(command, multiSourceOptions);
    const result = await queryMultipleIndexes(loadedSources.targets, requireQuestion(target), loadedSources.answerOptions);
    if (commandOptions.json || commandOptions.trace) {
      writeJson(result);
      return;
    }
    console.log(result.answer);
    return;
  }

  const singleSourceOptions = sourceNames.length === 1 ? { ...commandOptions, source: sourceNames[0] } : commandOptions;
  const loaded = await loadCommandConfig(command, singleSourceOptions);
  let queryTarget = target;
  let queryQuestion = question;
  const configuredTarget = loaded.options.outputDir ?? loaded.rootDir;

  if (!queryQuestion && queryTarget && configuredTarget) {
    const singleArgIsQuestion = singleSourceOptions.source || !(await pathExists(queryTarget));
    if (singleArgIsQuestion) {
      queryQuestion = queryTarget;
      queryTarget = undefined;
    }
  }

  queryTarget ??= configuredTarget;
  const result = await queryFolder(requireTarget(queryTarget), requireQuestion(queryQuestion), buildQueryOptions(loaded.options, singleSourceOptions));
  if (commandOptions.json || commandOptions.trace) {
    writeJson(result);
    return;
  }
  console.log(result.answer);
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
    program
      .command("inspect")
      .argument("[target]", "docs folder or ragbox output directory")
      .option("--all-sources", "inspect every configured source")
      .option("--json", "print a stable JSON result")
  )
    .action(async (target: string | undefined, commandOptions: DiagnosticCommandOptions, command: Command) => {
      const targets = await loadDiagnosticTargets(command, commandOptions, target, false);
      const results = [];
      for (const diagnosticTarget of targets) {
        results.push({
          source: diagnosticTarget.source,
          ...(await inspectIndex(diagnosticTarget.target))
        });
      }

      if (commandOptions.json) {
        writeJson(
          results.length === 1
            ? results[0]
            : {
                version: 1,
                command: "inspect",
                indexes: results
              }
        );
        return;
      }

      for (const result of results) {
        printInspectResult(result, result.source);
      }
    });

  addProjectOptions(
    program
      .command("status")
      .argument("[target]", "docs folder or ragbox output directory")
      .option("--all-sources", "check every configured source")
      .option("--json", "print a stable JSON result")
  )
    .action(async (target: string | undefined, commandOptions: DiagnosticCommandOptions, command: Command) => {
      const targets = await loadDiagnosticTargets(command, commandOptions, target, true);
      const status = await buildStatusOutput(targets);
      if (commandOptions.json) {
        writeJson(status);
        return;
      }
      printStatusOutput(status);
    });

  addProjectOptions(
    addLlmOptions(
      program
        .command("doctor")
        .argument("[target]", "docs folder or ragbox output directory")
        .option("--all-sources", "check every configured source")
        .option("--json", "print a stable JSON result")
    )
  )
    .action(async (target: string | undefined, commandOptions: DiagnosticCommandOptions, command: Command) => {
      const doctor = await buildDoctorOutput(command, commandOptions, target);
      if (commandOptions.json) {
        writeJson(doctor);
        return;
      }
      printDoctorOutput(doctor);
    });

  addProjectOptions(
    addLlmOptions(
      program
      .command("query")
      .argument("[target]", "docs folder or ragbox output directory")
      .argument("[question]", "question to answer")
      .option("--all-sources", "query every configured source and synthesize one answer")
      .option("--json", "print a stable JSON result with selections and sources")
      .option("--trace", "include query trace diagnostics; implies JSON output")
    )
  )
    .action(async (target: string | undefined, question: string | undefined, commandOptions: QueryCommandOptions, command: Command) => {
      await runQueryAction(target, question, commandOptions, command);
    });

  const traceCommand = program
    .command("trace")
    .description("run diagnostic tracing commands");

  addProjectOptions(
    addLlmOptions(
      traceCommand
        .command("query")
        .argument("[target]", "docs folder or ragbox output directory")
        .argument("[question]", "question to answer")
        .option("--all-sources", "query every configured source and synthesize one answer")
        .option("--json", "print a stable JSON result with selections and sources")
    )
  )
    .action(async (target: string | undefined, question: string | undefined, commandOptions: QueryCommandOptions, command: Command) => {
      await runQueryAction(target, question, { ...commandOptions, trace: true, json: true }, command);
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
      .option("--debounce-ms <ms>", "watch change debounce in milliseconds", parseDebounceMs)
      .option("--health-file <path>", "write a watch health JSON file")
      .option("--jsonl", "print stable JSON Lines watch and index progress events")
      .option("--lock-file <path>", "create an exclusive lock file while watch is running")
      .option("--retry-attempts <number>", "retry failed watch index runs", parseRetryAttempts)
      .option("--retry-delay-ms <ms>", "delay between watch retries in milliseconds", parseRetryDelayMs)
      .option("--staging", "index into a staging directory and promote it after a clean run")
      .option("--staging-output-dir <folder>", "staging directory used with --staging")
      .option("--webhook <url>", "POST watch events to a webhook URL")
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
