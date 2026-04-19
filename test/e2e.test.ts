import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { SUPPORTED_PAGEINDEX_VERSION } from "../src/pageindex-version";
import { managedPageIndexPythonPath } from "../src/setup-pageindex";

const MOCK_API_KEY = "ragbox-e2e-mock-key";
const MOCK_MODEL = "gpt-4o-mini";
const MOCK_ANSWER = "MOCK_E2E_ANSWER: ragbox start watches, indexes, and serves the documentation.";
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TEST_TIMEOUT_MS = 15 * 60 * 1000;

type CliResult = {
  stderr: string;
  stdout: string;
};

type MockRequestKind = "answer" | "pageindex-summary" | "select-documents" | "select-nodes";

type MockRequest = {
  authorization?: string;
  kind: MockRequestKind;
  model?: string;
  path?: string;
  prompt: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function e2eSkipReason(): string | false {
  return process.env.RAGBOX_E2E === "1"
    ? false
    : "Set RAGBOX_E2E=1 to run the real CLI/PageIndex e2e test with the local model mock.";
}

function repoRoot(): string {
  return path.resolve(__dirname, "../..");
}

function commandTimeoutMs(): number {
  return positiveInteger(process.env.RAGBOX_E2E_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS);
}

function testTimeoutMs(): number {
  return positiveInteger(process.env.RAGBOX_E2E_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS);
}

function logStep(message: string): void {
  process.stdout.write(`[e2e] ${message}\n`);
}

async function runCli(label: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  const cliPath = path.resolve(__dirname, "../src/cli.js");
  return await new Promise<CliResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = Date.now();
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...env }
    });

    logStep(`start ${label}`);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${label} timed out after ${commandTimeoutMs()}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, commandTimeoutMs());

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        logStep(`done ${label} in ${Date.now() - startedAt}ms`);
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${label} failed with exit code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    });
  });
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString("utf8");
    if (raw.length > 2 * 1024 * 1024) {
      throw new Error("Mock LLM request body exceeded 2 MiB");
    }
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function promptFromBody(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .map((message) => {
      if (typeof message !== "object" || message === null) {
        return "";
      }
      const content = (message as { content?: unknown }).content;
      return typeof content === "string" ? content : "";
    })
    .join("\n");
}

function mockCompletion(prompt: string): { content: string; kind: MockRequestKind } {
  if (prompt.includes("generate a description of the partial document")) {
    return {
      content: "This section explains that ragbox start watches documentation, refreshes its index, and serves queries.",
      kind: "pageindex-summary"
    };
  }

  if (prompt.includes("root documentation tree") && prompt.includes('"documents"')) {
    const docId = prompt.match(/"node_id"\s*:\s*"(doc:[^"]+)"/)?.[1];
    assert.ok(docId, "The document-selection prompt should contain a document node id");
    return { content: JSON.stringify({ documents: [docId] }), kind: "select-documents" };
  }

  if (prompt.includes("document tree") && prompt.includes('"nodes"')) {
    const nodeId = prompt.match(/"node_id"\s*:\s*"(\d{4})"/)?.[1];
    assert.ok(nodeId, "The node-selection prompt should contain a PageIndex node id");
    return { content: JSON.stringify({ nodes: [nodeId] }), kind: "select-nodes" };
  }

  if (prompt.includes("Answer the user question using only the provided context")) {
    assert.match(prompt, /ragbox start watches documentation/i);
    return { content: MOCK_ANSWER, kind: "answer" };
  }

  throw new Error(`Unexpected prompt received by mock LLM: ${prompt.slice(0, 240)}`);
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json", Connection: "close" });
  response.end(JSON.stringify(value));
}

async function startMockLlm(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
}> {
  const requests: MockRequest[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        writeJson(response, 404, { error: { message: "Expected POST /v1/chat/completions" } });
        return;
      }
      if (request.headers.authorization !== `Bearer ${MOCK_API_KEY}`) {
        writeJson(response, 401, { error: { message: "Unexpected authorization header" } });
        return;
      }

      const body = await readRequestBody(request);
      const prompt = promptFromBody(body);
      const completion = mockCompletion(prompt);
      requests.push({
        authorization: request.headers.authorization,
        kind: completion.kind,
        model: typeof body.model === "string" ? body.model : undefined,
        path: request.url,
        prompt
      });
      writeJson(response, 200, {
        id: `chatcmpl-ragbox-e2e-${requests.length}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MOCK_MODEL,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: completion.content },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
    })().catch((error) => {
      writeJson(response, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Mock LLM should listen on a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

function assertIndexSucceeded(result: CliResult, ready: number): void {
  assert.match(result.stdout, /Indexed /);
  assert.match(result.stdout, new RegExp(`^ready=${ready}$`, "m"));
  assert.match(result.stdout, /^failed=0$/m);
}

function parseQueryResult(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test(
  "e2e: real CLI implicitly installs PageIndex and uses a local OpenAI-compatible model mock",
  { skip: e2eSkipReason(), timeout: testTimeoutMs() },
  async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-e2e-"));
    const docsDir = path.join(projectDir, "docs");
    const outputDir = path.join(docsDir, ".pageindex");
    const mockLlm = await startMockLlm();
    const env = {
      OPENAI_API_KEY: MOCK_API_KEY,
      OPENAI_BASE_URL: mockLlm.baseUrl,
      PAGEINDEX_MODEL: MOCK_MODEL,
      RAGBOX_VERBOSE: "1"
    };

    try {
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(projectDir, ".gitignore"), "# e2e project\n", "utf8");
      const longSection = Array.from(
        { length: 120 },
        (_, index) => `Ragbox start watches documentation, refreshes the PageIndex tree, and serves queries (${index + 1}).`
      ).join(" ");
      await fs.writeFile(path.join(docsDir, "guide.md"), `# Ragbox Start\n\n${longSection}\n`, "utf8");

      const firstIndex = await runCli(
        "first index with implicit PageIndex install",
        ["index", docsDir, "--concurrency", "1", "--api-key", MOCK_API_KEY, "--base-url", mockLlm.baseUrl, "--model", MOCK_MODEL],
        projectDir,
        env
      );
      assertIndexSucceeded(firstIndex, 1);
      assert.match(firstIndex.stderr, /PageIndex SDK not found; preparing pageindex==/);
      assert.match(firstIndex.stderr, /PageIndex SDK ready:/);
      assert.ok(mockLlm.requests.some((request) => request.kind === "pageindex-summary"));

      const managedPython = managedPageIndexPythonPath(projectDir);
      await fs.access(managedPython);
      const versionCheck = spawnSync(
        managedPython,
        ["-c", "import importlib.metadata; print(importlib.metadata.version('pageindex'))"],
        { encoding: "utf8" }
      );
      assert.equal(versionCheck.status, 0, versionCheck.stderr);
      assert.equal(versionCheck.stdout.trim(), SUPPORTED_PAGEINDEX_VERSION);
      assert.match(await fs.readFile(path.join(projectDir, ".gitignore"), "utf8"), /^\.ragbox\/$/m);
      await fs.access(path.join(outputDir, "manifest.json"));
      await fs.access(path.join(outputDir, "root-tree.json"));

      await fs.writeFile(path.join(docsDir, "z-extra.md"), "# Z Extra\n\nA short extra document.\n", "utf8");
      const secondIndex = await runCli(
        "second index reusing managed PageIndex",
        ["index", docsDir, "--concurrency", "1", "--api-key", MOCK_API_KEY, "--base-url", mockLlm.baseUrl, "--model", MOCK_MODEL],
        projectDir,
        env
      );
      assertIndexSucceeded(secondIndex, 2);
      assert.doesNotMatch(secondIndex.stderr, /PageIndex SDK not found; preparing/);

      for (const [label, target] of [
        ["output directory", outputDir],
        ["docs directory", docsDir]
      ] as const) {
        const query = await runCli(
          `query ${label}`,
          [
            "query",
            target,
            "What does ragbox start do?",
            "--api-key",
            MOCK_API_KEY,
            "--base-url",
            mockLlm.baseUrl,
            "--model",
            MOCK_MODEL,
            "--trace"
          ],
          projectDir,
          env
        );
        const parsed = parseQueryResult(query);
        assert.equal(parsed.answer, MOCK_ANSWER);
        assert.ok(Array.isArray(parsed.sources) && parsed.sources.length > 0, `${label} query should contain indexed sources`);
      }

      const requestKinds = new Set(mockLlm.requests.map((request) => request.kind));
      assert.deepEqual(
        requestKinds,
        new Set<MockRequestKind>(["answer", "pageindex-summary", "select-documents", "select-nodes"])
      );
      assert.ok(mockLlm.requests.every((request) => request.authorization === `Bearer ${MOCK_API_KEY}`));
      assert.ok(mockLlm.requests.every((request) => request.path === "/v1/chat/completions"));
      assert.ok(mockLlm.requests.every((request) => request.model === MOCK_MODEL));
    } finally {
      await mockLlm.close();
      if (process.env.RAGBOX_E2E_KEEP_TEMP === "1") {
        logStep(`kept temp project: ${projectDir}`);
      } else {
        await fs.rm(projectDir, { recursive: true, force: true });
      }
    }
  }
);
