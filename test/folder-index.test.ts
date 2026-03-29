import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as ragbox from "../src/index";
import type { LlmChatRequest, LlmClient } from "../src/index";
import { resolveRagboxConfig } from "../src/config-file";
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
const path = require("node:path");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex === -1 ? undefined : args[outputIndex + 1];
if (!outputPath) {
  fs.mkdirSync("results", { recursive: true });
}
fs.writeFileSync(outputPath ?? path.join("results", "example_structure.json"), JSON.stringify({
  node_id: "root",
  summary: ${JSON.stringify(summary)},
  nodes: [{ node_id: "n1", title: "Body", text: "Body text" }]
}));
`,
    "utf8"
  );
}

async function writeFakePageIndexPackage(baseDir: string): Promise<{ cliPath: string; importLog: string }> {
  const packageDir = path.join(baseDir, "pageindex");
  const importLog = path.join(baseDir, "pageindex-import.log");
  const cliPath = path.join(baseDir, "run_pageindex.py");

  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, "__init__.py"), "", "utf8");
  await fs.writeFile(
    path.join(packageDir, "utils.py"),
    `class _Options:
    pass

class ConfigLoader:
    def load(self, user_opt):
        opt = _Options()
        opt.model = user_opt.get("model") or "fake-model"
        opt.if_add_node_summary = user_opt.get("if_add_node_summary")
        opt.if_add_doc_description = user_opt.get("if_add_doc_description")
        opt.if_add_node_text = user_opt.get("if_add_node_text")
        opt.if_add_node_id = user_opt.get("if_add_node_id")
        return opt
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(packageDir, "page_index_md.py"),
    `import os

with open(os.environ["FAKE_PAGEINDEX_IMPORT_LOG"], "a", encoding="utf-8") as f:
    f.write("import\\n")

async def md_to_tree(md_path, if_thinning=False, min_token_threshold=5000, if_add_node_summary=None, summary_token_threshold=200, model=None, if_add_doc_description=None, if_add_node_text=None, if_add_node_id=None):
    with open(md_path, encoding="utf-8") as f:
        text = f.read()
    return {
        "node_id": "root",
        "summary": "summary:" + os.path.basename(md_path),
        "nodes": [{"node_id": "n1", "text": text}],
        "options": {
            "if_thinning": if_thinning,
            "min_token_threshold": min_token_threshold,
            "summary_token_threshold": summary_token_threshold,
            "model": model,
            "if_add_node_text": if_add_node_text,
            "if_add_node_id": if_add_node_id,
        },
    }
`,
    "utf8"
  );
  await fs.writeFile(cliPath, "# fake PageIndex checkout root\n", "utf8");
  return { cliPath, importLog };
}

async function writePythonSinglePageIndexScript(scriptPath: string, logPath: string): Promise<void> {
  await fs.writeFile(
    scriptPath,
    `import json
import os
import sys

args = sys.argv[1:]
with open(${JSON.stringify(logPath)}, "a", encoding="utf-8") as f:
    f.write("single\\n")
md_path = args[args.index("--md_path") + 1]
output_path = None
if "--output" in args:
    output_path = args[args.index("--output") + 1]
with open(md_path, encoding="utf-8") as f:
    text = f.read()
tree = {"node_id": "root", "summary": "single:" + os.path.basename(md_path), "nodes": [{"node_id": "n1", "text": text}]}
if output_path is None:
    os.makedirs("results", exist_ok=True)
    name = os.path.splitext(os.path.basename(md_path))[0]
    output_path = os.path.join("results", name + "_structure.json")
os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(tree, f)
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

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function writeFakeSetupTools(binDir: string): Promise<{ gitLog: string; pythonLog: string }> {
  await fs.mkdir(binDir, { recursive: true });
  const gitLog = path.join(binDir, "git.log");
  const pythonLog = path.join(binDir, "python.log");

  await writeExecutable(
    path.join(binDir, "git"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "clone") {
  const target = args[2];
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "run_pageindex.py"), "# fake pageindex\\n");
  fs.writeFileSync(path.join(target, "requirements.txt"), "fake==1\\n");
  process.exit(0);
}
if (args[0] === "-C" && args[2] === "checkout") {
  process.exit(0);
}
process.exit(1);
`
  );

  await writeExecutable(
    path.join(binDir, "python3"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PYTHON_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "-m" && args[1] === "venv") {
  const venvDir = args[2];
  const binDir = path.join(venvDir, "bin");
  const pythonPath = path.join(binDir, "python");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    pythonPath,
    "#!/usr/bin/env node\\nconst fs = require(\\"node:fs\\");\\nfs.appendFileSync(process.env.FAKE_PYTHON_LOG, JSON.stringify(process.argv.slice(2)) + \\"\\\\n\\");\\n"
  );
  fs.chmodSync(pythonPath, 0o755);
  process.exit(0);
}
process.exit(0);
`
  );

  return { gitLog, pythonLog };
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

function waitForProcessOutput(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 5000): Promise<RegExpMatchArray> {
  let output = "";

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const match = output.match(pattern);
      if (match) {
        cleanup();
        resolve(match);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Process exited before matching ${pattern}: code=${String(code)} signal=${String(signal)}\n${output}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}\n${output}`));
    }, timeoutMs);

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function runProcess(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";

  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
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
      PAGEINDEX_OUTPUT_ARG: "--out",
      PAGEINDEX_EXTRA_ARGS: "--if-add-node-text yes --if-add-node-id yes"
    }
  });

  assert.equal(config.outputArg, "--out");
  assert.deepEqual(config.extraArgs, ["--if-add-node-text", "yes", "--if-add-node-id", "yes"]);
});

test("loadPageIndexConfig reads PageIndex runner mode from the environment", () => {
  assert.equal(loadPageIndexConfig({ env: { PAGEINDEX_RUNNER: "batch" } }).pageIndexRunner, "batch");
  assert.equal(loadPageIndexConfig({ env: {} }).pageIndexRunner, "auto");
});

test("loadPageIndexConfig defaults to native PageIndex results output", () => {
  const config = loadPageIndexConfig({ env: {} });

  assert.equal(config.outputArg, undefined);
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

test("createIndex reindexes stale document index artifacts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "results-pageindex.cjs");
  const oldTime = new Date("2020-01-01T00:00:00.000Z");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nFresh marker\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const path = require("node:path");
const inputPath = process.argv[process.argv.indexOf("--md_path") + 1];
const text = fs.readFileSync(inputPath, "utf8");
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync(path.join("results", "guide_structure.json"), JSON.stringify({ node_id: "root", summary: "fresh", text }));
`,
    "utf8"
  );

  const first = await ragbox.createIndex(docsDir, {
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexPython: process.execPath
  });
  const indexPath = path.join(outputDir, first.manifest.documents[0].indexPath);
  await fs.writeFile(indexPath, JSON.stringify({ node_id: "root", text: "stale marker" }), "utf8");
  await fs.utimes(indexPath, oldTime, oldTime);

  const second = await ragbox.createIndex(docsDir, {
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexPython: process.execPath
  });

  assert.equal(second.counts.modified, 1);
  assert.equal(second.counts.unchanged, 0);
  const output = JSON.parse(await fs.readFile(indexPath, "utf8")) as { text: string };
  assert.match(output.text, /Fresh marker/);
  assert.doesNotMatch(output.text, /stale marker/);
});

test("createIndex uses warm PageIndex batch workers", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const { cliPath, importLog } = await writeFakePageIndexPackage(tempDir);
  const progress: string[] = [];

  await fs.mkdir(docsDir, { recursive: true });
  for (let index = 1; index <= 5; index += 1) {
    await fs.writeFile(path.join(docsDir, `guide-${index}.md`), `# Guide ${index}\n\nBody ${index}\n`, "utf8");
  }

  const result = await ragbox.createIndex(docsDir, {
    concurrency: 2,
    env: {
      ...process.env,
      FAKE_PAGEINDEX_IMPORT_LOG: importLog
    },
    outputDir,
    pageIndexCli: cliPath,
    pageIndexPython: "python3",
    pageIndexRunner: "batch",
    onProgress: (event) => {
      progress.push(event.type);
    }
  });

  assert.equal(result.counts.ready, 5);
  assert.equal(result.counts.failed, 0);
  assert.equal((await fs.readFile(importLog, "utf8")).trim().split(/\r?\n/).length, 2);
  assert.equal(progress.filter((event) => event === "index-start").length, 5);
  assert.equal(progress.filter((event) => event === "index-done").length, 5);
  for (const document of result.manifest.documents) {
    const output = JSON.parse(await fs.readFile(path.join(outputDir, document.indexPath), "utf8")) as { summary: string };
    assert.match(output.summary, /^summary:guide-\d\.md$/);
  }
});

test("createIndex auto runner falls back to single runner when PageIndex import fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "run_pageindex.py");
  const logPath = path.join(tempDir, "single.log");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "one.md"), "# One\n", "utf8");
  await fs.writeFile(path.join(docsDir, "two.md"), "# Two\n", "utf8");
  await writePythonSinglePageIndexScript(scriptPath, logPath);

  const result = await ragbox.createIndex(docsDir, {
    concurrency: 2,
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexOutputArg: "--output",
    pageIndexPython: "python3",
    pageIndexRunner: "auto"
  });

  assert.equal(result.counts.ready, 2);
  assert.equal(result.counts.failed, 0);
  assert.equal((await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/).length, 2);
});

test("createIndex batch runner reports failures when PageIndex import fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "run_pageindex.py");
  const logPath = path.join(tempDir, "single.log");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "one.md"), "# One\n", "utf8");
  await fs.writeFile(path.join(docsDir, "two.md"), "# Two\n", "utf8");
  await writePythonSinglePageIndexScript(scriptPath, logPath);

  const result = await ragbox.createIndex(docsDir, {
    concurrency: 2,
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexOutputArg: "--output",
    pageIndexPython: "python3",
    pageIndexRunner: "batch"
  });

  assert.equal(result.counts.ready, 0);
  assert.equal(result.counts.failed, 2);
  assert.equal(await pathExists(logPath), false);
  assert.match(result.manifest.documents[0].error ?? "", /No module named 'pageindex'|ModuleNotFoundError/);
});

test("createIndex auto runner falls back for unsupported batch extra args", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "run_pageindex.py");
  const logPath = path.join(tempDir, "single.log");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "one.md"), "# One\n", "utf8");
  await fs.writeFile(path.join(docsDir, "two.md"), "# Two\n", "utf8");
  await writePythonSinglePageIndexScript(scriptPath, logPath);

  const result = await ragbox.createIndex(docsDir, {
    concurrency: 2,
    outputDir,
    pageIndexCli: scriptPath,
    pageIndexExtraArgs: ["--unsupported-pageindex-flag", "value"],
    pageIndexOutputArg: "--output",
    pageIndexPython: "python3",
    pageIndexRunner: "auto"
  });

  assert.equal(result.counts.ready, 2);
  assert.equal(result.counts.failed, 0);
  assert.equal((await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/).length, 2);
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
const path = require("node:path");
const attemptPath = ${JSON.stringify(attemptPath)};
const attempts = fs.existsSync(attemptPath) ? Number(fs.readFileSync(attemptPath, "utf8")) : 0;
fs.writeFileSync(attemptPath, String(attempts + 1));
if (attempts === 0) {
  process.stderr.write("transient failure");
  process.exit(1);
}
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex === -1 ? undefined : args[outputIndex + 1];
if (!outputPath) {
  fs.mkdirSync("results", { recursive: true });
}
fs.writeFileSync(outputPath ?? path.join("results", "example_structure.json"), JSON.stringify({
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
const path = require("node:path");
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
  fs.mkdirSync("results", { recursive: true });
}
fs.writeFileSync(outputPath ?? path.join("results", "example_structure.json"), JSON.stringify({ node_id: "root", summary: "cli ok", text: "Body" }));
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
  assert.match(result.stderr, /\[ragbox\] indexing /);
  assert.match(result.stderr, /\[ragbox\] scan complete /);
  assert.match(result.stderr, /\[ragbox\] indexed 1\/1 guide\.md/);
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
const path = require("node:path");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex === -1 ? undefined : args[outputIndex + 1];
if (!outputPath) {
  fs.mkdirSync("results", { recursive: true });
}
fs.writeFileSync(outputPath ?? path.join("results", "example_structure.json"), JSON.stringify({ node_id: "root", summary: "contract ok", text: "Body" }));
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
    failures: unknown[];
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
  assert.deepEqual(output.failures, []);
});

test("index CLI prints failed document errors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "failing-pageindex.cjs");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `process.stdout.write("pageindex stdout detail\\n");
process.stderr.write("pageindex stderr detail\\n");
process.exit(3);
`,
    "utf8"
  );

  const result = spawnSync(
    process.execPath,
    [cliPath, "index", docsDir, "--output-dir", outputDir, "--pageindex-python", process.execPath],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PAGEINDEX_CLI: scriptPath
      }
    }
  );

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stdout, /failed=1/);
  assert.match(result.stderr, /Failed documents:/);
  assert.match(result.stderr, /guide\.md/);
  assert.match(result.stderr, /PageIndex failed with exit code 3/);
  assert.match(result.stderr, /pageindex stdout detail/);
  assert.match(result.stderr, /pageindex stderr detail/);
});

test("index CLI --json includes failed document errors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "failing-pageindex.cjs");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await fs.writeFile(scriptPath, `process.stderr.write("json failure detail\\n"); process.exit(2);\n`, "utf8");

  const result = spawnSync(
    process.execPath,
    [cliPath, "index", docsDir, "--output-dir", outputDir, "--pageindex-python", process.execPath, "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PAGEINDEX_CLI: scriptPath
      }
    }
  );

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.equal(result.stderr, "");

  const output = JSON.parse(result.stdout) as {
    counts: { failed: number };
    failures: Array<{ path: string; absolutePath: string; indexPath: string; error?: string }>;
  };

  assert.equal(output.counts.failed, 1);
  assert.equal(output.failures.length, 1);
  assert.equal(output.failures[0]?.path, "guide.md");
  assert.equal(output.failures[0]?.absolutePath, path.join(docsDir, "guide.md"));
  assert.match(output.failures[0]?.error ?? "", /json failure detail/);
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
    llm: { apiKey: string; baseUrl: string; model: string };
    pageIndex: { cli: string; concurrency: number; runner: string };
  };

  assert.equal(config.version, 1);
  assert.equal(config.pageIndex.cli, "/path/to/PageIndex/run_pageindex.py");
  assert.equal(config.pageIndex.concurrency, 1);
  assert.equal(config.pageIndex.runner, "auto");
  assert.equal(config.llm.baseUrl, "https://api.openai.com/v1");
  assert.equal(config.llm.model, "gpt-4o-mini");
  assert.equal(config.llm.apiKey, "YOUR_OPENAI_API_KEY");
  assert.equal(config.docs.rootDir, "./content");
  assert.equal(config.docs.outputDir, "./.idx");

  const resolved = await resolveRagboxConfig({ configPath });
  const runtimeConfig = loadPageIndexConfig({
    ...resolved.pageIndexOptions,
    env: {
      OPENAI_API_KEY: "env-key"
    }
  });
  assert.equal(resolved.pageIndexOptions.apiKey, undefined);
  assert.equal(runtimeConfig.apiKey, "env-key");
});

test("setup pageindex clones, installs dependencies, updates config, and updates gitignore", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const realTempDir = await fs.realpath(tempDir);
  const binDir = path.join(tempDir, "bin");
  const { gitLog, pythonLog } = await writeFakeSetupTools(binDir);
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  const result = spawnSync(process.execPath, [cliPath, "setup", "pageindex", "--ref", "test-ref", "--json"], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GIT_LOG: gitLog,
      FAKE_PYTHON_LOG: pythonLog,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    actions: {
      checkedOutRef?: string;
      cloned: boolean;
      installedDependencies: boolean;
      reusedExisting: boolean;
      updatedGitignore: boolean;
      wroteConfig: boolean;
    };
    cliPath: string;
    command: string;
    configPath: string;
    pythonPath: string;
  };

  assert.equal(output.command, "setup pageindex");
  assert.equal(output.actions.cloned, true);
  assert.equal(output.actions.reusedExisting, false);
  assert.equal(output.actions.checkedOutRef, "test-ref");
  assert.equal(output.actions.installedDependencies, true);
  assert.equal(output.actions.wroteConfig, true);
  assert.equal(output.actions.updatedGitignore, true);
  assert.equal(output.cliPath, path.join(realTempDir, ".ragbox", "PageIndex", "run_pageindex.py"));
  assert.equal(output.pythonPath, path.join(realTempDir, ".ragbox", "pageindex-venv", "bin", "python"));

  const config = JSON.parse(await fs.readFile(path.join(tempDir, "ragbox.config.json"), "utf8")) as {
    pageIndex: { cli: string; python: string };
  };
  assert.equal(config.pageIndex.cli, "./.ragbox/PageIndex/run_pageindex.py");
  assert.equal(config.pageIndex.python, "./.ragbox/pageindex-venv/bin/python");
  assert.match(await fs.readFile(path.join(tempDir, ".gitignore"), "utf8"), /^\.ragbox\/$/m);

  const gitCalls = (await fs.readFile(gitLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(gitCalls[0], ["clone", "https://github.com/VectifyAI/PageIndex.git", path.join(realTempDir, ".ragbox", "PageIndex")]);
  assert.deepEqual(gitCalls[1], ["-C", path.join(realTempDir, ".ragbox", "PageIndex"), "checkout", "test-ref"]);

  const pythonCalls = (await fs.readFile(pythonLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(pythonCalls[0], ["-m", "venv", path.join(realTempDir, ".ragbox", "pageindex-venv")]);
  assert.deepEqual(pythonCalls[1], [
    "-m",
    "pip",
    "install",
    "--upgrade",
    "-r",
    path.join(realTempDir, ".ragbox", "PageIndex", "requirements.txt")
  ]);

  const doctor = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd: tempDir,
    encoding: "utf8"
  });
  assert.equal(doctor.status, 0, `STDOUT:\n${doctor.stdout}\nSTDERR:\n${doctor.stderr}`);
  const doctorOutput = JSON.parse(doctor.stdout) as {
    checks: Array<{ name: string; ok: boolean; path?: string }>;
  };
  const pageIndexCheck = doctorOutput.checks.find((check) => check.name === "pageindex-cli");
  assert.equal(pageIndexCheck?.ok, true);
  assert.equal(pageIndexCheck?.path, output.cliPath);
});

test("setup pageindex reuses an existing checkout and skip-install writes only the cli config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const pageIndexDir = path.join(tempDir, ".ragbox", "PageIndex");
  const configPath = path.join(tempDir, "ragbox.config.json");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(pageIndexDir, { recursive: true });
  await fs.writeFile(path.join(pageIndexDir, "run_pageindex.py"), "# existing pageindex\n", "utf8");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        pageIndex: {
          concurrency: 2,
          python: "./old-python"
        },
        llm: {
          baseUrl: "https://example.test/v1",
          model: "example-model"
        },
        docs: {
          rootDir: "./content",
          outputDir: "./.idx"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = spawnSync(process.execPath, [cliPath, "setup", "pageindex", "--skip-install", "--json"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    actions: { cloned: boolean; installedDependencies: boolean; reusedExisting: boolean };
    pythonPath?: string;
    venvDir?: string;
  };
  assert.equal(output.actions.cloned, false);
  assert.equal(output.actions.reusedExisting, true);
  assert.equal(output.actions.installedDependencies, false);
  assert.equal(output.pythonPath, undefined);
  assert.equal(output.venvDir, undefined);
  assert.equal(await pathExists(path.join(tempDir, ".ragbox", "pageindex-venv")), false);

  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    docs: { outputDir: string; rootDir: string };
    llm: { baseUrl: string; model: string };
    pageIndex: { cli: string; concurrency: number; python?: string };
  };
  assert.equal(config.pageIndex.cli, "./.ragbox/PageIndex/run_pageindex.py");
  assert.equal(config.pageIndex.concurrency, 2);
  assert.equal(config.pageIndex.python, undefined);
  assert.equal(config.llm.baseUrl, "https://example.test/v1");
  assert.equal(config.llm.model, "example-model");
  assert.equal(config.docs.rootDir, "./content");
  assert.equal(config.docs.outputDir, "./.idx");
});

test("setup pageindex fails for an invalid existing install directory without deleting it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const pageIndexDir = path.join(tempDir, ".ragbox", "PageIndex");
  const markerPath = path.join(pageIndexDir, "README.md");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(pageIndexDir, { recursive: true });
  await fs.writeFile(markerPath, "not pageindex\n", "utf8");

  const result = spawnSync(process.execPath, [cliPath, "setup", "pageindex", "--skip-install", "--json"], {
    cwd: tempDir,
    encoding: "utf8"
  });

  assert.equal(result.status, 1, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stderr, /run_pageindex\.py was not found/);
  assert.equal(await fs.readFile(markerPath, "utf8"), "not pageindex\n");
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
const path = require("node:path");
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
  fs.mkdirSync("results", { recursive: true });
}
fs.writeFileSync(outputPath ?? path.join("results", "example_structure.json"), JSON.stringify({ node_id: "root", summary: "configured ok", text: "Body" }));
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
    encoding: "utf8",
    env: {
      ...process.env,
      RAGBOX_SERVE_HOST: "127.0.0.1",
      RAGBOX_SERVE_PORT: "1"
    }
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  const output = JSON.parse(result.stdout) as {
    command: string;
    ok: boolean;
    serve?: {
      ok: boolean;
      reachable: boolean;
    };
    targets: Array<{ ok: boolean; inspect?: { counts: { ready: number } } }>;
  };
  assert.equal(output.command, "status");
  assert.equal(output.ok, false);
  assert.equal(output.targets[0]?.ok, true);
  assert.equal(output.targets[0]?.inspect?.counts.ready, 1);
  assert.equal(output.serve?.ok, false);
  assert.equal(output.serve?.reachable, false);
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
    const root = await requestJson(`${handle.url}/`);
    assert.equal(root.status, 200);
    assert.equal((root.body as { name: string; ok: boolean }).name, "ragbox");
    assert.equal((root.body as { name: string; ok: boolean }).ok, true);
    assert.equal(
      (root.body as { endpoints: Array<{ path: string; authRequired: boolean }> }).endpoints.find((endpoint) => endpoint.path === "/query")
        ?.authRequired,
      true
    );

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

test("status CLI can probe a running serve health endpoint", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const fixture = await writeValidIndexFixture(tempDir);
  const cliPath = path.resolve(__dirname, "../src/cli.js");
  const handle = await ragbox.startServe({
    port: 0,
    target: fixture.outputDir
  });

  try {
    const result = await runProcess(
      process.execPath,
      [
        cliPath,
        "status",
        fixture.outputDir,
        "--json"
      ],
      {
        env: {
          ...process.env,
          RAGBOX_SERVE_HOST: handle.host,
          RAGBOX_SERVE_PORT: String(handle.port)
        }
      }
    );

    assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      serve?: {
        ok: boolean;
        reachable: boolean;
        statusCode?: number;
        health?: {
          status: string;
          indexes: {
            ready: number;
            total: number;
          };
        };
      };
    };
    assert.equal(output.ok, true);
    assert.equal(output.serve?.ok, true);
    assert.equal(output.serve?.reachable, true);
    assert.equal(output.serve?.statusCode, 200);
    assert.equal(output.serve?.health?.status, "ready");
    assert.equal(output.serve?.health?.indexes.ready, 1);
    assert.equal(output.serve?.health?.indexes.total, 1);
  } finally {
    await handle.close();
  }
});

test("serve reports index_not_ready for missing query indexes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const target = path.join(tempDir, ".ragbox-index");
  const handle = await ragbox.startServe({
    port: 0,
    target
  });

  try {
    const health = await requestJson(`${handle.url}/health`);
    assert.equal(health.status, 503);
    assert.equal((health.body as { ok: boolean; status: string }).ok, false);
    assert.equal((health.body as { ok: boolean; status: string }).status, "error");

    const query = await requestJson(`${handle.url}/query`, {
      method: "POST",
      body: {
        question: "Is anything ready?"
      }
    });
    assert.equal(query.status, 503);
    assert.equal((query.body as { error: { code: string } }).error.code, "index_not_ready");
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

test("serve query endpoint maps LLM fetch failures to upstream errors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const fixture = await writeValidIndexFixture(tempDir);
  const originalFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const handle = await ragbox.startServe({
    apiKey: "test-key",
    baseUrl: "http://localhost:9000/api/chat/completions",
    model: "test-model",
    port: 0,
    target: fixture.outputDir
  });

  try {
    const response = await requestJson(`${handle.url}/query`, {
      method: "POST",
      body: {
        question: "How does auth work?"
      }
    });

    assert.equal(response.status, 502);
    assert.equal((response.body as { error: { code: string } }).error.code, "upstream_error");
    assert.match((response.body as { error: { message: string } }).error.message, /Query failed during select-documents: fetch failed/);
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

test("start CLI help lists watch and serve options", () => {
  const cliPath = path.resolve(__dirname, "../src/cli.js");
  const result = spawnSync(process.execPath, [cliPath, "start", "--help"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stdout, /--host/);
  assert.match(result.stdout, /--port/);
  assert.match(result.stdout, /--auth-token/);
  assert.match(result.stdout, /--jsonl/);
  assert.match(result.stdout, /--staging/);
  assert.match(result.stdout, /--all-sources/);
});

test("start CLI serves health while the initial index is still running", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const docsDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const scriptPath = path.join(tempDir, "slow-pageindex.cjs");
  const releasePath = path.join(tempDir, "release-index");
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.writeFile(path.join(docsDir, "guide.md"), "# Guide\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const outputPath = outputIndex === -1 ? undefined : args[outputIndex + 1];
while (!fs.existsSync(${JSON.stringify(releasePath)})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
if (!outputPath) {
  fs.mkdirSync("results", { recursive: true });
}
fs.writeFileSync(outputPath ?? path.join("results", "example_structure.json"), JSON.stringify({
  node_id: "root",
  summary: "slow ok",
  nodes: [{ node_id: "n1", title: "Body", text: "Body text" }]
}));
`,
    "utf8"
  );

  const child = spawn(
    process.execPath,
    [
      cliPath,
      "start",
      docsDir,
      "--output-dir",
      outputDir,
      "--pageindex-cli",
      scriptPath,
      "--pageindex-python",
      process.execPath,
      "--host",
      "127.0.0.1",
      "--port",
      "0"
    ],
    {
      cwd: tempDir
    }
  );

  try {
    const serving = await waitForProcessOutput(child, /Serving ragbox at (http:\/\/127\.0\.0\.1:\d+)/);
    const url = serving[1];
    assert.equal(await pathExists(path.join(outputDir, "manifest.json")), false);

    const indexingHealth = await requestJson(`${url}/health`);
    assert.equal(indexingHealth.status, 503);
    assert.equal((indexingHealth.body as { ok: boolean; status: string }).ok, false);

    await fs.writeFile(releasePath, "go", "utf8");
    await waitForProcessOutput(child, /Reloaded serve index snapshot \(1\/1 ready\)/);

    const readyHealth = await requestJson(`${url}/health`);
    assert.equal(readyHealth.status, 200);
    assert.equal((readyHealth.body as { ok: boolean; status: string }).status, "ready");
  } finally {
    await fs.writeFile(releasePath, "go", "utf8").catch(() => undefined);
    await stopChildProcess(child);
  }
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
    assert.match(calls[2], /available documentation/);
    assert.doesNotMatch(calls[2].toLowerCase(), /indexed documents/);
    assert.ok(result.timingsMs.total >= result.timingsMs.answer);
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }
});

test("queryFolder adds exact text node matches when the planner selects a parent node", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const rootDir = path.join(tempDir, "docs");
  const outputDir = path.join(tempDir, ".ragbox-index");
  const indexDir = path.join(outputDir, "indexes");
  const docId = "doc:watch";
  const indexPath = "indexes/watch.pageindex.json";
  const calls: LlmChatRequest[] = [];
  const llmClient = queuedLlmClient(
    [
      JSON.stringify({ documents: [docId] }),
      JSON.stringify({ nodes: ["0000"] }),
      "The updated verification phrase is RAGBOX_START_WATCH_VERIFICATION_V2. Source: watch.md#0001"
    ],
    calls
  );
  const manifest: Manifest = {
    version: 1,
    rootDir,
    generatedAt: "2026-01-01T00:00:00.000Z",
    documents: [
      {
        docId,
        path: "watch.md",
        absolutePath: path.join(rootDir, "watch.md"),
        contentHash: "sha256:watch",
        size: 10,
        mtimeMs: 1,
        title: "Watch",
        summary: "Watch verification",
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
        title: "Watch",
        summary: "Watch verification",
        path: "watch.md",
        index_path: indexPath
      }
    ]
  };
  const pageIndex = {
    structure: [
      {
        node_id: "0000",
        title: "Start Watch Verification",
        text: "This document verifies the start loop.",
        nodes: [
          {
            node_id: "0001",
            title: "Verification Phrase",
            text: "The updated verification phrase is RAGBOX_START_WATCH_VERIFICATION_V2."
          }
        ]
      }
    ]
  };

  await fs.mkdir(indexDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, "root-tree.json"), `${JSON.stringify(rootTree)}\n`, "utf8");
  await fs.writeFile(path.join(outputDir, indexPath), `${JSON.stringify(pageIndex)}\n`, "utf8");

  const result = await queryFolder(outputDir, "RAGBOX_START_WATCH_VERIFICATION_V2 是什么？", {
    llmClient,
    model: "test-model"
  });

  assert.deepEqual(result.selectedNodes.map((node) => [node.nodeId, node.selectionReason]), [
    ["0000", "selected_by_node_planner"],
    ["0001", "matched_query_text"]
  ]);
  assert.deepEqual(result.sources.map((source) => source.reference), ["watch.md#0000", "watch.md#0001"]);
  assert.match(calls[2]?.messages[0]?.content ?? "", /RAGBOX_START_WATCH_VERIFICATION_V2/);
  assert.match(result.answer, /RAGBOX_START_WATCH_VERIFICATION_V2/);
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
    assert.match(calls[6], /available documentation/);
    assert.doesNotMatch(calls[6].toLowerCase(), /indexed documents/);
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

test("runPageIndex falls back when PageIndex rejects the output arg", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const scriptPath = path.join(tempDir, "results-pageindex.cjs");
  const inputPath = path.join(tempDir, "example.md");
  const secondInputPath = path.join(tempDir, "second.md");
  const outputPath = path.join(tempDir, "example.pageindex.json");
  const secondOutputPath = path.join(tempDir, "second.pageindex.json");
  const callsPath = path.join(tempDir, "calls.log");

  await fs.writeFile(inputPath, "# Results\n\nBody\n", "utf8");
  await fs.writeFile(secondInputPath, "# Cached\n\nBody\n", "utf8");
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const callsPath = ${JSON.stringify(callsPath)};
if (args.includes("--output")) {
  fs.appendFileSync(callsPath, "with-output\\n");
  process.stderr.write("run_pageindex.py: error: unrecognized arguments: --output " + args[args.indexOf("--output") + 1] + "\\n");
  process.exit(2);
}
fs.appendFileSync(callsPath, "results\\n");
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync(path.join("results", "example_structure.json"), JSON.stringify({ node_id: "root", summary: "fallback ok", text: "Body" }));
`,
    "utf8"
  );

  await runPageIndex(inputPath, outputPath, {
    pythonPath: process.execPath,
    cliPath: scriptPath,
    outputArg: "--output",
    model: "test-model"
  });

  await runPageIndex(secondInputPath, secondOutputPath, {
    pythonPath: process.execPath,
    cliPath: scriptPath,
    outputArg: "--output",
    model: "test-model"
  });

  assert.deepEqual(JSON.parse(await fs.readFile(outputPath, "utf8")), {
    node_id: "root",
    summary: "fallback ok",
    text: "Body"
  });
  assert.deepEqual(JSON.parse(await fs.readFile(secondOutputPath, "utf8")), {
    node_id: "root",
    summary: "fallback ok",
    text: "Body"
  });
  assert.equal(await fs.readFile(callsPath, "utf8"), "with-output\nresults\nresults\n");
});

test("runPageIndex results mode overwrites stale existing output", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ragbox-test-"));
  const scriptPath = path.join(tempDir, "results-pageindex.cjs");
  const inputPath = path.join(tempDir, "example.md");
  const outputPath = path.join(tempDir, "example.pageindex.json");
  const oldTime = new Date("2020-01-01T00:00:00.000Z");

  await fs.writeFile(inputPath, "# Updated\n\nRAGBOX_START_WATCH_VERIFICATION_V2\n", "utf8");
  await fs.writeFile(outputPath, JSON.stringify({ node_id: "root", text: "stale output" }), "utf8");
  await fs.utimes(outputPath, oldTime, oldTime);
  await fs.writeFile(
    scriptPath,
    `const fs = require("node:fs");
const path = require("node:path");
const inputPath = process.argv[process.argv.indexOf("--md_path") + 1];
const text = fs.readFileSync(inputPath, "utf8");
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync(path.join("results", "example_structure.json"), JSON.stringify({ node_id: "root", text }));
`,
    "utf8"
  );

  await runPageIndex(inputPath, outputPath, {
    pythonPath: process.execPath,
    cliPath: scriptPath,
    model: "test-model"
  });

  const output = JSON.parse(await fs.readFile(outputPath, "utf8")) as { text: string };
  assert.match(output.text, /RAGBOX_START_WATCH_VERIFICATION_V2/);
  assert.doesNotMatch(output.text, /stale output/);
});
