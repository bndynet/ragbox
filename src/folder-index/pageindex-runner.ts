import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { SUPPORTED_PAGEINDEX_VERSION } from "../pageindex-version";
import { ensureManagedPageIndex, managedPageIndexPythonPath } from "../setup-pageindex";
import { loadPageIndexConfig } from "./config";
import { isSubPath } from "./path-utils";
import { PageIndexOptions } from "./types";

const MAX_CAPTURED_OUTPUT = 64 * 1024;

const PAGEINDEX_WORKER_CODE = String.raw`
import asyncio
import importlib.metadata
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
    installed_version = importlib.metadata.version("pageindex")
    expected_version = ${JSON.stringify(SUPPORTED_PAGEINDEX_VERSION)}
    if installed_version != expected_version:
        raise RuntimeError(
            f"Unsupported PageIndex version {installed_version}; "
            f"ragbox requires pageindex=={expected_version}. "
            "Install the required package in the configured Python, or remove the explicit "
            "PageIndex Python setting to use ragbox's managed environment."
        )
    from pageindex import md_to_tree
except Exception:
    send({"type": "startup-error", "error": traceback.format_exc()})
    raise SystemExit(0)

send({"type": "ready", "version": installed_version})

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        if request.get("type") == "stop":
            break
        request_id = request["id"]
        tree = asyncio.run(md_to_tree(
            md_path=request["inputPath"],
            if_thinning=False,
            min_token_threshold=5000,
            if_add_node_summary="yes",
            summary_token_threshold=200,
            model=request["model"],
            if_add_doc_description="no",
            if_add_node_text="yes",
            if_add_node_id="yes",
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
  | (PageIndexBatchJob & { ok: true })
  | (PageIndexBatchJob & { ok: false; error: string });

export type PageIndexInstallation = {
  pythonPath: string;
  version: string;
};

type PageIndexBatchCallbacks = {
  onJobStart?: (job: PageIndexBatchJob, index: number) => void;
};

type WorkerRunResult = { ok: true } | { ok: false; error: string };

function appendCapturedOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workerEnv(config: ReturnType<typeof loadPageIndexConfig>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...config.env,
    OPENAI_BASE_URL: config.baseUrl,
    OPENAI_API_KEY: config.apiKey ?? process.env.OPENAI_API_KEY ?? ""
  };
}

class PageIndexWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private closed = false;
  private closedPromise: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, { reject: (error: Error) => void; resolve: (result: WorkerRunResult) => void }>();
  private stderr = "";

  constructor(
    private readonly workerId: number,
    private readonly config: ReturnType<typeof loadPageIndexConfig>,
    private readonly cwd: string
  ) {}

  async start(): Promise<void> {
    await fs.mkdir(this.cwd, { recursive: true });
    const child = spawn(this.config.pythonPath, ["-u", "-c", PAGEINDEX_WORKER_CODE], {
      cwd: this.cwd,
      env: workerEnv(this.config)
    });
    this.child = child;
    this.closedPromise = new Promise((resolve) => child.on("close", () => resolve()));

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
        error ? reject(error) : resolve();
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
        } else {
          pending.resolve({
            ok: false,
            error: typeof message.error === "string" ? message.error : "PageIndex worker returned an unknown error"
          });
        }
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

  async run(job: PageIndexBatchJob): Promise<WorkerRunResult> {
    if (!this.child || this.closed) {
      throw new Error(`PageIndex worker ${this.workerId} is not running`);
    }

    const id = this.nextId++;
    return await new Promise<WorkerRunResult>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      const payload = {
        type: "run",
        id,
        inputPath: job.inputPath,
        outputPath: job.outputPath,
        model: this.config.model
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

function normalizeJobs(jobs: PageIndexBatchJob[]): PageIndexBatchJob[] {
  return jobs.map((job) => ({ inputPath: path.resolve(job.inputPath), outputPath: path.resolve(job.outputPath) }));
}

function failedResults(jobs: PageIndexBatchJob[], error: string, callbacks: PageIndexBatchCallbacks): PageIndexBatchResult[] {
  return jobs.map((job, index) => {
    callbacks.onJobStart?.(job, index);
    return { ...job, ok: false, error };
  });
}

export async function inspectPageIndexInstallation(options: PageIndexOptions = {}): Promise<PageIndexInstallation> {
  const env = options.env ?? process.env;
  const explicitPythonPath = options.pythonPath ?? env.PAGEINDEX_PYTHON;
  const config = loadPageIndexConfig({
    ...options,
    pythonPath: explicitPythonPath ?? managedPageIndexPythonPath()
  });
  const code = [
    "import importlib.metadata, json",
    "print(json.dumps({'version': importlib.metadata.version('pageindex')}))"
  ].join("; ");

  return await new Promise<PageIndexInstallation>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(config.pythonPath, ["-c", code], { env: workerEnv(config) });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapturedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapturedOutput(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to inspect PageIndex with ${config.pythonPath}${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
        return;
      }
      try {
        const value = JSON.parse(stdout) as { version?: unknown };
        if (typeof value.version !== "string") {
          throw new Error("PageIndex did not report a package version");
        }
        resolve({ pythonPath: config.pythonPath, version: value.version });
      } catch (error) {
        reject(new Error(`Invalid PageIndex version response: ${errorMessage(error)}`));
      }
    });
  });
}

export async function runPageIndexBatchPool(
  jobs: PageIndexBatchJob[],
  options: PageIndexOptions = {},
  callbacks: PageIndexBatchCallbacks = {}
): Promise<PageIndexBatchResult[]> {
  const normalizedJobs = normalizeJobs(jobs);
  if (normalizedJobs.length === 0) {
    return [];
  }

  const env = options.env ?? process.env;
  const explicitPythonPath = options.pythonPath ?? env.PAGEINDEX_PYTHON;
  const managedPythonPath = managedPageIndexPythonPath();
  const usesManagedPython = !explicitPythonPath || path.resolve(explicitPythonPath) === path.resolve(managedPythonPath);
  const effectiveOptions = usesManagedPython
    ? {
        ...options,
        pythonPath: (
          await ensureManagedPageIndex({
            env,
            onProgress: (event) => {
              try {
                options.progress?.({ type: "pageindex-setup", ...event });
              } catch {
                // Progress reporting must not change indexing behavior.
              }
            }
          })
        ).pythonPath
      }
    : options;
  const config = loadPageIndexConfig(effectiveOptions);

  const workerCount = Math.min(Math.max(1, Math.floor(config.concurrency)), normalizedJobs.length);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-pageindex-"));
  const workers = Array.from(
    { length: workerCount },
    (_, index) => new PageIndexWorker(index + 1, config, path.join(tempDir, `worker-${index + 1}`))
  );

  try {
    try {
      await Promise.all(workers.map((worker) => worker.start()));
    } catch (error) {
      await Promise.allSettled(workers.map((worker) => worker.stop()));
      return failedResults(normalizedJobs, errorMessage(error), callbacks);
    }

    const results = new Array<PageIndexBatchResult>(normalizedJobs.length);
    let nextIndex = 0;

    async function runWorkerLoop(worker: PageIndexWorker): Promise<void> {
      while (nextIndex < normalizedJobs.length) {
        const currentIndex = nextIndex++;
        const job = normalizedJobs[currentIndex];
        callbacks.onJobStart?.(job, currentIndex);
        try {
          const result = await worker.run(job);
          results[currentIndex] = result.ok ? { ...job, ok: true } : { ...job, ok: false, error: result.error };
        } catch (error) {
          results[currentIndex] = { ...job, ok: false, error: errorMessage(error) };
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
  const [result] = await runPageIndexBatchPool([{ inputPath, outputPath }], options);
  if (!result.ok) {
    throw new Error(result.error);
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
    return findSummary(JSON.parse(await fs.readFile(indexPath, "utf8")));
  } catch {
    return undefined;
  }
}
