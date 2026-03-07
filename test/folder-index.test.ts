import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadPageIndexConfig } from "../src/folder-index/config";
import { hashFile } from "../src/folder-index/hash";
import { chatCompletionsUrl } from "../src/folder-index/llm-client";
import { diffManifest, getPageIndexPath, resolveDocumentIndexPath } from "../src/folder-index/manifest";
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
        PAGEINDEX_OUTPUT_ARG: "--output",
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
        PAGEINDEX_CLI: scriptPath,
        PAGEINDEX_OUTPUT_ARG: "--output"
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
  assert.equal(output.rootDir, docsDir);
  assert.equal(output.outputDir, outputDir);
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
        indexPath
      }
    ]);
    assert.deepEqual(result.selectedNodes, [
      {
        docId,
        path: "auth.md",
        nodeId: "n1",
        found: true,
        hasText: true,
        reference: "auth.md#n1"
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
    assert.equal(calls.length, 3);
    assert.ok(result.timingsMs.total >= result.timingsMs.answer);
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
