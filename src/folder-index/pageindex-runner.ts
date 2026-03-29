import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { loadPageIndexConfig } from "./config";
import { isSubPath } from "./path-utils";
import { PageIndexOptions } from "./types";

const MAX_CAPTURED_OUTPUT = 64 * 1024;
const DEFAULT_MARKDOWN_ARGS = ["--if-add-node-text", "yes", "--if-add-node-id", "yes"];
const unsupportedOutputArgs = new Set<string>();

const BATCH_WORKER_CODE = String.raw`
import asyncio
import json
import os
import sys
import traceback

_protocol_stdout = sys.stdout
sys.stdout = sys.stderr

def send(message):
    _protocol_stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    _protocol_stdout.flush()

try:
    from pageindex.page_index_md import md_to_tree
    from pageindex.utils import ConfigLoader
except Exception:
    send({"type": "startup-error", "error": traceback.format_exc()})
    raise SystemExit(0)

send({"type": "ready"})

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if request.get("type") == "stop":
            break
        request_id = request["id"]
        user_opt = {
            "model": request.get("model"),
            "if_add_node_summary": request.get("ifAddNodeSummary"),
            "if_add_doc_description": request.get("ifAddDocDescription"),
            "if_add_node_text": request.get("ifAddNodeText"),
            "if_add_node_id": request.get("ifAddNodeId"),
        }
        opt = ConfigLoader().load(user_opt)
        tree = asyncio.run(md_to_tree(
            md_path=request["inputPath"],
            if_thinning=bool(request.get("ifThinning", False)),
            min_token_threshold=int(request.get("thinningThreshold", 5000)),
            if_add_node_summary=opt.if_add_node_summary,
            summary_token_threshold=int(request.get("summaryTokenThreshold", 200)),
            model=opt.model,
            if_add_doc_description=opt.if_add_doc_description,
            if_add_node_text=opt.if_add_node_text,
            if_add_node_id=opt.if_add_node_id,
        ))
        output_path = request["outputPath"]
        output_dir = os.path.dirname(output_path)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(tree, f, indent=2, ensure_ascii=False)
        send({"type": "done", "id": request_id})
    except Exception:
        send({"type": "error", "id": request.get("id"), "error": traceback.format_exc()})
`;

export type PageIndexBatchJob = {
  inputPath: string;
  outputPath: string;
};

export type PageIndexBatchResult =
  | (PageIndexBatchJob & {
      ok: true;
    })
  | (PageIndexBatchJob & {
      ok: false;
      error: string;
    });

type PageIndexBatchCallbacks = {
  onJobStart?: (job: PageIndexBatchJob, index: number) => void;
};

type BatchMarkdownArgs = {
  ifAddDocDescription?: string;
  ifAddNodeId: string;
  ifAddNodeSummary?: string;
  ifAddNodeText: string;
  ifThinning: boolean;
  summaryTokenThreshold: number;
  thinningThreshold: number;
};

type WorkerRunResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

class PageIndexRunError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message);
  }
}

function appendCapturedOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pageIndexRunError(code: number | null, stdout: string, stderr: string): PageIndexRunError {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  return new PageIndexRunError(
    `PageIndex failed with exit code ${code ?? "unknown"}\nSTDOUT:\n${trimmedStdout}\nSTDERR:\n${trimmedStderr}`,
    trimmedStdout,
    trimmedStderr
  );
}

function parseIntegerArg(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBatchMarkdownArgs(extraArgs: string[] | undefined): { args: BatchMarkdownArgs; unsupported: string[] } {
  const args: BatchMarkdownArgs = {
    ifAddNodeId: "yes",
    ifAddNodeText: "yes",
    ifThinning: false,
    summaryTokenThreshold: 200,
    thinningThreshold: 5000
  };
  const unsupported: string[] = [];
  const values = extraArgs ?? [];

  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];

    switch (key) {
      case "--if-thinning":
        if (value === undefined) {
          unsupported.push(key);
          break;
        }
        args.ifThinning = value.toLowerCase() === "yes" || value.toLowerCase() === "true" || value === "1";
        index += 1;
        break;
      case "--thinning-threshold": {
        const parsed = parseIntegerArg(value);
        if (parsed === undefined) {
          unsupported.push(key);
          break;
        }
        args.thinningThreshold = parsed;
        index += 1;
        break;
      }
      case "--summary-token-threshold": {
        const parsed = parseIntegerArg(value);
        if (parsed === undefined) {
          unsupported.push(key);
          break;
        }
        args.summaryTokenThreshold = parsed;
        index += 1;
        break;
      }
      case "--if-add-node-summary":
        if (value === undefined) {
          unsupported.push(key);
          break;
        }
        args.ifAddNodeSummary = value;
        index += 1;
        break;
      case "--if-add-doc-description":
        if (value === undefined) {
          unsupported.push(key);
          break;
        }
        args.ifAddDocDescription = value;
        index += 1;
        break;
      case "--if-add-node-text":
        if (value === undefined) {
          unsupported.push(key);
          break;
        }
        args.ifAddNodeText = value;
        index += 1;
        break;
      case "--if-add-node-id":
        if (value === undefined) {
          unsupported.push(key);
          break;
        }
        args.ifAddNodeId = value;
        index += 1;
        break;
      default:
        unsupported.push(key);
        break;
    }
  }

  return { args, unsupported };
}

function workerEnv(config: ReturnType<typeof loadPageIndexConfig>, cliDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...config.env,
    OPENAI_BASE_URL: config.baseUrl,
    OPENAI_API_KEY: config.apiKey ?? process.env.OPENAI_API_KEY ?? ""
  };
  const pythonPath = [cliDir, env.PYTHONPATH].filter((value): value is string => Boolean(value)).join(path.delimiter);
  return {
    ...env,
    PYTHONPATH: pythonPath
  };
}

class PageIndexBatchWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private closed = false;
  private closedPromise: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, { reject: (error: Error) => void; resolve: (result: WorkerRunResult) => void }>();
  private stderr = "";

  constructor(
    private readonly workerId: number,
    private readonly config: ReturnType<typeof loadPageIndexConfig>,
    private readonly cliDir: string,
    private readonly cwd: string
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(this.cwd, { recursive: true });
    const child = spawn(this.config.pythonPath, ["-u", "-c", BATCH_WORKER_CODE], {
      cwd: this.cwd,
      env: workerEnv(this.config, this.cliDir)
    });
    this.child = child;

    this.closedPromise = new Promise((resolve) => {
      child.on("close", () => resolve());
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendCapturedOutput(this.stderr, chunk);
    });

    return await new Promise<void>((resolve, reject) => {
      let readySettled = false;
      const reader = readline.createInterface({ input: child.stdout });

      const settleReady = (error?: Error): void => {
        if (readySettled) {
          return;
        }
        readySettled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      reader.on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.stderr = appendCapturedOutput(this.stderr, Buffer.from(`${line}\n`, "utf8"));
          return;
        }

        if (message.type === "ready") {
          settleReady();
          return;
        }

        if (message.type === "startup-error") {
          settleReady(new Error(typeof message.error === "string" ? message.error : "PageIndex worker failed to start"));
          return;
        }

        const id = typeof message.id === "number" ? message.id : undefined;
        const pending = id === undefined ? undefined : this.pending.get(id);
        if (!pending) {
          return;
        }

        this.pending.delete(id as number);
        if (message.type === "done") {
          pending.resolve({ ok: true });
          return;
        }
        pending.resolve({
          ok: false,
          error: typeof message.error === "string" ? message.error : "PageIndex worker returned an unknown error"
        });
      });

      child.on("error", (error) => {
        settleReady(error);
        this.rejectPending(error);
      });
      child.on("close", (code) => {
        this.closed = true;
        const error = new Error(
          `PageIndex worker ${this.workerId} exited with code ${code ?? "unknown"}${this.stderr.trim() ? `\n${this.stderr.trim()}` : ""}`
        );
        settleReady(error);
        this.rejectPending(error);
      });
    });
  }

  async run(job: PageIndexBatchJob, markdownArgs: BatchMarkdownArgs): Promise<WorkerRunResult> {
    if (!this.child || this.closed) {
      throw new Error(`PageIndex worker ${this.workerId} is not running`);
    }

    const id = this.nextId;
    this.nextId += 1;

    return await new Promise<WorkerRunResult>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      const payload = {
        type: "run",
        id,
        inputPath: job.inputPath,
        outputPath: job.outputPath,
        model: this.config.model,
        ifAddDocDescription: markdownArgs.ifAddDocDescription,
        ifAddNodeId: markdownArgs.ifAddNodeId,
        ifAddNodeSummary: markdownArgs.ifAddNodeSummary,
        ifAddNodeText: markdownArgs.ifAddNodeText,
        ifThinning: markdownArgs.ifThinning,
        summaryTokenThreshold: markdownArgs.summaryTokenThreshold,
        thinningThreshold: markdownArgs.thinningThreshold
      };

      this.child?.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.child || this.closed) {
      return;
    }

    try {
      this.child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
      this.child.stdin.end();
    } catch {
      // Closing a failed worker is best-effort.
    }

    await Promise.race([
      this.closedPromise,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.child && !this.closed) {
            this.child.kill();
          }
          resolve();
        }, 1000);
      })
    ]);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function unsupportedOutputArgKey(pythonPath: string, cliPath: string, outputArg: string): string {
  return `${pythonPath}\0${cliPath}\0${outputArg}`;
}

function outputArgWasRejected(error: unknown, outputArg: string): boolean {
  if (!(error instanceof PageIndexRunError)) {
    return false;
  }

  const output = `${error.stdout}\n${error.stderr}`;
  return output.includes("unrecognized arguments") && output.includes(outputArg);
}

async function fileUpdatedAfter(filePath: string, startedAtMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs >= startedAtMs - 1000;
  } catch {
    return false;
  }
}

async function findJsonFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(absolutePath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

async function locatePageIndexResult(searchRoots: string[], startedAtMs: number): Promise<string | undefined> {
  const uniqueRoots = [...new Set(searchRoots)];
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

  for (const root of uniqueRoots) {
    const files = await findJsonFiles(root);
    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs >= startedAtMs - 1000) {
        candidates.push({ filePath, mtimeMs: stat.mtimeMs });
      }
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath;
}

function normalizeBatchJobs(jobs: PageIndexBatchJob[]): PageIndexBatchJob[] {
  return jobs.map((job) => ({
    inputPath: path.resolve(job.inputPath),
    outputPath: path.resolve(job.outputPath)
  }));
}

function failedBatchResults(jobs: PageIndexBatchJob[], error: string, callbacks: PageIndexBatchCallbacks): PageIndexBatchResult[] {
  return jobs.map((job, index) => {
    callbacks.onJobStart?.(job, index);
    return {
      ...job,
      ok: false,
      error
    };
  });
}

async function runPageIndexSingleFallback(
  job: PageIndexBatchJob,
  options: ReturnType<typeof loadPageIndexConfig>
): Promise<PageIndexBatchResult> {
  try {
    await runPageIndex(job.inputPath, job.outputPath, options);
    return {
      ...job,
      ok: true
    };
  } catch (error) {
    return {
      ...job,
      ok: false,
      error: errorMessage(error)
    };
  }
}

async function runAllSingleFallback(
  jobs: PageIndexBatchJob[],
  options: ReturnType<typeof loadPageIndexConfig>,
  callbacks: PageIndexBatchCallbacks
): Promise<PageIndexBatchResult[]> {
  const results: PageIndexBatchResult[] = [];
  for (let index = 0; index < jobs.length; index += 1) {
    callbacks.onJobStart?.(jobs[index], index);
    results.push(await runPageIndexSingleFallback(jobs[index], options));
  }
  return results;
}

export async function runPageIndexBatchPool(
  jobs: PageIndexBatchJob[],
  options: PageIndexOptions = {},
  callbacks: PageIndexBatchCallbacks = {}
): Promise<PageIndexBatchResult[]> {
  const config = loadPageIndexConfig(options);
  const normalizedJobs = normalizeBatchJobs(jobs);

  if (normalizedJobs.length === 0) {
    return [];
  }

  if (!config.cliPath) {
    return failedBatchResults(normalizedJobs, "PAGEINDEX_CLI is required to run PageIndex", callbacks);
  }

  const parsedArgs = parseBatchMarkdownArgs(config.extraArgs);
  if (parsedArgs.unsupported.length > 0) {
    if (config.pageIndexRunner === "auto") {
      return await runAllSingleFallback(normalizedJobs, config, callbacks);
    }
    return failedBatchResults(
      normalizedJobs,
      `PageIndex batch runner does not support extra args: ${parsedArgs.unsupported.join(", ")}`,
      callbacks
    );
  }

  const cliPath = path.resolve(config.cliPath);
  const cliDir = path.dirname(cliPath);
  const workerCount = Math.min(Math.max(1, Math.floor(config.concurrency)), normalizedJobs.length);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-batch-"));
  const workers: PageIndexBatchWorker[] = [];

  try {
    for (let index = 0; index < workerCount; index += 1) {
      const worker = new PageIndexBatchWorker(index + 1, config, cliDir, path.join(tempDir, `worker-${index + 1}`));
      workers.push(worker);
    }

    try {
      await Promise.all(workers.map((worker) => worker.start()));
    } catch (error) {
      await Promise.allSettled(workers.map((worker) => worker.stop()));
      if (config.pageIndexRunner === "auto") {
        return await runAllSingleFallback(normalizedJobs, config, callbacks);
      }
      return failedBatchResults(normalizedJobs, errorMessage(error), callbacks);
    }

    const results = new Array<PageIndexBatchResult>(normalizedJobs.length);
    let nextIndex = 0;

    async function runWorkerLoop(worker: PageIndexBatchWorker): Promise<void> {
      while (nextIndex < normalizedJobs.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const job = normalizedJobs[currentIndex];
        callbacks.onJobStart?.(job, currentIndex);

        try {
          const result = await worker.run(job, parsedArgs.args);
          if (result.ok) {
            results[currentIndex] = {
              ...job,
              ok: true
            };
          } else {
            results[currentIndex] = {
              ...job,
              ok: false,
              error: result.error
            };
          }
        } catch (error) {
          results[currentIndex] =
            config.pageIndexRunner === "auto"
              ? await runPageIndexSingleFallback(job, config)
              : {
                  ...job,
                  ok: false,
                  error: errorMessage(error)
                };
        }
      }
    }

    await Promise.all(workers.map((worker) => runWorkerLoop(worker)));
    return results;
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.stop()));
    if (isSubPath(os.tmpdir(), tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function runPageIndex(inputPath: string, outputPath: string, options: PageIndexOptions = {}): Promise<void> {
  const config = loadPageIndexConfig(options);

  if (!config.cliPath) {
    throw new Error("PAGEINDEX_CLI is required to run PageIndex");
  }

  const cliPath = path.resolve(config.cliPath);
  const absoluteInputPath = path.resolve(inputPath);
  const absoluteOutputPath = path.resolve(outputPath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-"));

  await fs.mkdir(path.dirname(absoluteOutputPath), { recursive: true });

  try {
    const runOnce = async (outputArg: string | undefined): Promise<number> => {
      const startedAtMs = Date.now();
      const args = [cliPath, "--md_path", absoluteInputPath, "--model", config.model, ...DEFAULT_MARKDOWN_ARGS];

      if (outputArg) {
        args.push(outputArg, absoluteOutputPath);
      }

      if (config.extraArgs?.length) {
        args.push(...config.extraArgs);
      }

      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        let stderr = "";

        const child = spawn(config.pythonPath, args, {
          cwd: tempDir,
          env: {
            ...process.env,
            ...config.env,
            OPENAI_BASE_URL: config.baseUrl,
            OPENAI_API_KEY: config.apiKey ?? process.env.OPENAI_API_KEY ?? ""
          }
        });

        child.stdout.on("data", (chunk: Buffer) => {
          stdout = appendCapturedOutput(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = appendCapturedOutput(stderr, chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(pageIndexRunError(code, stdout, stderr));
        });
      });

      return startedAtMs;
    };

    let outputArg = config.outputArg;
    const outputArgKey = outputArg ? unsupportedOutputArgKey(config.pythonPath, cliPath, outputArg) : undefined;
    if (outputArgKey && unsupportedOutputArgs.has(outputArgKey)) {
      outputArg = undefined;
    }

    let startedAtMs: number;
    try {
      startedAtMs = await runOnce(outputArg);
    } catch (error) {
      if (!outputArg || !outputArgKey || !outputArgWasRejected(error, outputArg)) {
        throw error;
      }

      unsupportedOutputArgs.add(outputArgKey);
      startedAtMs = await runOnce(undefined);
    }

    const cliDir = path.dirname(cliPath);
    const inputDir = path.dirname(absoluteInputPath);

    if (await fileUpdatedAfter(absoluteOutputPath, startedAtMs)) {
      return;
    }

    const searchRoots = [
      path.join(tempDir, "results"),
      tempDir,
      path.join(cliDir, "results"),
      path.join(inputDir, "results"),
      path.join(process.cwd(), "results")
    ];
    const resultPath = await locatePageIndexResult(searchRoots, startedAtMs);

    if (!resultPath) {
      throw new Error("PageIndex completed but no generated JSON result was found");
    }

    if (path.resolve(resultPath) !== absoluteOutputPath) {
      await fs.copyFile(resultPath, absoluteOutputPath);
    }
  } finally {
    if (isSubPath(os.tmpdir(), tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

function findSummary(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.summary === "string" && record.summary.trim()) {
    return record.summary.trim();
  }

  for (const key of ["root", "tree", "document"]) {
    const nested = findSummary(record[key]);
    if (nested) {
      return nested;
    }
  }

  for (const key of ["children", "nodes"]) {
    const children = record[key];
    if (Array.isArray(children)) {
      for (const child of children) {
        const nested = findSummary(child);
        if (nested) {
          return nested;
        }
      }
    }
  }

  return undefined;
}

export async function readPageIndexSummary(indexPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    return findSummary(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
