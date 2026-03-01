import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

type CommandResult = {
  stdout: string;
  stderr: string;
};

const DEFAULT_EXPECTED_TEXT = "PKCE";
const DEFAULT_QUESTION = "What problem does PKCE solve in OAuth 2.0, and how does it reduce authorization code interception risk? Cite the source.";
const DEFAULT_COMMAND_TIMEOUT_MS = 300000;
const DEFAULT_HEARTBEAT_MS = 10000;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function getSkipReason(): string | false {
  if (process.env.RAGBOX_E2E !== "1") {
    return "Set RAGBOX_E2E=1 to run the real e2e test.";
  }

  const missing = ["PAGEINDEX_CLI"].filter((name) => !process.env[name]);
  if (!process.env.RAGBOX_E2E_API_KEY && !process.env.OPENAI_API_KEY) {
    missing.push("OPENAI_API_KEY or RAGBOX_E2E_API_KEY");
  }
  if (!existsSync(resolveDocsDir())) {
    missing.push(`RAGBOX_E2E_DOCS_DIR (${resolveDocsDir()})`);
  }
  if (missing.length > 0) {
    return `Missing required e2e environment variables: ${missing.join(", ")}`;
  }

  return false;
}

function buildQueryArgs(target: string, question: string): string[] {
  const args = ["query", target, question];
  const apiKey = firstNonEmpty(process.env.RAGBOX_E2E_API_KEY, process.env.OPENAI_API_KEY);
  const baseUrl = firstNonEmpty(process.env.RAGBOX_E2E_BASE_URL, process.env.OPENAI_BASE_URL);
  const model = firstNonEmpty(process.env.RAGBOX_E2E_QUERY_MODEL, process.env.PAGEINDEX_MODEL, process.env.LLM_MODEL) ?? "gpt-4o-mini";

  if (apiKey) {
    args.push("--api-key", apiKey);
  }
  if (baseUrl) {
    args.push("--base-url", baseUrl);
  }
  if (model) {
    args.push("--model", model);
  }

  return args;
}

function buildIndexArgs(docsDir: string, outputDir?: string): string[] {
  const args = ["index", docsDir, "--concurrency", process.env.RAGBOX_E2E_CONCURRENCY ?? "1"];
  const pythonPath = firstNonEmpty(process.env.RAGBOX_E2E_PAGEINDEX_PYTHON, process.env.PAGEINDEX_PYTHON);
  const apiKey = firstNonEmpty(process.env.RAGBOX_E2E_API_KEY, process.env.OPENAI_API_KEY);
  const baseUrl = firstNonEmpty(process.env.RAGBOX_E2E_BASE_URL, process.env.OPENAI_BASE_URL);
  const model = firstNonEmpty(process.env.RAGBOX_E2E_PAGEINDEX_MODEL, process.env.PAGEINDEX_MODEL, process.env.LLM_MODEL) ?? "gpt-4o-mini";

  if (outputDir) {
    args.push("--output-dir", outputDir);
  }
  if (pythonPath) {
    args.push("--pageindex-python", pythonPath);
  }
  if (apiKey) {
    args.push("--api-key", apiKey);
  }
  if (baseUrl) {
    args.push("--base-url", baseUrl);
  }
  if (model) {
    args.push("--model", model);
  }

  return args;
}

function repoRoot(): string {
  return path.resolve(__dirname, "../..");
}

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot(), value);
}

function resolveDocsDir(): string {
  return resolveFromRepo(process.env.RAGBOX_E2E_DOCS_DIR ?? "examples");
}

function resolveOutputDir(docsDir: string): string {
  return resolveFromRepo(process.env.RAGBOX_E2E_OUTPUT_DIR ?? path.join(docsDir, ".pageindex"));
}

function buildE2eEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_API_KEY: firstNonEmpty(process.env.RAGBOX_E2E_API_KEY, process.env.OPENAI_API_KEY),
    OPENAI_BASE_URL: firstNonEmpty(process.env.RAGBOX_E2E_BASE_URL, process.env.OPENAI_BASE_URL),
    PAGEINDEX_MODEL: firstNonEmpty(process.env.RAGBOX_E2E_PAGEINDEX_MODEL, process.env.PAGEINDEX_MODEL, process.env.LLM_MODEL),
    PAGEINDEX_PYTHON: firstNonEmpty(process.env.RAGBOX_E2E_PAGEINDEX_PYTHON, process.env.PAGEINDEX_PYTHON)
  };
}

function logStep(message: string): void {
  process.stdout.write(`[e2e] ${message}\n`);
}

function redactArgs(args: string[]): string {
  return args
    .map((arg, index) => {
      if (args[index - 1] === "--api-key") {
        return "<redacted>";
      }
      return arg;
    })
    .join(" ");
}

function commandTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.RAGBOX_E2E_COMMAND_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COMMAND_TIMEOUT_MS;
}

function heartbeatMs(): number {
  const parsed = Number.parseInt(process.env.RAGBOX_E2E_HEARTBEAT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEARTBEAT_MS;
}

async function runCli(label: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<CommandResult> {
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  return await new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = Date.now();
    const timeoutMs = commandTimeoutMs();
    logStep(`start ${label}: ragbox ${redactArgs(args)}`);
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `CLI command timed out after ${timeoutMs}ms\nLABEL:\n${label}\nARGS:\n${redactArgs(args)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
        )
      );
    }, timeoutMs);
    const heartbeat = setInterval(() => {
      if (!settled) {
        logStep(`still running ${label}; elapsed=${Date.now() - startedAt}ms`);
      }
    }, heartbeatMs());

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (code === 0) {
        logStep(`done ${label} in ${Date.now() - startedAt}ms`);
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(`CLI failed with exit code ${code}\nLABEL:\n${label}\nARGS:\n${redactArgs(args)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
      );
    });
  });
}

function assertIndexSucceeded(result: CommandResult): void {
  const readyMatch = result.stdout.match(/^ready=(\d+)$/m);

  assert.match(result.stdout, /Indexed /);
  assert.ok(readyMatch, `Expected ready count in stdout:\n${result.stdout}`);
  assert.ok(Number.parseInt(readyMatch[1], 10) > 0, `Expected at least one ready document:\n${result.stdout}`);
  assert.match(result.stdout, /failed=0/);
}

function assertAnswerUsesIndexedContext(result: CommandResult, expectedText: string): void {
  assert.match(result.stdout, new RegExp(expectedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

function logAnswer(label: string, result: CommandResult): void {
  logStep(`answer from ${label}:`);
  process.stdout.write(`${result.stdout.trim()}\n`);
}

test(
  "e2e: real CLI indexes docs with PageIndex and queries a real OpenAI-compatible model",
  {
    skip: getSkipReason(),
    timeout: Number.parseInt(process.env.RAGBOX_E2E_TIMEOUT_MS ?? "900000", 10)
  },
  async () => {
    const docsDir = resolveDocsDir();
    const outputDir = resolveOutputDir(docsDir);
    const question = process.env.RAGBOX_E2E_QUESTION ?? DEFAULT_QUESTION;
    const expectedText = process.env.RAGBOX_E2E_EXPECTED_TEXT ?? DEFAULT_EXPECTED_TEXT;
    const env = buildE2eEnv();

    logStep(`docs dir: ${docsDir}`);
    logStep(`output dir: ${outputDir}`);

    const indexResult = await runCli("index examples", buildIndexArgs(docsDir, outputDir), { cwd: repoRoot(), env });
    assertIndexSucceeded(indexResult);
    await fs.access(path.join(outputDir, "manifest.json"));
    await fs.access(path.join(outputDir, "root-tree.json"));

    const outputDirQueryResult = await runCli("query output dir", buildQueryArgs(outputDir, question), { cwd: repoRoot(), env });
    logAnswer("output dir", outputDirQueryResult);
    assertAnswerUsesIndexedContext(outputDirQueryResult, expectedText);

    const docsDirQueryResult = await runCli("query docs dir", buildQueryArgs(docsDir, question), { cwd: repoRoot(), env });
    logAnswer("docs dir", docsDirQueryResult);
    assertAnswerUsesIndexedContext(docsDirQueryResult, expectedText);
  }
);
