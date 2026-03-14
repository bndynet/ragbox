import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as ragbox from "../src/index";
import type { LlmChatRequest, LlmClient } from "../src/index";
import { loadPageIndexConfig } from "../src/folder-index/config";
import { hashFile } from "../src/folder-index/hash";
import { chatCompletionsUrl } from "../src/folder-index/llm-client";
import { diffManifest, getPageIndexPath, resolveDocumentIndexPath } from "../src/folder-index/manifest";
import { queryMultipleIndexes } from "../src/folder-index/multi-query";
import { normalizeRelativePath } from "../src/folder-index/path-utils";
import { runPageIndex } from "../src/folder-index/pageindex-runner";
import { buildNodeMap, extractNodeTextFromMarkdown, queryFolder, resolveQueryIndexLocation, stripText } from "../src/folder-index/query";
import { generateRootTree } from "../src/folder-index/root-tree";
import { createDocId, createIndexPath, scanMarkdownFiles } from "../src/folder-index/scan";
import { Manifest, ScannedFile } from "../src/folder-index/types";

function scanned(pathName: string, hash = "sha256:hash"): ScannedFile {
  const docId = createDocId(pathName);
  return {
    docId,
    path: pathName,
    absolutePath: `/tmp/${pathName}`,
    contentHash: hash,
    size: 10,
    mtimeMs: 1,
    title: path.basename(pathName, path.extname(pathName)),
    indexPath: createIndexPath(docId)
  };
}

async function writeFakePageIndexScript(scriptPath: string, summary = "sdk ok"): Promise<void> {
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output") + 1];
if (!outputPath) {
  throw new Error("missing --output");
}
fs.writeFileSync(outputPath, JSON.stringify({
  node_id: "root",
  summary: ${JSON.stringify(summary)},
  nodes: [{ node_id: "n1", title: "Body", text: "Body text" }]
}));
`,
    "utf8"
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function requestJson(url: string, options: {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
} = {}): Promise<{ status: number; body: unknown }> {
  const requestUrl = new URL(url);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);

  return await new Promise((resolve, reject) => {
    const request = http.request(
      requestUrl,
      {
        method: options.method ?? "GET",
        headers: {
          ...(body ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } : {}),
          ...options.headers
        }
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: raw ? JSON.parse(raw) as unknown : undefined
          });
        });
      }
    );
    request.on("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function queuedLlmClient(responses: string[], calls: LlmChatRequest[] = []): LlmClient {
  return {
    chatCompletion: async (request) => {
      calls.push(request);
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("No queued LLM response");
      }
      return response;
    }
  };
}

async function writeValidIndexFixture(baseDir: string, outputInsideDocs = false): Promise<{
  rootDir: string;
  outputDir: string;
  docId: string;
  indexPath: string;
  manifest: Manifest;
}> {
  const rootDir = path.join(baseDir, "docs");
  const outputDir = outputInsideDocs ? path.join(rootDir, ".pageindex") : path.join(baseDir, ".ragbox-index");
  const indexPath = "indexes/auth.pageindex.json";
  const docId = "doc:auth";
  const manifest: Manifest = {
    version: 1,
    rootDir,
    generatedAt: "2026-01-01T00:00:00.000Z",
    documents: [
      {
        docId,
        path: "auth.md",
        absolutePath: path.join(rootDir, "auth.md"),
        contentHash: "sha256:auth",
        size: 10,
        mtimeMs: 1,
        title: "Auth",
        summary: "Authentication guide",
        indexPath,
        status: "ready"
      }
    ]
  };
  const rootTree = {
    node_id: "root",
    type: "root",
    title: "docs",
    children: [
      {
        node_id: docId,
        type: "document",
        title: "Auth",
        summary: "Authentication guide",
        path: "auth.md",
        index_path: indexPath
      }
    ]
  };

  await fs.mkdir(path.join(outputDir, "indexes"), { recursive: true });
  await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "root-tree.json"), `${JSON.stringify(rootTree)}\n`, "utf8");
  await fs.writeFile(
    path.join(outputDir, indexPath),
    `${JSON.stringify({ node_id: "root", nodes: [{ node_id: "n1", text: "Auth body" }] })}\n`,
    "utf8"
  );

  return { rootDir, outputDir, docId, indexPath, manifest };
}

test("hashFile returns a streaming sha256 hash with prefix", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const filePath = path.join(tempDir, "example.md");
  const content = "hello pageindex\n";
  await fs.writeFile(filePath, content, "utf8");

  const expected = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  assert.equal(await hashFile(filePath), expected);
});

test("normalizeRelativePath returns POSIX-style relative paths", () => {
  assert.equal(normalizeRelativePath("docs\\guide\\intro.md"), "docs/guide/intro.md");
  assert.equal(normalizeRelativePath("/repo/docs/guide/intro.md", "/repo/docs"), "guide/intro.md");
  assert.equal(normalizeRelativePath("./docs/intro.md"), "docs/intro.md");
});

test("loadPageIndexConfig prefers explicit query overrides over environment variables", () => {
  const config = loadPageIndexConfig({
    apiKey: "arg-key",
    baseUrl: "https://args.example/v1",
    model: "arg-model",
    env: {
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://env.example/v1",
      PAGEINDEX_MODEL: "env-model"
    }
  });

  assert.equal(config.apiKey, "arg-key");
  assert.equal(config.baseUrl, "https://args.example/v1");
  assert.equal(config.model, "arg-model");
});

test("loadPageIndexConfig reads PageIndex extra args from the environment", () => {
  const config = loadPageIndexConfig({
    env: {
      PAGEINDEX_EXTRA_ARGS: "--if-add-node-text yes --if-add-node-id yes"
    }
  });

  assert.deepEqual(config.extraArgs, ["--if-add-node-text", "yes", "--if-add-node-id", "yes"]);
});

test("chatCompletionsUrl accepts either a base URL or a full chat completions endpoint", () => {
  assert.equal(chatCompletionsUrl("https://api.example.com/v1"), "https://api.example.com/v1/chat/completions");
  assert.equal(
    chatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/chat/completions"
  );
  assert.equal(
    chatCompletionsUrl("https://api.example.com/v1/chat/completions/"),
    "https://api.example.com/v1/chat/completions"
  );
});

test("SDK root exports only product API plus advanced namespace", () => {
  const runtimeExports = Object.keys(ragbox).filter((key) => key !== "__esModule").sort();

  assert.deepEqual(runtimeExports, ["advanced", "createIndex", "inspectIndex", "queryIndex", "startServe", "validateIndex", "watchIndex"]);
  assert.equal(typeof ragbox.createIndex, "function");
  assert.equal(typeof ragbox.startServe, "function");
  assert.equal(typeof ragbox.advanced.indexFolder, "function");
  assert.equal(typeof ragbox.advanced.queryFolder, "function");
});

test("createIndex indexes docs through product SDK options", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const progress: string[] = [];

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await writeFakePageIndexScript(scriptPath);

  const result = await ragbox.createIndex(docsDir, {
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexPython: process.execPath,
    model: "sdk-model",
    onProgress: (event) => progress.push(event.type)
  });

  assert.equal(result.version, 1);
  assert.equal(result.rootDir, docsDir);
  assert.equal(result.outputDir, outputDir);
  assert.equal(result.manifestPath, path.join(outputDir, "manifest.json"));
  assert.equal(result.rootTreePath, path.join(outputDir, "root-tree.json"));
  assert.deepEqual(result.counts, {
    total: 1,
    ready: 1,
    failed: 0,
    added: 1,
    modified: 0,
    retryFailed: 0,
    unchanged: 0,
    deleted: 0
  });
  assert.ok(progress.includes("scan"));
  assert.ok(progress.includes("write"));
});

test("createIndex reads ragbox config file options", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".sdk-config-index");
  const configPath = path.join(tempDir, "ragbox.config.json");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "keep.md"), "# Keep\n\nBody\n", "utf8");
  await writeFakePageIndexScript(scriptPath, "sdk config ok");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        pageIndex: {
          cli: "./fake-pageindex.cjs",
          python: process.execPath
        },
        index: {
          outputDir: "./.sdk-config-index",
          include: ["**/*.md"],
          exclude: []
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await ragbox.createIndex(docsDir, { configPath });

  assert.equal(result.outputDir, outputDir);
  assert.equal(result.counts.ready, 1);
});

test("queryIndex returns the structured QueryResult contract", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const { outputDir, docId } = await writeValidIndexFixture(tempDir);
  const responses = [
    JSON.stringify({ documents: [docId] }),
    JSON.stringify({ nodes: ["n1"] }),
    "Auth body. Source: auth.md#n1"
  ];
  const originalFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: responses.shift()
            }
          }
        ]
      })
    } as Response;
  }) as typeof fetch;

  try {
    const result = await ragbox.queryIndex(outputDir, "What is in auth?", {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "sdk-query-model"
    });

    assert.equal(result.version, 1);
    assert.equal(result.model, "sdk-query-model");
    assert.match(result.answer, /Auth body/);
    assert.deepEqual(result.sources.map((source) => source.reference), ["auth.md#n1"]);
    assert.equal(result.selectedDocuments[0]?.docId, docId);
    assert.equal(result.selectedNodes[0]?.nodeId, "n1");
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("queryIndex supports a custom LlmClient without fetch or API key", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const { outputDir, docId } = await writeValidIndexFixture(tempDir);
  const calls: LlmChatRequest[] = [];
  const llmClient = queuedLlmClient(
    [
      JSON.stringify({ documents: [docId] }),
      JSON.stringify({ nodes: ["n1"] }),
      "Custom answer. Source: auth.md#n1"
    ],
    calls
  );
  const originalFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("fetch should not be called when llmClient is provided");
  }) as typeof fetch;

  try {
    const result = await ragbox.queryIndex(outputDir, "What is in auth?", {
      llmClient,
      model: "custom-model"
    });

    assert.equal(result.model, "custom-model");
    assert.equal(result.answer, "Custom answer. Source: auth.md#n1");
    assert.deepEqual(result.sources.map((source) => source.reference), ["auth.md#n1"]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((call) => call.model), ["custom-model", "custom-model", "custom-model"]);
    assert.deepEqual(calls.map((call) => call.temperature), [0, 0, 0]);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("inspectIndex supports output dirs and docs dirs", async () => {
  const outputFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const outputFixture = await writeValidIndexFixture(outputFixtureDir);
  const docsFixture = await writeValidIndexFixture(docsFixtureDir, true);

  const outputInspect = await ragbox.inspectIndex(outputFixture.outputDir);
  const docsInspect = await ragbox.inspectIndex(docsFixture.rootDir);

  assert.equal(outputInspect.outputDir, outputFixture.outputDir);
  assert.equal(outputInspect.counts.ready, 1);
  assert.deepEqual(outputInspect.documents.map((document) => document.path), ["auth.md"]);
  assert.equal(docsInspect.outputDir, docsFixture.outputDir);
  assert.equal(docsInspect.rootDir, docsFixture.rootDir);
});

test("validateIndex reports valid and invalid index states", async () => {
  const validDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const missingDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const missingIndexDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const unknownDocDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const valid = await writeValidIndexFixture(validDir);
  const missingIndex = await writeValidIndexFixture(missingIndexDir);
  const unknown = await writeValidIndexFixture(unknownDocDir);

  await fs.unlink(path.join(missingIndex.outputDir, missingIndex.indexPath));
  await fs.writeFile(
    path.join(unknown.outputDir, "root-tree.json"),
    `${JSON.stringify({
      node_id: "root",
      type: "root",
      title: "docs",
      children: [{ node_id: "doc:missing", type: "document", title: "Missing", path: "missing.md" }]
    })}\n`,
    "utf8"
  );

  const validResult = await ragbox.validateIndex(valid.outputDir);
  const missingResult = await ragbox.validateIndex(missingDir);
  const missingIndexResult = await ragbox.validateIndex(missingIndex.outputDir);
  const unknownDocResult = await ragbox.validateIndex(unknown.outputDir);

  assert.equal(validResult.ok, true);
  assert.equal(validResult.inspect?.counts.ready, 1);
  assert.equal(missingResult.ok, false);
  assert.deepEqual(
    missingResult.errors.map((issue) => issue.code).sort(),
    ["missing_manifest", "missing_root_tree"]
  );
  assert.equal(missingIndexResult.ok, false);
  assert.ok(missingIndexResult.errors.some((issue) => issue.code === "missing_document_index"));
  assert.equal(unknownDocResult.ok, false);
  assert.ok(unknownDocResult.errors.some((issue) => issue.code === "root_tree_unknown_document"));
});

test("watchIndex returns a closeable handle and reports initial readiness", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const events: string[] = [];

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await writeFakePageIndexScript(scriptPath, "watch ok");

  const handle = await ragbox.watchIndex(docsDir, {
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexPython: process.execPath,
    onEvent: (event) => events.push(event.type),
    onProgress: (event) => events.push(`progress:${event.type}`)
  });
  const ready = await handle.ready;

  assert.equal(handle.rootDir, docsDir);
  assert.equal(handle.outputDir, outputDir);
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.result.counts.ready, 1);
  }
  assert.ok(events.includes("watch-start"));
  assert.ok(events.includes("watch-index-done"));
  assert.ok(events.includes("progress:scan"));

  await handle.close();
  await handle.closed;
  assert.ok(events.includes("watch-stop"));
});

test("watchIndex supports lock files, staging promotion, and health files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const stagingOutputDir = path.join(tempDir, ".ragbox-index-staging");
  const lockFile = path.join(tempDir, "watch.lock");
  const healthFile = path.join(tempDir, "watch-health.json");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const events: string[] = [];

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await writeFakePageIndexScript(scriptPath, "staging ok");

  const handle = await ragbox.watchIndex(docsDir, {
    healthFile,
    lockFile,
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexPython: process.execPath,
    staging: true,
    stagingOutputDir,
    onEvent: (event) => events.push(event.type)
  });

  try {
    const ready = await handle.ready;

    assert.equal(ready.ok, true);
    assert.ok(await pathExists(path.join(outputDir, "manifest.json")));
    assert.equal(await pathExists(stagingOutputDir), false);
    assert.ok(await pathExists(lockFile));
    const readyHealth = JSON.parse(await fs.readFile(healthFile, "utf8")) as {
      ok: boolean;
      status: string;
      result?: { ready: number };
    };
    assert.equal(readyHealth.ok, true);
    assert.equal(readyHealth.status, "ready");
    assert.equal(readyHealth.result?.ready, 1);
    assert.ok(events.includes("watch-lock-acquired"));
    assert.ok(events.includes("watch-output-promoted"));
    assert.ok(events.includes("watch-health"));
  } finally {
    await handle.close();
    await handle.closed;
  }

  const stoppedHealth = JSON.parse(await fs.readFile(healthFile, "utf8")) as {
    ok: boolean;
    status: string;
  };
  assert.equal(stoppedHealth.ok, false);
  assert.equal(stoppedHealth.status, "stopped");
  assert.equal(await pathExists(lockFile), false);
  assert.ok(events.includes("watch-lock-released"));
});

test("watchIndex retries failed document indexing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "flaky-pageindex.cjs");
  const attemptPath = path.join(tempDir, "attempt.txt");
  const events: string[] = [];

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const attemptPath = ${JSON.stringify(attemptPath)};
const attempts = fs.existsSync(attemptPath) ? Number(fs.readFileSync(attemptPath, "utf8")) : 0;
fs.writeFileSync(attemptPath, String(attempts + 1));
if (attempts === 0) {
  process.stderr.write("transient failure");
  process.exit(1);
}
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output") + 1];
fs.writeFileSync(outputPath, JSON.stringify({
  node_id: "root",
  summary: "retry ok",
  nodes: [{ node_id: "n1", title: "Body", text: "Body text" }]
}));
`,
    "utf8"
  );

  const handle = await ragbox.watchIndex(docsDir, {
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexPython: process.execPath,
    retryAttempts: 1,
    retryDelayMs: 0,
    onEvent: (event) => events.push(event.type)
  });
  const ready = await handle.ready;

  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.result.counts.ready, 1);
    assert.equal(ready.result.counts.failed, 0);
    assert.equal(ready.result.counts.retryFailed, 1);
  }
  assert.equal(await fs.readFile(attemptPath, "utf8"), "2");
  assert.ok(events.includes("watch-index-partial-failure"));
  assert.ok(events.includes("watch-index-retry"));
  assert.ok(events.includes("watch-index-done"));

  await handle.close();
  await handle.closed;
});

test("index CLI forwards shared LLM flags to PageIndex", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
function value(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
if (value("--model") !== "arg-model") {
  throw new Error("model was " + value("--model"));
}
if (process.env.OPENAI_BASE_URL !== "https://args.example/v1") {
  throw new Error("base URL was " + process.env.OPENAI_BASE_URL);
}
if (process.env.OPENAI_API_KEY !== "arg-key") {
  throw new Error("API key was " + process.env.OPENAI_API_KEY);
}
const outputPath = value("--output");
if (!outputPath) {
  throw new Error("missing --output");
}
fs.writeFileSync(outputPath, JSON.stringify({ node_id: "root", summary: "cli ok", text: "Body" }));
`,
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "index",
      docsDir,
      "--output-dir",
      outputDir,
      "--pageindex-python",
      process.execPath,
      "--api-key",
      "arg-key",
      "--base-url",
      "https://args.example/v1",
      "--model",
      "arg-model"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PAGEINDEX_CLI: scriptPath,
        OPENAI_API_KEY: "env-key",
        OPENAI_BASE_URL: "https://env.example/v1",
        PAGEINDEX_MODEL: "env-model"
      }
    }
  );

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stdout, /ready=1/);
  assert.match(result.stdout, /failed=0/);
});

test("index CLI --json prints a versioned contract", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output") + 1];
fs.writeFileSync(outputPath, JSON.stringify({ node_id: "root", summary: "contract ok", text: "Body" }));
`,
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "index",
      docsDir,
      "--output-dir",
      outputDir,
      "--pageindex-python",
      process.execPath,
      "--model",
      "arg-model",
      "--json"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PAGEINDEX_CLI: scriptPath
      }
    }
  );

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    version: number;
    command: string;
    rootDir: string;
    outputDir: string;
    manifestPath: string;
    rootTreePath: string;
    counts: { total: number; ready: number; failed: number };
  };

  assert.equal(output.version, 1);
  assert.equal(output.command, "index");
  assert.equal(await fs.realpath(output.rootDir), await fs.realpath(docsDir));
  assert.equal(await fs.realpath(output.outputDir), await fs.realpath(outputDir));
  assert.equal(output.manifestPath, path.join(outputDir, "manifest.json"));
  assert.equal(output.rootTreePath, path.join(outputDir, "root-tree.json"));
  assert.deepEqual(output.counts, {
    total: 1,
    ready: 1,
    failed: 0,
    added: 1,
    modified: 0,
    retryFailed: 0,
    unchanged: 0,
    deleted: 0
  });
});

test("init CLI writes a ragbox config file", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const configPath = path.join(tempDir, "ragbox.config.json");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  const result = spawnSync(
    process.execPath,
    [cliPath, "init", "--output", configPath, "--docs-dir", "./content", "--output-dir", "./.idx"],
    {
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stdout, /Created /);

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    version: number;
    docs: { rootDir: string; outputDir: string };
    llm: { baseUrl: string; model: string };
  };

  assert.equal(config.version, 1);
  assert.equal(config.llm.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.llm.model, "gpt-4o-mini");
  assert.equal(config.docs.rootDir, "./content");
  assert.equal(config.docs.outputDir, "./.idx");
});

test("index CLI reads ragbox docs config and include/exclude patterns", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".configured-index");
  const configPath = path.join(tempDir, "ragbox.config.json");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(path.join(docsDir, "guides"), { recursive: true });
  await fs.writeFile(path.join(docsDir, "guides", "keep.md"), "# Keep\n\nBody\n", "utf8");
  await fs.writeFile(path.join(docsDir, "guides", "skip.md"), "# Skip\n\nBody\n", "utf8");
  await fs.writeFile(path.join(docsDir, "outside.md"), "# Outside\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
function value(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
if (value("--model") !== "configured-model") {
  throw new Error("model was " + value("--model"));
}
const outputPath = value("--output");
if (!outputPath) {
  throw new Error("missing --output");
}
fs.writeFileSync(outputPath, JSON.stringify({ node_id: "root", summary: "configured ok", text: "Body" }));
`,
    "utf8"
  );
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        pageIndex: {
          cli: "./fake-pageindex.cjs",
          python: process.execPath
        },
        llm: {
          model: "configured-model"
        },
        docs: {
          rootDir: "./docs",
          outputDir: "./.configured-index",
          include: ["guides/**/*.md"],
          exclude: ["**/skip.md"]
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [cliPath, "--config", configPath, "index", "--json"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    rootDir: string;
    outputDir: string;
    counts: { total: number; ready: number };
  };

  assert.equal(await fs.realpath(output.rootDir), await fs.realpath(docsDir));
  assert.equal(await fs.realpath(output.outputDir), await fs.realpath(outputDir));
  assert.deepEqual(output.counts, {
    total: 1,
    ready: 1,
    failed: 0,
    added: 1,
    modified: 0,
    retryFailed: 0,
    unchanged: 0,
    deleted: 0
  });
});

test("CLI --config accepts a named config like prod for ragbox.config.prod.json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".prod-index");
  const configPath = path.join(tempDir, "ragbox.config.prod.json");
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await writeFakePageIndexScript(scriptPath, "prod config ok");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        pageIndex: {
          cli: "./fake-pageindex.cjs",
          python: process.execPath
        },
        docs: {
          rootDir: "./docs",
          outputDir: "./.prod-index"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [cliPath, "--config", "prod", "index", "--json"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    rootDir: string;
    outputDir: string;
    counts: { ready: number };
  };

  assert.equal(await fs.realpath(output.rootDir), await fs.realpath(docsDir));
  assert.equal(await fs.realpath(output.outputDir), await fs.realpath(outputDir));
  assert.equal(output.counts.ready, 1);
});

test("query CLI treats a single argument as the question when docs config provides the target", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const configPath = path.join(tempDir, "ragbox.config.json");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        llm: {
          apiKey: "test-key"
        },
        docs: {
          rootDir: "./docs",
          outputDir: "./.ragbox-index"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [cliPath, "--config", configPath, "query", "How do I deploy?"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Missing question/);
  assert.match(result.stderr, /Expected a docs folder/);
});

test("query CLI accepts comma-separated config sources for multi-source query", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const configPath = path.join(tempDir, "ragbox.config.json");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        llm: {
          apiKey: "test-key"
        },
        sources: {
          docs: {
            rootDir: "./docs",
            outputDir: "./.ragbox-index/docs"
          },
          api: {
            rootDir: "./api-docs",
            outputDir: "./.ragbox-index/api"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [cliPath, "--config", configPath, "query", "--source", "docs,api", "How do I deploy?"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Missing question/);
  assert.doesNotMatch(result.stderr, /Source not found/);
  assert.match(result.stderr, /Expected a docs folder/);
});

test("query CLI --all-sources reads configured sources", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const configPath = path.join(tempDir, "ragbox.config.json");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        llm: {
          apiKey: "test-key"
        },
        sources: {
          docs: {
            rootDir: "./docs",
            outputDir: "./.ragbox-index/docs"
          },
          api: {
            rootDir: "./api-docs",
            outputDir: "./.ragbox-index/api"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [cliPath, "--config", configPath, "query", "--all-sources", "How do I deploy?"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Missing question/);
  assert.doesNotMatch(result.stderr, /No configured sources/);
  assert.match(result.stderr, /Expected a docs folder/);
});

test("query CLI defaults to all configured sources when multiple sources are configured", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const configPath = path.join(tempDir, "ragbox.config.json");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        llm: {
          apiKey: "test-key"
        },
        sources: {
          docs: {
            rootDir: "./docs",
            outputDir: "./.ragbox-index/docs"
          },
          api: {
            rootDir: "./api-docs",
            outputDir: "./.ragbox-index/api"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [cliPath, "--config", configPath, "query", "How do I deploy?"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Missing question/);
  assert.doesNotMatch(result.stderr, /Missing query target/);
  assert.match(result.stderr, /Expected a docs folder/);
});

test("status CLI prints index validation JSON", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const fixture = await writeValidIndexFixture(tempDir);
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  const result = spawnSync(process.execPath, [cliPath, "status", fixture.outputDir, "--json"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    command: string;
    ok: boolean;
    targets: Array<{ ok: boolean; inspect?: { counts: { ready: number } } }>;
  };
  assert.equal(output.command, "status");
  assert.equal(output.ok, true);
  assert.equal(output.targets[0]?.ok, true);
  assert.equal(output.targets[0]?.inspect?.counts.ready, 1);
});

test("trace query CLI reports the query failure stage", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  const result = spawnSync(process.execPath, [cliPath, "trace", "query", path.join(tempDir, "missing-index"), "What is indexed?"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stderr, /Query failed during resolve/);
});

test("serve exposes health, indexes, and optional bearer auth", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const fixture = await writeValidIndexFixture(tempDir);
  const handle = await ragbox.startServe({
    authToken: "secret-token",
    port: 0,
    target: fixture.outputDir
  });

  try {
    const health = await requestJson(`${handle.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((health.body as { ok: boolean }).ok, true);

    const unauthorized = await requestJson(`${handle.url}/indexes`);
    assert.equal(unauthorized.status, 401);

    const indexes = await requestJson(`${handle.url}/indexes`, {
      headers: {
        Authorization: "Bearer secret-token"
      }
    });
    assert.equal(indexes.status, 200);
    assert.equal((indexes.body as { indexes: Array<{ ok: boolean; counts?: { ready: number } }> }).indexes[0]?.ok, true);
    assert.equal((indexes.body as { indexes: Array<{ ok: boolean; counts?: { ready: number } }> }).indexes[0]?.counts?.ready, 1);
  } finally {
    await handle.close();
  }
});

test("serve query endpoint returns QueryResult and supports trace", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const fixture = await writeValidIndexFixture(tempDir);
  const responses = [
    JSON.stringify({ documents: [fixture.docId] }),
    JSON.stringify({ nodes: ["n1"] }),
    "Auth answer. Source: auth.md#n1"
  ];
  const originalFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: responses.shift()
            }
          }
        ]
      })
    } as Response;
  }) as typeof fetch;

  const handle = await ragbox.startServe({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    port: 0,
    target: fixture.outputDir
  });

  try {
    const response = await requestJson(`${handle.url}/query`, {
      method: "POST",
      body: {
        question: "How does auth work?",
        trace: true
      }
    });

    assert.equal(response.status, 200);
    const body = response.body as {
      answer: string;
      model: string;
      sources: Array<{ reference: string }>;
      trace?: { version: number };
    };
    assert.equal(body.model, "test-model");
    assert.match(body.answer, /Auth answer/);
    assert.deepEqual(body.sources.map((source) => source.reference), ["auth.md#n1"]);
    assert.equal(body.trace?.version, 1);
  } finally {
    await handle.close();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("serve query endpoint supports a custom LlmClient and trace", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const fixture = await writeValidIndexFixture(tempDir);
  const calls: LlmChatRequest[] = [];
  const llmClient = queuedLlmClient(
    [
      JSON.stringify({ documents: [fixture.docId] }),
      JSON.stringify({ nodes: ["n1"] }),
      "Serve custom answer. Source: auth.md#n1"
    ],
    calls
  );
  const originalFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("fetch should not be called when llmClient is provided");
  }) as typeof fetch;

  const handle = await ragbox.startServe({
    llmClient,
    model: "serve-custom-model",
    port: 0,
    target: fixture.outputDir
  });

  try {
    const response = await requestJson(`${handle.url}/query`, {
      method: "POST",
      body: {
        question: "How does auth work?",
        trace: true
      }
    });

    assert.equal(response.status, 200);
    const body = response.body as {
      answer: string;
      model: string;
      trace?: {
        version: number;
        documentSelection?: { rawResponse: string };
      };
    };
    assert.equal(body.model, "serve-custom-model");
    assert.equal(body.answer, "Serve custom answer. Source: auth.md#n1");
    assert.equal(body.trace?.version, 1);
    assert.equal(body.trace?.documentSelection?.rawResponse, JSON.stringify({ documents: [fixture.docId] }));
    assert.equal(calls.length, 3);
  } finally {
    await handle.close();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("serve query endpoint supports multi-source config and reload", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsFixture = await writeValidIndexFixture(path.join(tempDir, "docs-fixture"));
  const apiFixture = await writeValidIndexFixture(path.join(tempDir, "api-fixture"));
  const configPath = path.join(tempDir, "ragbox.config.json");
  const responses = [
    JSON.stringify({ documents: [docsFixture.docId] }),
    JSON.stringify({ nodes: ["n1"] }),
    "Docs answer",
    JSON.stringify({ documents: [apiFixture.docId] }),
    JSON.stringify({ nodes: ["n1"] }),
    "API answer",
    "Fused answer"
  ];
  const originalFetch = globalThis.fetch;

  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        llm: {
          apiKey: "config-key",
          baseUrl: "https://example.test/v1",
          model: "test-model"
        },
        sources: {
          docs: {
            rootDir: docsFixture.rootDir,
            outputDir: docsFixture.outputDir
          },
          api: {
            rootDir: apiFixture.rootDir,
            outputDir: apiFixture.outputDir
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: responses.shift()
            }
          }
        ]
      })
    } as Response;
  }) as typeof fetch;

  const handle = await ragbox.startServe({
    allSources: true,
    configPath,
    port: 0
  });

  try {
    const query = await requestJson(`${handle.url}/query`, {
      method: "POST",
      body: {
        allSources: true,
        question: "How do I deploy?"
      }
    });
    assert.equal(query.status, 200);
    assert.equal((query.body as { target: string; answer: string }).target, "multiple");
    assert.equal((query.body as { answer: string }).answer, "Fused answer");

    const reload = await requestJson(`${handle.url}/reload`, {
      method: "POST"
    });
    assert.equal(reload.status, 200);
    assert.deepEqual(
      (reload.body as { indexes: Array<{ source?: string }> }).indexes.map((index) => index.source),
      ["docs", "api"]
    );
  } finally {
    await handle.close();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("serve CLI help lists HTTP options", () => {
  const cliPath = path.resolve(__dirname, "../src/cli.js");
  const result = spawnSync(process.execPath, [cliPath, "serve", "--help"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stdout, /--host/);
  assert.match(result.stdout, /--port/);
  assert.match(result.stdout, /--auth-token/);
  assert.match(result.stdout, /--all-sources/);
});

test("custom output dir resolves manifest and document index paths", () => {
  const rootDir = path.join(os.tmpdir(), "ragbox-test", "docs");
  const outputDir = path.join(os.tmpdir(), "ragbox-test", ".ragbox-index");

  assert.equal(getPageIndexPath(rootDir, "manifest.json", outputDir), path.join(outputDir, "manifest.json"));
  assert.equal(resolveDocumentIndexPath(rootDir, "indexes/doc.json", outputDir), path.join(outputDir, "indexes", "doc.json"));
  assert.equal(
    resolveDocumentIndexPath(rootDir, ".pageindex/indexes/doc.json", outputDir),
    path.join(rootDir, ".pageindex", "indexes", "doc.json")
  );
});

test("resolveQueryIndexLocation accepts an output dir as the query target", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const rootDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const manifest: Manifest = {
    version: 1,
    rootDir,
    generatedAt: "2026-01-01T00:00:00.000Z",
    documents: []
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "root-tree.json"), `${JSON.stringify({ node_id: "root", type: "root", title: "docs" })}\n`, "utf8");

  const location = await resolveQueryIndexLocation(outputDir);

  assert.equal(location.rootDir, rootDir);
  assert.equal(location.outputDir, outputDir);
  assert.equal(location.manifestPath, path.join(outputDir, "manifest.json"));
  assert.equal(location.rootTreePath, path.join(outputDir, "root-tree.json"));
});

test("resolveQueryIndexLocation accepts a docs dir with a default .pageindex output dir", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const rootDir = path.join(tempDir, "docs");
  const outputDir = path.join(rootDir, ".pageindex");
  const manifest: Manifest = {
    version: 1,
    rootDir,
    generatedAt: "2026-01-01T00:00:00.000Z",
    documents: []
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "root-tree.json"), `${JSON.stringify({ node_id: "root", type: "root", title: "docs" })}\n`, "utf8");

  const location = await resolveQueryIndexLocation(rootDir);

  assert.equal(location.rootDir, rootDir);
  assert.equal(location.outputDir, outputDir);
  assert.equal(location.manifestPath, path.join(outputDir, "manifest.json"));
  assert.equal(location.rootTreePath, path.join(outputDir, "root-tree.json"));
});

test("resolveQueryIndexLocation rejects a folder without ragbox index files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));

  await assert.rejects(
    () => resolveQueryIndexLocation(tempDir),
    /Expected a docs folder/
  );
});

test("queryFolder returns answer, selections, sources, and timings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const rootDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const indexDir = path.join(outputDir, "indexes");
  const docId = "doc:auth";
  const indexPath = "indexes/auth.pageindex.json";
  const manifest: Manifest = {
    version: 1,
    rootDir,
    generatedAt: "2026-01-01T00:00:00.000Z",
    documents: [
      {
        docId,
        path: "auth.md",
        absolutePath: path.join(rootDir, "auth.md"),
        contentHash: "sha256:auth",
        size: 10,
        mtimeMs: 1,
        title: "Auth",
        summary: "Authentication guide",
        indexPath,
        status: "ready"
      }
    ]
  };
  const rootTree = {
    node_id: "root",
    type: "root",
    title: "docs",
    children: [
      {
        node_id: docId,
        type: "document",
        title: "Auth",
        summary: "Authentication guide",
        path: "auth.md",
        index_path: indexPath
      }
    ]
  };
  const pageIndex = {
    node_id: "root",
    title: "Auth",
    nodes: [
      {
        node_id: "n1",
        title: "PKCE",
        text: "PKCE reduces authorization code interception risk."
      }
    ]
  };
  const responses = [
    JSON.stringify({ documents: [docId] }),
    JSON.stringify({ nodes: ["n1"] }),
    "PKCE reduces authorization code interception risk. Source: auth.md#n1"
  ];
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  await fs.mkdir(indexDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "root-tree.json"), `${JSON.stringify(rootTree)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, indexPath), `${JSON.stringify(pageIndex)}\n`, "utf8");

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input, init) => {
    calls.push(String(init?.body ?? ""));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: responses.shift()
            }
          }
        ]
      })
    } as Response;
  }) as typeof fetch;

  try {
    const result = await queryFolder(outputDir, "What does PKCE reduce?", {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model"
    });

    assert.equal(result.version, 1);
    assert.equal(result.target, outputDir);
    assert.equal(result.rootDir, rootDir);
    assert.equal(result.outputDir, outputDir);
    assert.equal(result.model, "test-model");
    assert.match(result.answer, /PKCE reduces/);
    assert.deepEqual(result.selectedDocuments, [
      {
        docId,
        available: true,
        path: "auth.md",
        title: "Auth",
        status: "ready",
        indexPath,
        selectionReason: "selected_by_document_planner"
      }
    ]);
    assert.deepEqual(result.selectedNodes, [
      {
        docId,
        path: "auth.md",
        nodeId: "n1",
        found: true,
        hasText: true,
        reference: "auth.md#n1",
        selectionReason: "selected_by_node_planner",
        textBytes: Buffer.byteLength("PKCE reduces authorization code interception risk.", "utf8")
      }
    ]);
    assert.deepEqual(result.sources, [
      {
        path: "auth.md",
        nodeId: "n1",
        reference: "auth.md#n1",
        text: "PKCE reduces authorization code interception risk."
      }
    ]);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.contextBytes > 0);
    assert.ok(result.contextTokens > 0);
    assert.equal(result.trace, undefined);
    assert.equal(calls.length, 3);
    assert.ok(result.timingsMs.total >= result.timingsMs.answer);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("queryFolder trace exposes raw selections, context size, and answer diagnostics", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const fixture = await writeValidIndexFixture(tempDir);
  const documentSelectionResponse = JSON.stringify({ documents: [fixture.docId] });
  const nodeSelectionResponse = JSON.stringify({ nodes: ["n1"] });
  const responses = [
    documentSelectionResponse,
    nodeSelectionResponse,
    "Auth answer. Source: auth.md#n1"
  ];
  const originalFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: responses.shift()
            }
          }
        ]
      })
    } as Response;
  }) as typeof fetch;

  try {
    const result = await queryFolder(fixture.outputDir, "How does auth work?", {
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      trace: true
    });

    assert.equal(result.trace?.version, 1);
    assert.equal(result.trace.documentSelection?.rawResponse, documentSelectionResponse);
    assert.deepEqual(result.trace.documentSelection?.selectedDocumentIds, [fixture.docId]);
    assert.equal(result.trace.nodeSelections[0]?.rawResponse, nodeSelectionResponse);
    assert.deepEqual(result.trace.nodeSelections[0]?.selectedNodeIds, ["n1"]);
    assert.equal(result.trace.context.bytes, result.contextBytes);
    assert.equal(result.trace.context.tokens, result.contextTokens);
    assert.equal(result.trace.context.sourceCount, 1);
    assert.ok(result.trace.answer?.promptBytes);
    assert.ok(result.trace.answer?.responseBytes);
    assert.deepEqual(result.trace.failures, []);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("queryMultipleIndexes synthesizes answers and prefixes source references", async () => {
  const docsFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const apiFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsFixture = await writeValidIndexFixture(docsFixtureDir);
  const apiFixture = await writeValidIndexFixture(apiFixtureDir);
  const responses = [
    JSON.stringify({ documents: [docsFixture.docId] }),
    JSON.stringify({ nodes: ["n1"] }),
    "Docs answer",
    JSON.stringify({ documents: [apiFixture.docId] }),
    JSON.stringify({ nodes: ["n1"] }),
    "API answer",
    "Fused answer"
  ];
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_input, init) => {
    calls.push(String(init?.body ?? ""));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: responses.shift()
            }
          }
        ]
      })
    } as Response;
  }) as typeof fetch;

  try {
    const result = await queryMultipleIndexes(
      [
        { name: "docs", target: docsFixture.outputDir },
        { name: "api", target: apiFixture.outputDir }
      ],
      "How do I deploy?",
      {
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "test-model"
      }
    );

    assert.equal(result.version, 1);
    assert.equal(result.target, "multiple");
    assert.equal(result.answer, "Fused answer");
    assert.deepEqual(result.sourcesQueried, ["docs", "api"]);
    assert.deepEqual(
      result.sources.map((source) => source.reference),
      ["docs:auth.md#n1", "api:auth.md#n1"]
    );
    assert.deepEqual(
      result.results.map((sourceResult) => sourceResult.source),
      ["docs", "api"]
    );
    assert.equal(calls.length, 7);
    assert.match(calls[6], /Per-source draft answers/);
    assert.match(calls[6], /docs:auth\.md#n1/);
    assert.match(calls[6], /api:auth\.md#n1/);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("queryMultipleIndexes uses a custom LlmClient for source queries and final synthesis", async () => {
  const docsFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const apiFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsFixture = await writeValidIndexFixture(docsFixtureDir);
  const apiFixture = await writeValidIndexFixture(apiFixtureDir);
  const calls: LlmChatRequest[] = [];
  const llmClient = queuedLlmClient(
    [
      JSON.stringify({ documents: [docsFixture.docId] }),
      JSON.stringify({ nodes: ["n1"] }),
      "Docs answer",
      JSON.stringify({ documents: [apiFixture.docId] }),
      JSON.stringify({ nodes: ["n1"] }),
      "API answer",
      "Fused custom answer"
    ],
    calls
  );
  const originalFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("fetch should not be called when llmClient is provided");
  }) as typeof fetch;

  try {
    const result = await queryMultipleIndexes(
      [
        { name: "docs", target: docsFixture.outputDir },
        { name: "api", target: apiFixture.outputDir }
      ],
      "How do I deploy?",
      {
        llmClient,
        model: "custom-model"
      }
    );

    assert.equal(result.answer, "Fused custom answer");
    assert.deepEqual(result.sourcesQueried, ["docs", "api"]);
    assert.equal(calls.length, 7);
    assert.deepEqual(calls.map((call) => call.model), Array(7).fill("custom-model"));
    assert.match(calls[6]?.messages[0]?.content ?? "", /Per-source draft answers/);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("scanMarkdownFiles excludes a custom output dir inside the source root", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const rootDir = path.join(tempDir, "docs");
  const outputDir = path.join(rootDir, ".ragbox-index");

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(rootDir, "keep.md"), "# Keep\n", "utf8");
  await fs.writeFile(path.join(outputDir, "ignore.md"), "# Ignore\n", "utf8");

  const files = await scanMarkdownFiles(rootDir, { excludedDirs: [outputDir] });

  assert.deepEqual(
    files.map((file) => file.path),
    ["keep.md"]
  );
});

test("diffManifest detects added, modified, unchanged, deleted, and retry failed files", () => {
  const unchanged = scanned("same.md", "sha256:same");
  const modified = scanned("changed.md", "sha256:new");
  const retry = scanned("failed.md", "sha256:failed");
  const added = scanned("new.md", "sha256:new-file");
  const deleted = scanned("deleted.md", "sha256:old");

  const previous: Manifest = {
    version: 1,
    rootDir: "/repo/docs",
    generatedAt: "2026-01-01T00:00:00.000Z",
    documents: [
      { ...unchanged, status: "ready" },
      { ...modified, contentHash: "sha256:old", status: "ready" },
      { ...retry, status: "failed", error: "boom" },
      { ...deleted, status: "ready" }
    ]
  };

  const diff = diffManifest(previous, [unchanged, modified, retry, added]);

  assert.deepEqual(
    diff.added.map((file) => file.path),
    ["new.md"]
  );
  assert.deepEqual(
    diff.modified.map((file) => file.path),
    ["changed.md"]
  );
  assert.deepEqual(
    diff.retryFailed.map((file) => file.path),
    ["failed.md"]
  );
  assert.deepEqual(
    diff.unchanged.map((file) => file.path),
    ["same.md"]
  );
  assert.deepEqual(
    diff.deleted.map((file) => file.path),
    ["deleted.md"]
  );
});

test("generateRootTree creates directory and document nodes from manifest records", () => {
  const guide = scanned("guide/intro.md");
  const api = scanned("api.md");
  const manifest: Manifest = {
    version: 1,
    rootDir: "/repo/docs",
    generatedAt: "2026-01-01T00:00:00.000Z",
    documents: [
      { ...guide, title: "Intro", summary: "Guide intro", status: "ready" },
      { ...api, title: "API", status: "ready" },
      { ...scanned("draft.md"), status: "failed", error: "failed" }
    ]
  };

  const tree = generateRootTree(manifest);
  assert.equal(tree.type, "root");
  assert.equal(tree.children?.length, 2);

  const guideDir = tree.children?.find((node) => node.type === "directory" && node.title === "guide");
  assert.ok(guideDir);
  assert.equal(guideDir.children?.[0]?.type, "document");
  assert.equal(guideDir.children?.[0]?.title, "Intro");

  const apiDoc = tree.children?.find((node) => node.type === "document" && node.title === "API");
  assert.equal(apiDoc?.path, "api.md");
});

test("stripText removes text fields without mutating the original tree", () => {
  const tree = {
    node_id: "root",
    text: "root text",
    children: [{ node_id: "child", text: "child text", title: "Child" }]
  };

  const stripped = stripText(tree);

  assert.equal("text" in stripped, false);
  assert.equal("text" in stripped.children[0], false);
  assert.equal(tree.text, "root text");
  assert.equal(tree.children[0].text, "child text");
});

test("buildNodeMap indexes node_id, nodeId, and id fields recursively", () => {
  const tree = {
    node_id: "root",
    children: [
      { nodeId: "node-a", children: [] },
      { id: "node-b", nested: { node_id: "node-c" } }
    ]
  };

  const map = buildNodeMap(tree);

  assert.equal(map.get("root")?.node_id, "root");
  assert.equal(map.get("node-a")?.nodeId, "node-a");
  assert.equal(map.get("node-b")?.id, "node-b");
  assert.equal(map.get("node-c")?.node_id, "node-c");
});

test("extractNodeTextFromMarkdown falls back to line ranges when PageIndex has no text", () => {
  const tree = {
    structure: [
      {
        node_id: "0001",
        title: "Root",
        line_num: 1,
        nodes: [
          { node_id: "0002", title: "Token 请求示例", line_num: 5 },
          { node_id: "0003", title: "Next", line_num: 12 }
        ]
      }
    ]
  };
  const node = (tree.structure[0].nodes as Array<Record<string, unknown>>)[0];
  const markdown = `# Root

Intro

## Token 请求示例

code_verifier=ORIGINAL_RANDOM_VERIFIER

More token details.

## Next

Other text.
`;

  const text = extractNodeTextFromMarkdown(node, tree, markdown);

  assert.match(text ?? "", /ORIGINAL_RANDOM_VERIFIER/);
  assert.doesNotMatch(text ?? "", /Other text/);
});

test("runPageIndex resolves a relative cliPath before switching to a temp cwd", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const scriptPath = path.join(tempDir, "fake-pageindex.cjs");
  const inputPath = path.join(tempDir, "example.md");
  const outputPath = path.join(tempDir, "example.pageindex.json");
  const previousCwd = process.cwd();

  await fs.writeFile(inputPath, "# Relative CLI\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[args.indexOf("--if-add-node-text") + 1] !== "yes") {
  throw new Error("missing --if-add-node-text yes");
}
if (args[args.indexOf("--if-add-node-id") + 1] !== "yes") {
  throw new Error("missing --if-add-node-id yes");
}
const outputPath = args[args.indexOf("--output") + 1];
fs.writeFileSync(outputPath, JSON.stringify({ node_id: "root", summary: "ok", text: "Body" }));
`,
    "utf8"
  );

  try {
    process.chdir(tempDir);
    await runPageIndex(inputPath, outputPath, {
      pythonPath: process.execPath,
      cliPath: "./fake-pageindex.cjs",
      outputArg: "--output",
      model: "test-model"
    });
  } finally {
    process.chdir(previousCwd);
  }

  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), {
    node_id: "root",
    summary: "ok",
    text: "Body"
  });
});
