import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writePageIndexSetupConfig } from "./config-file";

const MAX_CAPTURED_OUTPUT = 32 * 1024;
const DEFAULT_PAGEINDEX_REPO = "https://github.com/VectifyAI/PageIndex.git";
const DEFAULT_PAGEINDEX_DIR = ".ragbox/PageIndex";
const DEFAULT_PAGEINDEX_VENV_DIR = ".ragbox/pageindex-venv";
const DEFAULT_PYTHON = "python3";
const GITIGNORE_ENTRY = ".ragbox/";

export type SetupPageIndexOptions = {
  configPath?: string;
  cwd?: string;
  dir?: string;
  gitignore?: boolean;
  install?: boolean;
  python?: string;
  ref?: string;
  repo?: string;
  writeConfig?: boolean;
};

export type SetupPageIndexResult = {
  version: 1;
  command: "setup pageindex";
  pageIndexDir: string;
  cliPath: string;
  pythonPath?: string;
  venvDir?: string;
  configPath?: string;
  gitignorePath?: string;
  actions: {
    checkedOutRef?: string;
    cloned: boolean;
    installedDependencies: boolean;
    reusedExisting: boolean;
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
      env: {
        ...process.env,
        ...options.env
      },
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
      if (code === 0) {
        resolve();
        return;
      }
      reject(commandFailure(`${options.failureMessage} (exit code ${code ?? "unknown"})`, stdout, stderr));
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

async function hasPageIndexEntrypoint(pageIndexDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(pageIndexDir, "run_pageindex.py"));
    return stat.isFile();
  } catch {
    return false;
  }
}

function venvPythonPath(venvDir: string): string {
  return process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");
}

async function ensureGitignoreEntry(cwd: string): Promise<{ gitignorePath: string; updated: boolean }> {
  const gitignorePath = path.join(cwd, ".gitignore");
  let current = "";

  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
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

async function ensurePageIndexSource(pageIndexDir: string, repo: string, ref: string | undefined, env?: NodeJS.ProcessEnv): Promise<{
  checkedOutRef?: string;
  cloned: boolean;
  reusedExisting: boolean;
}> {
  if (await pathExists(pageIndexDir)) {
    if (!(await hasPageIndexEntrypoint(pageIndexDir))) {
      throw new Error(
        `PageIndex directory already exists but run_pageindex.py was not found: ${pageIndexDir}. Pass --dir to use another location or remove the existing directory.`
      );
    }
    return { cloned: false, reusedExisting: true };
  }

  await fs.mkdir(path.dirname(pageIndexDir), { recursive: true });
  await runCommand("git", ["clone", repo, pageIndexDir], {
    env,
    failureMessage: `Failed to clone PageIndex from ${repo}`,
    missingMessage: "git is required to install PageIndex. Install git or pass --dir pointing to an existing PageIndex checkout."
  });

  if (ref) {
    await runCommand("git", ["-C", pageIndexDir, "checkout", ref], {
      env,
      failureMessage: `Failed to checkout PageIndex ref ${ref}`,
      missingMessage: "git is required to checkout a PageIndex ref."
    });
  }

  if (!(await hasPageIndexEntrypoint(pageIndexDir))) {
    throw new Error(`PageIndex repo does not contain run_pageindex.py: ${pageIndexDir}`);
  }

  return { checkedOutRef: ref, cloned: true, reusedExisting: false };
}

async function installPageIndexDependencies(pageIndexDir: string, venvDir: string, python: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const requirementsPath = path.join(pageIndexDir, "requirements.txt");
  if (!(await pathExists(requirementsPath))) {
    throw new Error(`PageIndex requirements.txt was not found: ${requirementsPath}`);
  }

  await fs.mkdir(path.dirname(venvDir), { recursive: true });
  await runCommand(python, ["-m", "venv", venvDir], {
    env,
    failureMessage: `Failed to create PageIndex virtual environment at ${venvDir}`,
    missingMessage: `Python executable was not found: ${python}`
  });

  const pythonPath = venvPythonPath(venvDir);
  await runCommand(pythonPath, ["-m", "pip", "install", "--upgrade", "-r", requirementsPath], {
    env,
    failureMessage: "Failed to install PageIndex Python dependencies",
    missingMessage: `Virtual environment Python was not found after creation: ${pythonPath}`
  });

  return pythonPath;
}

export async function setupPageIndex(options: SetupPageIndexOptions = {}): Promise<SetupPageIndexResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const repo = options.repo ?? DEFAULT_PAGEINDEX_REPO;
  const pageIndexDir = path.resolve(cwd, options.dir ?? DEFAULT_PAGEINDEX_DIR);
  const venvDir = path.resolve(cwd, DEFAULT_PAGEINDEX_VENV_DIR);
  const install = options.install ?? true;
  const writeConfig = options.writeConfig ?? true;
  const updateGitignore = options.gitignore ?? true;
  const source = await ensurePageIndexSource(pageIndexDir, repo, options.ref);
  const cliPath = path.join(pageIndexDir, "run_pageindex.py");
  let pythonPath: string | undefined;

  if (install) {
    pythonPath = await installPageIndexDependencies(pageIndexDir, venvDir, options.python ?? DEFAULT_PYTHON);
  }

  const configPath = writeConfig
    ? await writePageIndexSetupConfig({
        cliPath,
        configPath: options.configPath,
        cwd,
        pythonPath
      })
    : undefined;
  const gitignore = updateGitignore ? await ensureGitignoreEntry(cwd) : undefined;

  return {
    version: 1,
    command: "setup pageindex",
    pageIndexDir,
    cliPath,
    pythonPath,
    venvDir: install ? venvDir : undefined,
    configPath,
    gitignorePath: gitignore?.gitignorePath,
    actions: {
      checkedOutRef: source.checkedOutRef,
      cloned: source.cloned,
      installedDependencies: install,
      reusedExisting: source.reusedExisting,
      updatedGitignore: gitignore?.updated ?? false,
      wroteConfig: Boolean(configPath)
    }
  };
}

