import path from "node:path";

export function toPosixPath(inputPath: string): string {
  return inputPath.replace(/\\/g, "/");
}

export function normalizeRelativePath(inputPath: string, rootDir?: string): string {
  const relativePath = rootDir ? path.relative(rootDir, inputPath) : inputPath;
  return toPosixPath(relativePath)
    .replace(/^\.\//, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
}

export function normalizeAbsolutePath(inputPath: string): string {
  return toPosixPath(path.resolve(inputPath));
}

export function isSubPath(parentDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function isStrictSubPath(parentDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDir, candidatePath);
  return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
