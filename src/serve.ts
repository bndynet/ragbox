import http, { IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { URL } from "node:url";
import { listRagboxConfigSourceNames, readRagboxConfig, resolveRagboxConfig } from "./config-file";
import { queryMultipleIndexes, MultiQueryResult, MultiQueryTarget } from "./folder-index/multi-query";
import { queryFolder } from "./folder-index/query";
import { LlmClient, PageIndexOptions, QueryResult } from "./folder-index/types";
import { InspectIndexResult, validateIndex, ValidateIndexResult } from "./sdk";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type ServeOptions = {
  allSources?: boolean;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  host?: string;
  llmClient?: LlmClient;
  model?: string;
  port?: number;
  source?: string | string[];
  target?: string;
};

export type ServeHandle = {
  url: string;
  host: string;
  port: number;
  server: http.Server;
  close: () => Promise<void>;
};

export type ServeIndexSummary = {
  source?: string;
  target: string;
  ok: boolean;
  generatedAt?: string;
  counts?: InspectIndexResult["counts"];
  errors: ValidateIndexResult["errors"];
  warnings: ValidateIndexResult["warnings"];
};

export type ServeIndexesResult = {
  version: 1;
  indexes: ServeIndexSummary[];
};

export type ServeHealthResult = {
  version: 1;
  ok: boolean;
  status: "ready" | "degraded" | "error";
  uptimeMs: number;
  lastReloadAt: string;
  indexes: {
    total: number;
    ready: number;
    failed: number;
  };
};

type ServeResolvedTarget = {
  source?: string;
  target: string;
  options: PageIndexOptions;
};

type QueryRequestBody = {
  allSources?: boolean;
  question?: unknown;
  source?: unknown;
  target?: unknown;
  trace?: unknown;
};

class ServeHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ServeHttpError";
    this.status = status;
    this.code = code;
  }
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

function parsePositivePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid serve port: ${value}`);
  }
  return parsed;
}

function parseSourceNames(source: string | string[] | undefined): string[] {
  if (Array.isArray(source)) {
    return source.map((name) => name.trim()).filter(Boolean);
  }
  return (source ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryOptionsFromServeOptions(configOptions: PageIndexOptions, options: ServeOptions, trace?: boolean): PageIndexOptions {
  return mergeDefined<PageIndexOptions>({
    ...configOptions
  }, {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    env: options.env,
    llmClient: options.llmClient,
    model: options.model,
    trace
  });
}

async function loadBaseQueryOptions(options: ServeOptions, trace?: boolean): Promise<PageIndexOptions> {
  const resolved = await resolveRagboxConfig({
    configPath: options.configPath
  });
  return queryOptionsFromServeOptions(resolved.pageIndexOptions, options, trace);
}

async function resolveTargets(options: ServeOptions, request: {
  allSources?: boolean;
  source?: string | string[];
  target?: string;
  trace?: boolean;
} = {}): Promise<ServeResolvedTarget[]> {
  if (request.target) {
    return [
      {
        target: request.target,
        options: await loadBaseQueryOptions(options, request.trace)
      }
    ];
  }

  const allSources = request.allSources ?? options.allSources;
  let sourceNames = parseSourceNames(request.source ?? options.source);

  if (allSources) {
    const { config } = await readRagboxConfig(options.configPath);
    sourceNames = listRagboxConfigSourceNames(config);
    if (sourceNames.length === 0) {
      throw new ServeHttpError(400, "invalid_request", "No configured sources found. Add docs or sources to ragbox.config.json.");
    }
  }

  if (sourceNames.length === 0 && !options.target) {
    const { config } = await readRagboxConfig(options.configPath);
    const configuredSourceNames = listRagboxConfigSourceNames(config);
    if (configuredSourceNames.length > 0) {
      sourceNames = configuredSourceNames;
    }
  }

  if (sourceNames.length > 0) {
    const targets: ServeResolvedTarget[] = [];
    for (const sourceName of sourceNames) {
      const resolved = await resolveRagboxConfig({
        configPath: options.configPath,
        source: sourceName
      });
      const target = resolved.pageIndexOptions.outputDir ?? resolved.rootDir;
      if (!target) {
        throw new ServeHttpError(400, "invalid_request", `Source does not define outputDir or rootDir: ${sourceName}`);
      }
      targets.push({
        source: sourceName,
        target,
        options: queryOptionsFromServeOptions(resolved.pageIndexOptions, options, request.trace)
      });
    }
    return targets;
  }

  if (options.target) {
    return [
      {
        target: options.target,
        options: await loadBaseQueryOptions(options, request.trace)
      }
    ];
  }

  throw new ServeHttpError(400, "invalid_request", "Missing query target. Pass a target, --source, --all-sources, or configure sources.");
}

async function buildIndexes(targets: ServeResolvedTarget[]): Promise<ServeIndexesResult> {
  const indexes: ServeIndexSummary[] = [];

  for (const target of targets) {
    const validation = await validateIndex(target.target);
    indexes.push({
      source: target.source,
      target: target.target,
      ok: validation.ok,
      generatedAt: validation.inspect?.generatedAt,
      counts: validation.inspect?.counts,
      errors: validation.errors,
      warnings: validation.warnings
    });
  }

  return {
    version: 1,
    indexes
  };
}

function healthFromIndexes(startedAt: number, lastReloadAt: string, indexes: ServeIndexesResult): ServeHealthResult {
  const ready = indexes.indexes.filter((index) => index.ok).length;
  const failed = indexes.indexes.length - ready;
  const ok = indexes.indexes.length > 0 && failed === 0;
  const status = ok ? "ready" : ready > 0 ? "degraded" : "error";

  return {
    version: 1,
    ok,
    status,
    uptimeMs: Date.now() - startedAt,
    lastReloadAt,
    indexes: {
      total: indexes.indexes.length,
      ready,
      failed
    }
  };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  writeJson(response, status, {
    version: 1,
    error: {
      code,
      message
    }
  });
}

function methodNotAllowed(response: ServerResponse): void {
  writeError(response, 405, "method_not_allowed", "Method not allowed.");
}

function notFound(response: ServerResponse): void {
  writeError(response, 404, "not_found", "Route not found.");
}

function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;

    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(new ServeHttpError(400, "invalid_request", "JSON body is too large."));
        request.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });

    request.on("end", () => {
      try {
        const parsed = body.trim() ? JSON.parse(body) : {};
        if (!isJsonObject(parsed)) {
          reject(new ServeHttpError(400, "invalid_request", "Expected a JSON object."));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new ServeHttpError(400, "invalid_request", `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    });

    request.on("error", reject);
  });
}

function authorizationHeader(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return Array.isArray(header) ? header[0] : header;
}

function assertAuthorized(request: IncomingMessage, authToken: string | undefined): void {
  if (!authToken) {
    return;
  }
  if (authorizationHeader(request) !== `Bearer ${authToken}`) {
    throw new ServeHttpError(401, "unauthorized", "Missing or invalid bearer token.");
  }
}

function requestSource(value: unknown): string | string[] | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  throw new ServeHttpError(400, "invalid_request", "source must be a string or string array.");
}

function requestTarget(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ServeHttpError(400, "invalid_request", "target must be a non-empty string.");
}

function requestBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new ServeHttpError(400, "invalid_request", `${name} must be a boolean.`);
}

function statusForThrownError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ServeHttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/LLM request failed|OPENAI_API_KEY|chat completions/i.test(message)) {
    return {
      status: 502,
      code: "upstream_error",
      message
    };
  }

  return {
    status: 500,
    code: "internal_error",
    message
  };
}

async function queryTargets(targets: ServeResolvedTarget[], question: string, options: ServeOptions): Promise<QueryResult | MultiQueryResult> {
  if (targets.length === 0) {
    throw new ServeHttpError(400, "invalid_request", "At least one query source is required.");
  }
  if (targets.length === 1) {
    return await queryFolder(targets[0].target, question, targets[0].options);
  }

  const multiTargets: MultiQueryTarget[] = targets.map((target) => ({
    name: target.source ?? target.target,
    target: target.target,
    options: target.options
  }));
  return await queryMultipleIndexes(multiTargets, question, targets[0].options ?? await loadBaseQueryOptions(options));
}

export async function startServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const env = options.env ?? process.env;
  const host = options.host ?? env.RAGBOX_SERVE_HOST ?? DEFAULT_HOST;
  const port = options.port ?? parsePositivePort(env.RAGBOX_SERVE_PORT, DEFAULT_PORT);
  const authToken = options.authToken ?? env.RAGBOX_SERVE_TOKEN;
  const serverOptions: ServeOptions = {
    ...options,
    authToken,
    env,
    host,
    port
  };
  const startedAt = Date.now();
  let defaultTargets = await resolveTargets(serverOptions);
  let lastReloadAt = new Date().toISOString();
  let indexes = await buildIndexes(defaultTargets);

  async function reload(): Promise<ServeIndexesResult> {
    defaultTargets = await resolveTargets(serverOptions);
    indexes = await buildIndexes(defaultTargets);
    lastReloadAt = new Date().toISOString();
    return indexes;
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
      const route = requestUrl.pathname.replace(/\/+$/, "") || "/";

      if (route === "/health") {
        if (request.method !== "GET") {
          methodNotAllowed(response);
          return;
        }
        const health = healthFromIndexes(startedAt, lastReloadAt, indexes);
        writeJson(response, health.ok ? 200 : 503, health);
        return;
      }

      assertAuthorized(request, authToken);

      if (route === "/indexes") {
        if (request.method !== "GET") {
          methodNotAllowed(response);
          return;
        }
        writeJson(response, 200, indexes);
        return;
      }

      if (route === "/reload") {
        if (request.method !== "POST") {
          methodNotAllowed(response);
          return;
        }
        writeJson(response, 200, await reload());
        return;
      }

      if (route === "/query") {
        if (request.method !== "POST") {
          methodNotAllowed(response);
          return;
        }

        const body = await readJsonBody(request) as QueryRequestBody;
        const question = typeof body.question === "string" && body.question.trim() ? body.question : undefined;
        if (!question) {
          throw new ServeHttpError(400, "invalid_request", "question must be a non-empty string.");
        }

        const target = requestTarget(body.target);
        const source = requestSource(body.source);
        const allSources = requestBoolean(body.allSources, "allSources");
        const trace = requestBoolean(body.trace, "trace");
        if (target && (source || allSources)) {
          throw new ServeHttpError(400, "invalid_request", "target cannot be combined with source or allSources.");
        }

        const targets = target || source || allSources
          ? await resolveTargets(serverOptions, { allSources, source, target, trace })
          : defaultTargets.map((resolvedTarget) => ({
              ...resolvedTarget,
              options: queryOptionsFromServeOptions(resolvedTarget.options, serverOptions, trace)
            }));
        writeJson(response, 200, await queryTargets(targets, question, serverOptions));
        return;
      }

      notFound(response);
    })().catch((error: unknown) => {
      const result = statusForThrownError(error);
      writeError(response, result.status, result.code, result.message);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const resolvedHost = address.address === "::" ? "localhost" : address.address;
  const resolvedPort = address.port;

  return {
    url: `http://${resolvedHost}:${resolvedPort}`,
    host: resolvedHost,
    port: resolvedPort,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
