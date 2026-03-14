import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadPageIndexConfig } from "./config";
import { isSubPath } from "./path-utils";
import { PageIndexOptions } from "./types";

const MAX_CAPTURED_OUTPUT = 64 * 1024;
const DEFAULT_MARKDOWN_ARGS = ["--if-add-node-text", "yes", "--if-add-node-id", "yes"];
const unsupportedOutputArgs = new Set<string>();

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

function pageIndexRunError(code: number | null, stdout: string, stderr: string): PageIndexRunError {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  return new PageIndexRunError(
    `PageIndex failed with exit code ${code ?? "unknown"}\nSTDOUT:\n${trimmedStdout}\nSTDERR:\n${trimmedStderr}`,
    trimmedStdout,
    trimmedStderr
  );
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
