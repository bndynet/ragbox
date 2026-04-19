import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writePageIndexSetupConfig } from "./config-file";
import { PAGEINDEX_PACKAGE_SPEC, SUPPORTED_PAGEINDEX_VERSION } from "./pageindex-version";

const MAX_CAPTURED_OUTPUT = 32 * 1024;
const DEFAULT_PAGEINDEX_VENV_DIR = ".ragbox/pageindex-venv";
const DEFAULT_PAGEINDEX_SETUP_LOCK = ".ragbox/pageindex-setup.lock";
const DEFAULT_PYTHON = "python3";
const GITIGNORE_ENTRY = ".ragbox/";
const SETUP_LOCK_POLL_MS = 100;
const SETUP_LOCK_STALE_MS = 10 * 60 * 1000;
const SETUP_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export type ManagedPageIndexSetupEvent = {
  status: "installing" | "ready" | "waiting";
  pythonPath: string;
  version: string;
};

export type EnsureManagedPageIndexOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (event: ManagedPageIndexSetupEvent) => void;
  python?: string;
};

export type EnsureManagedPageIndexResult = {
  createdVenv: boolean;
  installedPackage: boolean;
  pythonPath: string;
  venvDir: string;
};

export type SetupPageIndexOptions = {
  configPath?: string;
  cwd?: string;
  gitignore?: boolean;
  python?: string;
  writeConfig?: boolean;
};

export type SetupPageIndexResult = {
  version: 1;
  command: "setup pageindex";
  package: string;
  packageVersion: string;
  pythonPath: string;
  venvDir: string;
  configPath?: string;
  gitignorePath?: string;
  actions: {
    createdVenv: boolean;
    installedPackage: boolean;
    updatedGitignore: boolean;
    wroteConfig: boolean;
  };
};

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  failureMessage: string;
  missingMessage: string;
};

function appendCapturedOutput(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_CAPTURED_OUTPUT ? next.slice(-MAX_CAPTURED_OUTPUT) : next;
}

function commandFailure(message: string, stdout: string, stderr: string): Error {
  const details = [
    stdout.trim() ? `STDOUT:\n${stdout.trim()}` : undefined,
    stderr.trim() ? `STDERR:\n${stderr.trim()}` : undefined
  ].filter(Boolean);
  return new Error(details.length ? `${message}\n${details.join("\n")}` : message);
}

async function runCommand(command: string, args: string[], options: RunCommandOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapturedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapturedOutput(stderr, chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new Error(options.missingMessage) : error);
    });
    child.on("close", (code) => {
      code === 0
        ? resolve()
        : reject(commandFailure(`${options.failureMessage} (exit code ${code ?? "unknown"})`, stdout, stderr));
    });
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function venvPythonPath(venvDir: string): string {
  return process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
}

export function managedPageIndexPythonPath(cwd = process.cwd()): string {
  return venvPythonPath(path.resolve(cwd, DEFAULT_PAGEINDEX_VENV_DIR));
}

function reportManagedSetupProgress(options: EnsureManagedPageIndexOptions, event: ManagedPageIndexSetupEvent): void {
  try {
    options.onProgress?.(event);
  } catch {
    // Progress reporting must not change setup behavior.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function installedPageIndexVersion(pythonPath: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return await new Promise((resolve) => {
    let stdout = "";
    const child = spawn(
      pythonPath,
      ["-c", "import importlib.metadata; print(importlib.metadata.version('pageindex'))"],
      { env, stdio: ["ignore", "pipe", "ignore"] }
    );
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapturedOutput(stdout, chunk);
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 && stdout.trim() ? stdout.trim() : undefined));
  });
}

async function setupLockOwnerAlive(lockPath: string): Promise<boolean | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) {
      return undefined;
    }
    try {
      process.kill(value.pid as number, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : true;
    }
  } catch {
    return undefined;
  }
}

async function acquireSetupLock(
  lockPath: string,
  options: EnsureManagedPageIndexOptions,
  pythonPath: string
): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  let waitingReported = false;

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    if (!waitingReported) {
      waitingReported = true;
      reportManagedSetupProgress(options, {
        status: "waiting",
        pythonPath,
        version: SUPPORTED_PAGEINDEX_VERSION
      });
    }

    try {
      const stat = await fs.stat(lockPath);
      const ownerAlive = await setupLockOwnerAlive(lockPath);
      if (ownerAlive === false || (ownerAlive === undefined && Date.now() - stat.mtimeMs > SETUP_LOCK_STALE_MS)) {
        await fs.unlink(lockPath);
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    if (Date.now() - startedAt > SETUP_LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for PageIndex setup lock: ${lockPath}`);
    }
    await delay(SETUP_LOCK_POLL_MS);
  }
}

async function ensureGitignoreEntry(cwd: string): Promise<{ gitignorePath: string; updated: boolean }> {
  const gitignorePath = path.join(cwd, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(GITIGNORE_ENTRY)) {
    return { gitignorePath, updated: false };
  }
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(gitignorePath, `${current}${separator}${GITIGNORE_ENTRY}\n`, "utf8");
  return { gitignorePath, updated: true };
}

async function installPageIndex(
  venvDir: string,
  python: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ createdVenv: boolean; pythonPath: string }> {
  const createdVenv = !(await pathExists(venvPythonPath(venvDir)));
  await fs.mkdir(path.dirname(venvDir), { recursive: true });
  if (createdVenv) {
    await runCommand(python, ["-m", "venv", venvDir], {
      env,
      failureMessage: `Failed to create PageIndex virtual environment at ${venvDir}`,
      missingMessage: `Python executable was not found: ${python}`
    });
  }

  const pythonPath = venvPythonPath(venvDir);
  await runCommand(pythonPath, ["-m", "pip", "install", PAGEINDEX_PACKAGE_SPEC], {
    env,
    failureMessage: `Failed to install ${PAGEINDEX_PACKAGE_SPEC}`,
    missingMessage: `Virtual environment Python was not found after creation: ${pythonPath}`
  });
  await runCommand(
    pythonPath,
    [
      "-c",
      `import importlib.metadata; assert importlib.metadata.version("pageindex") == ${JSON.stringify(SUPPORTED_PAGEINDEX_VERSION)}`
    ],
    {
      env,
      failureMessage: `Installed PageIndex did not match ${SUPPORTED_PAGEINDEX_VERSION}`,
      missingMessage: `Virtual environment Python was not found after installation: ${pythonPath}`
    }
  );
  return { createdVenv, pythonPath };
}

export async function ensureManagedPageIndex(
  options: EnsureManagedPageIndexOptions = {}
): Promise<EnsureManagedPageIndexResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const venvDir = path.resolve(cwd, DEFAULT_PAGEINDEX_VENV_DIR);
  const pythonPath = managedPageIndexPythonPath(cwd);
  const currentVersion = await installedPageIndexVersion(pythonPath, env);
  if (currentVersion === SUPPORTED_PAGEINDEX_VERSION) {
    return { createdVenv: false, installedPackage: false, pythonPath, venvDir };
  }

  await fs.mkdir(path.dirname(venvDir), { recursive: true });
  if ((await pathExists(path.join(cwd, ".git"))) || (await pathExists(path.join(cwd, ".gitignore")))) {
    await ensureGitignoreEntry(cwd);
  }
  const lockPath = path.resolve(cwd, DEFAULT_PAGEINDEX_SETUP_LOCK);
  const releaseLock = await acquireSetupLock(lockPath, options, pythonPath);
  try {
    const versionAfterLock = await installedPageIndexVersion(pythonPath, env);
    if (versionAfterLock === SUPPORTED_PAGEINDEX_VERSION) {
      return { createdVenv: false, installedPackage: false, pythonPath, venvDir };
    }

    reportManagedSetupProgress(options, {
      status: "installing",
      pythonPath,
      version: SUPPORTED_PAGEINDEX_VERSION
    });
    const installed = await installPageIndex(venvDir, options.python ?? DEFAULT_PYTHON, env);
    reportManagedSetupProgress(options, {
      status: "ready",
      pythonPath: installed.pythonPath,
      version: SUPPORTED_PAGEINDEX_VERSION
    });
    return {
      ...installed,
      installedPackage: true,
      venvDir
    };
  } finally {
    await releaseLock();
  }
}

export async function setupPageIndex(options: SetupPageIndexOptions = {}): Promise<SetupPageIndexResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const venvDir = path.resolve(cwd, DEFAULT_PAGEINDEX_VENV_DIR);
  await fs.mkdir(path.dirname(venvDir), { recursive: true });
  const releaseLock = await acquireSetupLock(path.resolve(cwd, DEFAULT_PAGEINDEX_SETUP_LOCK), {}, venvPythonPath(venvDir));
  let installed: Awaited<ReturnType<typeof installPageIndex>>;
  try {
    installed = await installPageIndex(venvDir, options.python ?? DEFAULT_PYTHON);
  } finally {
    await releaseLock();
  }
  const configPath = options.writeConfig === false
    ? undefined
    : await writePageIndexSetupConfig({ configPath: options.configPath, cwd, pythonPath: installed.pythonPath });
  const gitignore = options.gitignore === false ? undefined : await ensureGitignoreEntry(cwd);

  return {
    version: 1,
    command: "setup pageindex",
    package: "pageindex",
    packageVersion: SUPPORTED_PAGEINDEX_VERSION,
    pythonPath: installed.pythonPath,
    venvDir,
    configPath,
    gitignorePath: gitignore?.gitignorePath,
    actions: {
      createdVenv: installed.createdVenv,
      installedPackage: true,
      updatedGitignore: gitignore?.updated ?? false,
      wroteConfig: Boolean(configPath)
    }
  };
}
