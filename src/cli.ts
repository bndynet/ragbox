#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Command } from "commander";
import {
  listRagboxConfigSourceNames,
  readRagboxConfig,
  resolveRagboxConfig,
  resolveRagboxServeConfig,
  writeDefaultRagboxConfig
} from "./config-file";
import { loadPageIndexConfig } from "./folder-index/config";
import { indexFolder } from "./folder-index/indexer";
import { PAGEINDEX_DIR } from "./folder-index/manifest";
import { queryMultipleIndexes, MultiQueryTarget } from "./folder-index/multi-query";
import { queryFolder } from "./folder-index/query";
import { startWatchFolder, watchFolder, WatchFolderHandle } from "./folder-index/watch";
import { IndexCounts, IndexFolderResult, IndexProgressEvent, PageIndexOptions, PageIndexRunner, WatchProgressEvent } from "./folder-index/types";
import { startServe, ServeHandle, ServeHealthResult } from "./serve";
import { setupPageIndex, SetupPageIndexResult } from "./setup-pageindex";
import { inspectIndex, validateIndex, InspectIndexResult, ValidateIndexResult } from "./sdk";

function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return parsed;
}

function parsePageIndexRunner(value: string): PageIndexRunner {
  if (value === "auto" || value === "single" || value === "batch") {
    return value;
  }
  throw new Error("--pageindex-runner must be one of: auto, single, batch");
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

function parseStopTimeoutMs(value: string): number {
  return parseNonNegativeInteger(value, "--timeout-ms");
}

function parseServePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
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

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function printIndexProgress(event: IndexProgressEvent): void {
  switch (event.type) {
    case "scan":
      console.error(
        `[ragbox] scan complete output=${event.outputDir} total=${event.total} toIndex=${event.toIndex} unchanged=${event.unchanged} deleted=${event.deleted}`
      );
      break;
    case "index-start":
      console.error(`[ragbox] indexing ${event.index}/${event.total} ${event.path}`);
      break;
    case "index-done":
      console.error(`[ragbox] indexed ${event.index}/${event.total} ${event.path}`);
      if (event.summary) {
        console.error(`[ragbox] summary ${event.path}: ${event.summary}`);
      }
      break;
    case "index-failed":
      console.error(`[ragbox] failed ${event.index}/${event.total} ${event.path}: ${firstLine(event.error)}`);
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
  pageindexRunner?: PageIndexRunner;
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

type ServeCommandOptions = SharedCommandOptions & {
  allSources?: boolean;
  authToken?: string;
  host?: string;
  port?: number;
};

type StartCommandOptions = WatchCommandOptions & ServeCommandOptions & {
  background?: boolean;
  logFile?: string;
  pidFile?: string | false;
};

type StopCommandOptions = {
  force?: boolean;
  json?: boolean;
  pidFile?: string;
  timeoutMs?: number;
};

type InitCommandOptions = {
  docsDir?: string;
  force?: boolean;
  output?: string;
  outputDir?: string;
};

type SetupPageIndexCommandOptions = {
  dir?: string;
  gitignore?: boolean;
  json?: boolean;
  python?: string;
  ref?: string;
  repo?: string;
  skipInstall?: boolean;
  writeConfig?: boolean;
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
  failures: IndexFailureOutput[];
};

type IndexFailureOutput = {
  path: string;
  absolutePath: string;
  indexPath: string;
  error?: string;
};

type DiagnosticTarget = {
  source?: string;
  target: string;
  options: PageIndexOptions;
};

type StartTarget = {
  source?: string;
  rootDir: string;
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

type ServeHealthCheckOutput = {
  version: 1;
  url: string;
  host: string;
  port: number;
  ok: boolean;
  reachable: boolean;
  status?: ServeHealthResult["status"];
  statusCode?: number;
  health?: ServeHealthResult;
  error?: string;
};

type StatusJsonOutput = {
  version: 1;
  command: "status";
  ok: boolean;
  targets: StatusTargetOutput[];
  serve?: ServeHealthCheckOutput;
};

type BackgroundStartResult = {
  pid: number;
  logFile: string;
  pidFile?: string;
};

type StopCommandResult = {
  version: 1;
  command: "stop";
  pid: number;
  pidFile: string;
  signal: "SIGKILL" | "SIGTERM";
  stopped: boolean;
  stale: boolean;
  removedPidFile: boolean;
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

function indentMultiline(value: string, prefix: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
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

function indexFailures(result: IndexFolderResult): IndexFailureOutput[] {
  return result.manifest.documents
    .filter((document) => document.status === "failed")
    .map((document) => ({
      path: document.path,
      absolutePath: document.absolutePath,
      indexPath: document.indexPath,
      error: document.error
    }));
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
    counts: indexCounts(result),
    failures: indexFailures(result)
  };
}

function printIndexResult(folder: string, result: IndexFolderResult): void {
  console.log(`Indexed ${folder}`);
  console.log(`ready=${result.ready}`);
  console.log(`failed=${result.failed}`);
  console.log(`added=${result.added}`);
  console.log(`modified=${result.modified}`);
  console.log(`retryFailed=${result.retryFailed}`);
  console.log(`deleted=${result.deleted}`);
  console.log(`unchanged=${result.unchanged}`);

  const failures = indexFailures(result);
  if (failures.length === 0) {
    return;
  }

  console.error("Failed documents:");
  for (const failure of failures) {
    console.error(`- ${failure.path}`);
    if (failure.error) {
      console.error(indentMultiline(failure.error, "  "));
    }
  }
}

function printSetupPageIndexResult(result: SetupPageIndexResult): void {
  console.log(`PageIndex ready: ${result.pageIndexDir}`);
  console.log(`cli=${result.cliPath}`);
  if (result.pythonPath) {
    console.log(`python=${result.pythonPath}`);
  }
  if (result.configPath) {
    console.log(`config=${result.configPath}`);
  }
  if (result.gitignorePath) {
    console.log(`${result.actions.updatedGitignore ? "updated" : "checked"} gitignore=${result.gitignorePath}`);
  }
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
    pageIndexRunner: commandOptions.pageindexRunner,
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

function resolveServeProbeHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::") {
    return "::1";
  }
  return host;
}

function serveHealthUrl(host: string, port: number): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}/health`;
}

function isServeHealthResult(value: unknown): value is ServeHealthResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const health = value as Partial<ServeHealthResult>;
  return health.version === 1
    && typeof health.ok === "boolean"
    && (health.status === "ready" || health.status === "degraded" || health.status === "error")
    && typeof health.indexes === "object"
    && health.indexes !== null;
}

async function checkServeHealth(configPath?: string): Promise<ServeHealthCheckOutput> {
  const { config } = await readRagboxConfig(configPath);
  const serveConfig = resolveRagboxServeConfig({ config });
  const host = resolveServeProbeHost(serveConfig.host);
  const port = serveConfig.port;
  const url = serveHealthUrl(host, port);

  return await new Promise((resolve) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        let health: ServeHealthResult | undefined;
        let error: string | undefined;

        if (raw.trim()) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (isServeHealthResult(parsed)) {
              health = parsed;
            } else {
              error = "Response was not a ragbox health payload.";
            }
          } catch (parseError) {
            error = parseError instanceof Error ? parseError.message : String(parseError);
          }
        } else {
          error = "Response body was empty.";
        }

        const statusCode = response.statusCode ?? 0;
        resolve({
          version: 1,
          url,
          host,
          port,
          ok: Boolean(health?.ok) && statusCode >= 200 && statusCode < 300,
          reachable: true,
          status: health?.status,
          statusCode,
          health,
          error
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("Timed out after 2000ms."));
    });
    request.on("error", (error) => {
      resolve({
        version: 1,
        url,
        host,
        port,
        ok: false,
        reachable: false,
        error: error.message
      });
    });
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

function startTargetOutputDir(rootDir: string, options: PageIndexOptions): string {
  return path.resolve(options.outputDir ?? path.join(rootDir, PAGEINDEX_DIR));
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

async function loadStartTargets(
  command: Command,
  commandOptions: StartCommandOptions,
  folder: string | undefined
): Promise<StartTarget[]> {
  if (folder) {
    if (commandOptions.allSources || commandOptions.source) {
      throw new Error("A folder argument cannot be combined with --source or --all-sources.");
    }
    const loaded = await loadCommandConfig(command, commandOptions);
    const rootDir = path.resolve(folder);
    const options = buildOptions(loaded.options, commandOptions, commandOptions.jsonl ? logProgressAsJsonLine : logProgress);
    return [
      {
        rootDir,
        target: startTargetOutputDir(rootDir, options),
        options
      }
    ];
  }

  const globalOptions = getGlobalOptions(command);
  if (commandOptions.allSources && commandOptions.source) {
    throw new Error("Use either --source or --all-sources, not both.");
  }

  let sourceNames = parseSourceNames(commandOptions.source);
  if (commandOptions.allSources || sourceNames.length === 0) {
    const { config } = await readRagboxConfig(globalOptions.config);
    const configuredSourceNames = listRagboxConfigSourceNames(config);
    if (commandOptions.allSources || configuredSourceNames.length > 1) {
      sourceNames = configuredSourceNames;
    }
  }

  if (sourceNames.length > 0) {
    if (sourceNames.length > 1 && commandOptions.outputDir) {
      throw new Error("--output-dir cannot be used when starting multiple sources.");
    }

    const targets: StartTarget[] = [];
    for (const sourceName of sourceNames) {
      const resolved = await resolveRagboxConfig({
        configPath: globalOptions.config,
        source: sourceName
      });
      const rootDir = requireFolder(resolved.rootDir, "start");
      const options = buildOptions(resolved.pageIndexOptions, commandOptions, commandOptions.jsonl ? logProgressAsJsonLine : logProgress);
      targets.push({
        source: sourceName,
        rootDir,
        target: startTargetOutputDir(rootDir, options),
        options
      });
    }
    return targets;
  }

  const loaded = await loadCommandConfig(command, commandOptions);
  const rootDir = requireFolder(loaded.rootDir, "start");
  const options = buildOptions(loaded.options, commandOptions, commandOptions.jsonl ? logProgressAsJsonLine : logProgress);
  return [
    {
      source: commandOptions.source,
      rootDir,
      target: startTargetOutputDir(rootDir, options),
      options
    }
  ];
}

async function buildStatusOutput(targets: DiagnosticTarget[], configPath?: string): Promise<StatusJsonOutput> {
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

  const serve = await checkServeHealth(configPath);

  return {
    version: 1,
    command: "status",
    ok: statusTargets.every((target) => target.ok) && serve.ok,
    targets: statusTargets,
    serve
  };
}

function serveHealthSummary(serve: ServeHealthCheckOutput): string {
  if (!serve.reachable) {
    return `HTTP server is not reachable at ${serve.url}: ${serve.error ?? "connection failed"}`;
  }
  if (!serve.health) {
    return `HTTP server responded at ${serve.url}, but health could not be parsed: ${serve.error ?? "invalid response"}`;
  }

  const indexes = serve.health.indexes;
  return `HTTP server ${serve.health.status} at ${serve.url}; indexes ready=${indexes.ready}/${indexes.total}.`;
}

function printServeHealthOutput(serve: ServeHealthCheckOutput): void {
  console.log(`${serve.ok ? "ok" : "error"} serve ${serve.url}`);
  console.log(`  reachable=${serve.reachable}`);
  if (serve.statusCode !== undefined) {
    console.log(`  http=${serve.statusCode}`);
  }
  if (serve.health) {
    const indexes = serve.health.indexes;
    console.log(`  status=${serve.health.status}`);
    console.log(`  indexes=${indexes.total} ready=${indexes.ready} failed=${indexes.failed}`);
  }
  if (serve.error) {
    console.log(`  error ${serve.error}`);
  }
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
  if (status.serve) {
    printServeHealthOutput(status.serve);
  }
}

function startTargetLabel(target: StartTarget): string {
  return target.source ? `${target.source} ${target.rootDir}` : target.rootDir;
}

function writeStartJsonLine(type: string, fields: Record<string, unknown> = {}): void {
  writeJsonLine({
    version: 1,
    timestamp: new Date().toISOString(),
    type,
    ...fields
  });
}

function printStartWatchEvent(event: WatchProgressEvent, source: string | undefined): void {
  const prefix = source ? `[${source}] ` : "";
  switch (event.type) {
    case "watch-start":
      console.log(`${prefix}watching ${event.rootDir}`);
      break;
    case "watch-file-event":
      console.log(`${prefix}${event.eventName}: ${event.path}`);
      break;
    case "watch-index-start":
      console.log(`${prefix}index ${event.reason} attempt=${event.attempt}/${event.maxAttempts}`);
      break;
    case "watch-index-done":
      console.log(
        `${prefix}indexed ready=${event.result.ready} failed=${event.result.failed} added=${event.result.added} modified=${event.result.modified} deleted=${event.result.deleted} unchanged=${event.result.unchanged}`
      );
      break;
    case "watch-index-failed":
      console.error(`${prefix}index failed: ${event.error}`);
      break;
    case "watch-index-retry":
      console.error(`${prefix}index retry in ${event.delayMs}ms: ${event.error}`);
      break;
    case "watch-output-promoted":
      console.log(`${prefix}promoted staging output ${event.stagingOutputDir}`);
      break;
    case "watch-stop":
      console.log(`${prefix}watch stopped`);
      break;
  }
}

async function closeStartHandles(watchHandles: WatchFolderHandle[], serveHandle: ServeHandle | undefined): Promise<void> {
  await Promise.allSettled([
    ...watchHandles.map((handle) => handle.close()),
    ...(serveHandle ? [serveHandle.close()] : [])
  ]);
}

const BACKGROUND_CHILD_ENV = "RAGBOX_BACKGROUND_CHILD";

function stripBackgroundStartArgs(args: string[]): string[] {
  const stripped: string[] = [];
  let afterTerminator = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (afterTerminator) {
      stripped.push(arg);
      continue;
    }

    if (arg === "--") {
      afterTerminator = true;
      stripped.push(arg);
      continue;
    }

    if (arg === "--background" || arg.startsWith("--background=")) {
      continue;
    }

    if (arg === "--pid-file" || arg === "--log-file") {
      index += 1;
      continue;
    }

    if (arg === "--no-pid-file" || arg.startsWith("--pid-file=") || arg.startsWith("--log-file=")) {
      continue;
    }

    stripped.push(arg);
  }

  return stripped;
}

async function writeBackgroundPidFile(pidFile: string | undefined, pid: number): Promise<string | undefined> {
  if (!pidFile) {
    return undefined;
  }

  const resolvedPidFile = path.resolve(pidFile);
  await fs.mkdir(path.dirname(resolvedPidFile), { recursive: true });
  await fs.writeFile(resolvedPidFile, `${pid}\n`, "utf8");
  return resolvedPidFile;
}

async function launchBackgroundStart(commandOptions: StartCommandOptions): Promise<BackgroundStartResult> {
  const cliScript = process.argv[1];
  if (!cliScript) {
    throw new Error("Cannot start ragbox in the background because the CLI script path is unavailable.");
  }

  const logFile = path.resolve(commandOptions.logFile ?? "ragbox.log");
  await fs.mkdir(path.dirname(logFile), { recursive: true });

  const logFd = openSync(logFile, "a");
  const childArgs = [cliScript, ...stripBackgroundStartArgs(process.argv.slice(2))];
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      [BACKGROUND_CHILD_ENV]: "1"
    },
    stdio: ["ignore", logFd, logFd]
  });

  try {
    if (!child.pid) {
      throw new Error("Failed to start background ragbox process.");
    }

    const pidFile = await writeBackgroundPidFile(
      commandOptions.pidFile === false ? undefined : commandOptions.pidFile ?? "ragbox.pid",
      child.pid
    );
    child.unref();
    return {
      pid: child.pid,
      logFile,
      pidFile
    };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  } finally {
    closeSync(logFd);
  }
}

function printBackgroundStartResult(result: BackgroundStartResult, jsonl: boolean | undefined): void {
  if (jsonl) {
    writeStartJsonLine("start-background", result);
    return;
  }

  console.log(`Started ragbox in the background (pid=${result.pid})`);
  console.log(`log=${result.logFile}`);
  if (result.pidFile) {
    console.log(`pidFile=${result.pidFile}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoSuchProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

async function readStopPidFile(pidFile: string): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(pidFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No ragbox pid file found: ${pidFile}. Run ragbox start --background first, or pass --pid-file.`);
    }
    throw error;
  }

  const trimmed = raw.trim();
  const pid = Number.parseInt(trimmed, 10);
  if (!trimmed || !Number.isInteger(pid) || pid <= 0 || String(pid) !== trimmed) {
    throw new Error(`Invalid ragbox pid file: ${pidFile}`);
  }
  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  do {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(50);
  } while (Date.now() - startedAt < timeoutMs);

  return !isProcessRunning(pid);
}

async function runStopAction(commandOptions: StopCommandOptions): Promise<StopCommandResult> {
  const pidFile = path.resolve(commandOptions.pidFile ?? "ragbox.pid");
  const pid = await readStopPidFile(pidFile);
  const signal = commandOptions.force ? "SIGKILL" : "SIGTERM";
  const timeoutMs = commandOptions.timeoutMs ?? 5000;
  let stale = false;

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
    stale = true;
  }

  const stopped = stale || await waitForProcessExit(pid, timeoutMs);
  if (!stopped) {
    throw new Error(`ragbox process ${pid} did not stop within ${timeoutMs}ms; pid file left in place: ${pidFile}`);
  }

  await fs.rm(pidFile, { force: true });
  return {
    version: 1,
    command: "stop",
    pid,
    pidFile,
    signal,
    stopped,
    stale,
    removedPidFile: true
  };
}

function printStopResult(result: StopCommandResult): void {
  if (result.stale) {
    console.log(`Removed stale ragbox pid file ${result.pidFile} (pid=${result.pid})`);
    return;
  }
  console.log(`Stopped ragbox (pid=${result.pid}, signal=${result.signal})`);
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

  const status = await buildStatusOutput(targets, globalOptions.config);
  const indexStatusOk = status.targets.every((target) => target.ok);
  checks.push({
    name: "index-status",
    ok: indexStatusOk,
    message: status.targets.length > 0 ? `Checked ${status.targets.length} index target(s).` : "No index target was checked."
  });
  if (status.serve) {
    checks.push({
      name: "serve-health",
      ok: status.serve.ok,
      message: serveHealthSummary(status.serve)
    });
  }

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

async function runStartAction(
  folder: string | undefined,
  commandOptions: StartCommandOptions,
  command: Command
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const targets = await loadStartTargets(command, commandOptions, folder);
  const watchHandles: WatchFolderHandle[] = [];
  let serveHandle: ServeHandle | undefined;
  let reloading = false;
  let reloadAgain = false;

  async function reloadServe(): Promise<void> {
    if (!serveHandle) {
      return;
    }
    if (reloading) {
      reloadAgain = true;
      return;
    }

    reloading = true;
    do {
      reloadAgain = false;
      try {
        const result = await serveHandle.reload();
        if (commandOptions.jsonl) {
          writeStartJsonLine("start-serve-reload", {
            indexes: result.indexes.map((index) => ({
              source: index.source,
              target: index.target,
              ok: index.ok
            }))
          });
        } else {
          console.log(`Reloaded serve index snapshot (${result.indexes.filter((index) => index.ok).length}/${result.indexes.length} ready)`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (commandOptions.jsonl) {
          writeStartJsonLine("start-serve-reload-failed", { error: message });
        } else {
          console.error(`Serve reload failed: ${message}`);
        }
      }
    } while (reloadAgain);
    reloading = false;
  }

  try {
    if (commandOptions.jsonl) {
      writeStartJsonLine("start", {
        sources: targets.map((target) => target.source).filter(Boolean),
        targets: targets.map((target) => target.target)
      });
    } else {
      console.log(`Starting ragbox for ${targets.length} source${targets.length === 1 ? "" : "s"}`);
    }

    for (const target of targets) {
      const handle = await startWatchFolder(target.rootDir, {
        ...target.options,
        watchProgress: (event) => {
          if (commandOptions.jsonl) {
            writeJsonLine(event);
          } else {
            printStartWatchEvent(event, target.source);
          }
          if (event.type === "watch-index-done") {
            void reloadServe();
          }
        }
      });
      watchHandles.push(handle);
    }

    const sourceNames = targets.map((target) => target.source).filter((source): source is string => Boolean(source));
    const singleTarget = targets.length === 1 ? targets[0] : undefined;
    serveHandle = await startServe({
      allSources: targets.length > 1 && sourceNames.length === 0,
      apiKey: commandOptions.apiKey,
      authToken: commandOptions.authToken,
      baseUrl: commandOptions.baseUrl,
      configPath: globalOptions.config,
      host: commandOptions.host,
      model: commandOptions.model,
      port: commandOptions.port,
      source: targets.length > 1 ? sourceNames : undefined,
      target: singleTarget ? singleTarget.target : undefined
    });

    if (commandOptions.jsonl) {
      writeStartJsonLine("start-serve", {
        url: serveHandle.url,
        host: serveHandle.host,
        port: serveHandle.port
      });
    } else {
      console.log(`Serving ragbox at ${serveHandle.url}`);
    }

    const readyResults = await Promise.all(watchHandles.map((handle) => handle.ready));
    const failedReady = readyResults.find((ready) => !ready.ok);
    if (failedReady && !failedReady.ok) {
      throw new Error(`Initial index failed: ${failedReady.error}`);
    }

    await reloadServe();

    await new Promise<void>((resolve) => {
      let closing = false;
      const stop = (): void => {
        if (closing) {
          return;
        }
        closing = true;
        void closeStartHandles(watchHandles, serveHandle).finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      serveHandle?.server.once("close", stop);
    });
  } catch (error) {
    await closeStartHandles(watchHandles, serveHandle);
    throw error;
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

  const setupCommand = program
    .command("setup")
    .description("setup local ragbox dependencies");

  setupCommand
    .command("pageindex")
    .description("clone PageIndex and configure ragbox to use it")
    .option("--dir <folder>", "PageIndex checkout directory", "./.ragbox/PageIndex")
    .option("--repo <url>", "PageIndex git repository", "https://github.com/VectifyAI/PageIndex.git")
    .option("--ref <ref>", "PageIndex branch, tag, or commit to checkout")
    .option("--python <path>", "Python executable used to create the PageIndex virtual environment", "python3")
    .option("--skip-install", "skip virtual environment creation and pip install")
    .option("--no-write-config", "do not create or update ragbox.config.json")
    .option("--no-gitignore", "do not add .ragbox/ to .gitignore")
    .option("--json", "print a stable JSON result")
    .action(async (commandOptions: SetupPageIndexCommandOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command);
      const result = await setupPageIndex({
        configPath: globalOptions.config,
        dir: commandOptions.dir,
        gitignore: commandOptions.gitignore !== false,
        install: !commandOptions.skipInstall,
        python: commandOptions.python,
        ref: commandOptions.ref,
        repo: commandOptions.repo,
        writeConfig: commandOptions.writeConfig !== false
      });
      if (commandOptions.json) {
        writeJson(result);
        return;
      }
      printSetupPageIndexResult(result);
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
      .option("--pageindex-runner <mode>", "PageIndex runner mode: auto, single, or batch", parsePageIndexRunner)
      .option("--json", "print a stable JSON result")
    )
  )
    .action(async (folder: string | undefined, commandOptions: IndexCommandOptions, command: Command) => {
      const loaded = await loadCommandConfig(command, commandOptions);
      const indexFolderPath = requireFolder(folder ?? loaded.rootDir, "index");
      if (!commandOptions.json) {
        console.error(`[ragbox] indexing ${indexFolderPath}`);
      }
      const result = await indexFolder(
        indexFolderPath,
        buildOptions(loaded.options, commandOptions, commandOptions.json ? logProgress : printIndexProgress)
      );
      if (commandOptions.json) {
        writeJson(indexJsonOutput(result));
        return;
      }
      printIndexResult(indexFolderPath, result);
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
      const globalOptions = getGlobalOptions(command);
      const targets = await loadDiagnosticTargets(command, commandOptions, target, true);
      const status = await buildStatusOutput(targets, globalOptions.config);
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
        .command("start")
        .argument("[folder]", "folder to index, watch, and serve")
        .option("--all-sources", "start every configured source")
        .option("--auth-token <token>", "bearer token required for non-health endpoints")
        .option("--background", "run start as a detached background process")
        .option("-c, --concurrency <number>", "PageIndex concurrency", parseConcurrency)
        .option("--pageindex-cli <path>", "PageIndex script path")
        .option("-o, --output-dir <folder>", "folder for ragbox index files")
        .option("--pageindex-python <path>", "Python executable used to run PageIndex")
        .option("--pageindex-runner <mode>", "PageIndex runner mode: auto, single, or batch", parsePageIndexRunner)
        .option("--debounce-ms <ms>", "watch change debounce in milliseconds", parseDebounceMs)
        .option("--health-file <path>", "write a watch health JSON file")
        .option("--host <host>", "host to bind")
        .option("--jsonl", "print stable JSON Lines start, watch, and index progress events")
        .option("--log-file <path>", "background stdout/stderr log file; defaults to ./ragbox.log")
        .option("--lock-file <path>", "create an exclusive lock file while start is running")
        .option("--pid-file <path>", "background process id file; defaults to ./ragbox.pid")
        .option("--no-pid-file", "do not write a background process id file")
        .option("--port <number>", "port to bind", parseServePort)
        .option("--retry-attempts <number>", "retry failed watch index runs", parseRetryAttempts)
        .option("--retry-delay-ms <ms>", "delay between watch retries in milliseconds", parseRetryDelayMs)
        .option("--staging", "index into a staging directory and promote it after a clean run")
        .option("--staging-output-dir <folder>", "staging directory used with --staging")
        .option("--webhook <url>", "POST watch events to a webhook URL")
    )
  )
    .action(async (folder: string | undefined, commandOptions: StartCommandOptions, command: Command) => {
      if (commandOptions.background && process.env[BACKGROUND_CHILD_ENV] !== "1") {
        const result = await launchBackgroundStart(commandOptions);
        printBackgroundStartResult(result, commandOptions.jsonl);
        return;
      }

      await runStartAction(folder, commandOptions, command);
    });

  program
    .command("stop")
    .description("stop a background ragbox start process")
    .option("--pid-file <path>", "pid file written by ragbox start --background", "ragbox.pid")
    .option("--force", "send SIGKILL instead of SIGTERM")
    .option("--timeout-ms <ms>", "time to wait for the process to exit", parseStopTimeoutMs)
    .option("--json", "print a stable JSON result")
    .action(async (commandOptions: StopCommandOptions) => {
      const result = await runStopAction(commandOptions);
      if (commandOptions.json) {
        writeJson(result);
        return;
      }
      printStopResult(result);
    });

  addProjectOptions(
    addLlmOptions(
      program
        .command("serve")
        .argument("[target]", "docs folder or ragbox output directory")
        .option("--all-sources", "serve every configured source by default")
        .option("--auth-token <token>", "bearer token required for non-health endpoints")
        .option("--host <host>", "host to bind")
        .option("--port <number>", "port to bind", parseServePort)
    )
  )
    .action(async (target: string | undefined, commandOptions: ServeCommandOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command);
      const handle = await startServe({
        allSources: commandOptions.allSources,
        apiKey: commandOptions.apiKey,
        authToken: commandOptions.authToken,
        baseUrl: commandOptions.baseUrl,
        configPath: globalOptions.config,
        host: commandOptions.host,
        model: commandOptions.model,
        port: commandOptions.port,
        source: commandOptions.source,
        target
      });
      console.log(`Serving ragbox at ${handle.url}`);

      await new Promise<void>((resolve) => {
        let closing = false;
        const stop = (): void => {
          if (closing) {
            return;
          }
          closing = true;
          void handle.close().finally(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        handle.server.once("close", () => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          resolve();
        });
      });
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
      .option("--pageindex-runner <mode>", "PageIndex runner mode: auto, single, or batch", parsePageIndexRunner)
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
