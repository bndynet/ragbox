import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import { hashFile } from "./hash";
import { INDEXES_DIR } from "./manifest";
import { isSubPath, normalizeAbsolutePath, normalizeRelativePath } from "./path-utils";
import { ScannedFile } from "./types";

const DEFAULT_EXCLUDED_DIRS = new Set(["node_modules", ".git", ".pageindex", "dist", "build"]);

type ScanMarkdownFilesOptions = {
  excludedDirs?: string[];
  exclude?: string[];
  include?: string[];
};

export function isMarkdownDocument(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".mdx";
}

export function createDocId(relativePath: string): string {
  const normalizedPath = normalizeRelativePath(relativePath);
  const digest = createHash("sha1").update(normalizedPath).digest("hex");
  return `doc:${digest}`;
}

export function docIdToIndexFileName(docId: string): string {
  return `${docId.replace(/[^a-zA-Z0-9_-]/g, "_")}.pageindex.json`;
}

export function createIndexPath(docId: string): string {
  return [INDEXES_DIR, docIdToIndexFileName(docId)].join("/");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalizedPattern = normalizeRelativePath(pattern).replace(/^\/+/, "");
  let regex = "^";
  let index = 0;

  while (index < normalizedPattern.length) {
    const char = normalizedPattern[index];
    const next = normalizedPattern[index + 1];
    const afterNext = normalizedPattern[index + 2];

    if (char === "*" && next === "*" && afterNext === "/") {
      regex += "(?:.*/)?";
      index += 3;
      continue;
    }

    if (char === "*" && next === "*") {
      regex += ".*";
      index += 2;
      continue;
    }

    if (char === "*") {
      regex += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      index += 1;
      continue;
    }

    regex += escapeRegex(char);
    index += 1;
  }

  return new RegExp(`${regex}$`);
}

function matchesPattern(relativePath: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) {
    return false;
  }

  const normalizedPath = normalizeRelativePath(relativePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalizedPath));
}

export function isIncludedPath(relativePath: string, options: Pick<ScanMarkdownFilesOptions, "exclude" | "include"> = {}): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const includePatterns = options.include?.length ? options.include : undefined;

  if (includePatterns && !matchesPattern(normalizedPath, includePatterns)) {
    return false;
  }

  return !matchesPattern(normalizedPath, options.exclude);
}

export async function deriveMarkdownTitle(filePath: string): Promise<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of reader) {
      const match = /^#\s+(.+?)\s*#*\s*$/.exec(line.trim());
      if (match?.[1]) {
        return match[1].trim();
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return path.basename(filePath, path.extname(filePath));
}

export async function scanMarkdownFiles(rootDir: string, options: ScanMarkdownFilesOptions = {}): Promise<ScannedFile[]> {
  const absoluteRoot = path.resolve(rootDir);
  const excludedDirs = (options.excludedDirs ?? []).map((dir) => path.resolve(dir));
  const files: ScannedFile[] = [];

  function isExcludedDirectory(entryName: string, absolutePath: string): boolean {
    const relativePath = normalizeRelativePath(absolutePath, absoluteRoot);
    return (
      DEFAULT_EXCLUDED_DIRS.has(entryName) ||
      excludedDirs.some((excludedDir) => isSubPath(excludedDir, absolutePath)) ||
      matchesPattern(relativePath, options.exclude) ||
      matchesPattern(`${relativePath}/`, options.exclude)
    );
  }

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!isExcludedDirectory(entry.name, absolutePath)) {
          await walk(absolutePath);
        }
        continue;
      }

      if (!entry.isFile() || !isMarkdownDocument(entry.name)) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      const relativePath = normalizeRelativePath(absolutePath, absoluteRoot);
      if (!isIncludedPath(relativePath, options)) {
        continue;
      }
      const docId = createDocId(relativePath);

      files.push({
        docId,
        path: relativePath,
        absolutePath: normalizeAbsolutePath(absolutePath),
        contentHash: await hashFile(absolutePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        title: await deriveMarkdownTitle(absolutePath),
        indexPath: createIndexPath(docId)
      });
    }
  }

  await walk(absoluteRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
