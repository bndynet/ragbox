import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writePageIndexSetupConfig } from "./config-file";
import { PAGEINDEX_PACKAGE_SPEC, SUPPORTED_PAGEINDEX_VERSION } from "./pageindex-version";

const MAX_CAPTURED_OUTPUT = 32 * 1024;
const DEFAULT_PAGEINDEX_VENV_DIR = ".ragbox/pageindex-venv";
const DEFAULT_PYTHON = "python3";
const GITIGNORE_ENTRY = ".ragbox/";

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
      env: process.env,
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

async function installPageIndex(venvDir: string, python: string): Promise<{ createdVenv: boolean; pythonPath: string }> {
  const createdVenv = !(await pathExists(venvPythonPath(venvDir)));
  await fs.mkdir(path.dirname(venvDir), { recursive: true });
  if (createdVenv) {
    await runCommand(python, ["-m", "venv", venvDir], {
      failureMessage: `Failed to create PageIndex virtual environment at ${venvDir}`,
      missingMessage: `Python executable was not found: ${python}`
    });
  }

  const pythonPath = venvPythonPath(venvDir);
  await runCommand(pythonPath, ["-m", "pip", "install", PAGEINDEX_PACKAGE_SPEC], {
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
      failureMessage: `Installed PageIndex did not match ${SUPPORTED_PAGEINDEX_VERSION}`,
      missingMessage: `Virtual environment Python was not found after installation: ${pythonPath}`
    }
  );
  return { createdVenv, pythonPath };
}

export async function setupPageIndex(options: SetupPageIndexOptions = {}): Promise<SetupPageIndexResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const venvDir = path.resolve(cwd, DEFAULT_PAGEINDEX_VENV_DIR);
  const installed = await installPageIndex(venvDir, options.python ?? DEFAULT_PYTHON);
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
