import fs from "node:fs/promises";
import path from "node:path";
import { PageIndexOptions } from "./folder-index/types";

export const RAGBOX_CONFIG_FILE = "ragbox.config.json";

export type RagboxPageIndexConfig = {
  cli?: string;
  concurrency?: number;
  extraArgs?: string[];
  outputArg?: string;
  python?: string;
};

export type RagboxLlmConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export type RagboxIndexConfig = {
  exclude?: string[];
  include?: string[];
  outputDir?: string;
};

export type RagboxConfigSource = RagboxIndexConfig & {
  index?: RagboxIndexConfig;
  llm?: RagboxLlmConfig;
  pageIndex?: RagboxPageIndexConfig;
  rootDir: string;
};

export type RagboxConfig = {
  version: 1;
  docs?: RagboxConfigSource;
  index?: RagboxIndexConfig;
  llm?: RagboxLlmConfig;
  pageIndex?: RagboxPageIndexConfig;
  sources?: Record<string, RagboxConfigSource>;
};

export type ResolvedRagboxConfig = {
  config?: RagboxConfig;
  configDir: string;
  configPath?: string;
  pageIndexOptions: PageIndexOptions;
  rootDir?: string;
  sourceName?: string;
};

export type ResolveRagboxConfigOptions = {
  configPath?: string;
  cwd?: string;
  source?: string;
};

export type WriteDefaultRagboxConfigOptions = {
  configPath?: string;
  cwd?: string;
  docsDir?: string;
  force?: boolean;
  outputDir?: string;
};

export type WritePageIndexSetupConfigOptions = {
  cliPath: string;
  configPath?: string;
  cwd?: string;
  pythonPath?: string;
};

const DEFAULT_INCLUDE = ["**/*.md", "**/*.mdx"];
const DEFAULT_EXCLUDE = ["node_modules/**", ".git/**", ".pageindex/**", "dist/**", "build/**"];
const DEFAULT_API_KEY_PLACEHOLDER = "YOUR_OPENAI_API_KEY";
const API_KEY_PLACEHOLDERS = new Set([DEFAULT_API_KEY_PLACEHOLDER, "sk-..."]);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function configFileName(name: string | undefined): string {
  return name ? `ragbox.config.${name}.json` : RAGBOX_CONFIG_FILE;
}

function looksLikeConfigName(value: string): boolean {
  return !value.endsWith(".json") && !value.includes("/") && !value.includes("\\");
}

async function findConfigPath(cwd: string, name?: string): Promise<string | undefined> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const candidate = path.join(currentDir, configFileName(name));
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return undefined;
    }
    currentDir = parent;
  }
}

async function resolveConfigPath(configPath: string | undefined, cwd: string): Promise<string | undefined> {
  if (!configPath) {
    return undefined;
  }
  if (looksLikeConfigName(configPath)) {
    return (await findConfigPath(cwd, configPath)) ?? path.resolve(cwd, configFileName(configPath));
  }
  return path.resolve(cwd, configPath);
}

function resolveConfigRelativePath(configDir: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function resolveConfigCommandPath(configDir: string, value: string | undefined): string | undefined {
  if (!value || path.isAbsolute(value)) {
    return value;
  }
  if (value.startsWith(".") || value.includes("/") || value.includes("\\")) {
    return path.resolve(configDir, value);
  }
  return value;
}

function normalizeConfigRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function toConfigRelativeCommandPath(configDir: string, cwd: string, value: string): string {
  const absolutePath = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const relativePath = normalizeConfigRelativePath(path.relative(configDir, absolutePath));
  if (!relativePath || relativePath.startsWith("..")) {
    return normalizeConfigRelativePath(absolutePath);
  }
  return relativePath.startsWith("./") ? relativePath : `./${relativePath}`;
}

function mergePageIndexConfig(...configs: Array<RagboxPageIndexConfig | undefined>): RagboxPageIndexConfig {
  return Object.assign({}, ...configs.filter(Boolean));
}

function mergeLlmConfig(...configs: Array<RagboxLlmConfig | undefined>): RagboxLlmConfig {
  return Object.assign({}, ...configs.filter(Boolean));
}

function mergeIndexConfig(...configs: Array<RagboxIndexConfig | undefined>): RagboxIndexConfig {
  return Object.assign({}, ...configs.filter(Boolean));
}

function pageIndexConfigToOptions(
  configDir: string,
  config: RagboxPageIndexConfig
): Pick<PageIndexOptions, "cliPath" | "concurrency" | "extraArgs" | "outputArg" | "pythonPath"> {
  return {
    cliPath: resolveConfigCommandPath(configDir, config.cli),
    concurrency: config.concurrency,
    extraArgs: config.extraArgs,
    outputArg: config.outputArg,
    pythonPath: resolveConfigCommandPath(configDir, config.python)
  };
}

function llmConfigToOptions(config: RagboxLlmConfig): Pick<PageIndexOptions, "apiKey" | "baseUrl" | "model"> {
  const apiKey = config.apiKey?.trim();

  return {
    apiKey: apiKey && !API_KEY_PLACEHOLDERS.has(apiKey) ? config.apiKey : undefined,
    baseUrl: config.baseUrl,
    model: config.model
  };
}

function indexConfigToOptions(configDir: string, config: RagboxIndexConfig): Pick<PageIndexOptions, "exclude" | "include" | "outputDir"> {
  return {
    exclude: config.exclude,
    include: config.include,
    outputDir: resolveConfigRelativePath(configDir, config.outputDir)
  };
}

export function createDefaultRagboxConfig(options: Pick<WriteDefaultRagboxConfigOptions, "docsDir" | "outputDir"> = {}): RagboxConfig {
  const docsDir = options.docsDir ?? "./docs";
  const outputDir = options.outputDir ?? "./.ragbox-index";

  return {
    version: 1,
    pageIndex: {
      cli: "/path/to/PageIndex/run_pageindex.py"
    },
    llm: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: DEFAULT_API_KEY_PLACEHOLDER
    },
    docs: {
      rootDir: docsDir,
      outputDir
    }
  };
}

function inferSourceName(config: RagboxConfig | undefined, requestedSource: string | undefined): string | undefined {
  if (requestedSource) {
    return requestedSource;
  }

  if (config?.docs) {
    return "docs";
  }

  const sourceNames = Object.keys(config?.sources ?? {});
  return sourceNames.length === 1 ? sourceNames[0] : undefined;
}

function findSource(config: RagboxConfig | undefined, sourceName: string | undefined): RagboxConfigSource | undefined {
  if (!sourceName) {
    return undefined;
  }
  if (sourceName === "docs" && config?.docs) {
    return config.docs;
  }
  return config?.sources?.[sourceName];
}

export function listRagboxConfigSourceNames(config: RagboxConfig | undefined): string[] {
  if (!config) {
    return [];
  }

  const names = new Set<string>();
  if (config.docs) {
    names.add("docs");
  }
  for (const sourceName of Object.keys(config.sources ?? {})) {
    names.add(sourceName);
  }
  return [...names];
}

export async function writeDefaultRagboxConfig(options: WriteDefaultRagboxConfigOptions = {}): Promise<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, options.configPath ?? RAGBOX_CONFIG_FILE);

  if (!options.force && (await pathExists(configPath))) {
    throw new Error(`Config file already exists: ${configPath}`);
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(createDefaultRagboxConfig({ docsDir: options.docsDir, outputDir: options.outputDir }), null, 2)}\n`,
    "utf8"
  );
  return configPath;
}

export async function writePageIndexSetupConfig(options: WritePageIndexSetupConfigOptions): Promise<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = (await resolveConfigPath(options.configPath, cwd)) ?? (await findConfigPath(cwd)) ?? path.resolve(cwd, RAGBOX_CONFIG_FILE);
  const configDir = path.dirname(configPath);
  let config = createDefaultRagboxConfig();

  if (await pathExists(configPath)) {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as RagboxConfig;
    if (config.version !== 1) {
      throw new Error(`Unsupported ragbox config version in ${configPath}: ${String(config.version)}`);
    }
  }

  const pageIndex: RagboxPageIndexConfig = {
    ...(config.pageIndex ?? {}),
    cli: toConfigRelativeCommandPath(configDir, cwd, options.cliPath)
  };
  if (options.pythonPath) {
    pageIndex.python = toConfigRelativeCommandPath(configDir, cwd, options.pythonPath);
  } else {
    delete pageIndex.python;
  }

  config.pageIndex = pageIndex;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export async function readRagboxConfig(configPath?: string, cwd = process.cwd()): Promise<{ config?: RagboxConfig; configPath?: string; configDir: string }> {
  const resolvedConfigPath = (await resolveConfigPath(configPath, cwd)) ?? (await findConfigPath(cwd));

  if (!resolvedConfigPath) {
    return {
      configDir: path.resolve(cwd)
    };
  }

  const config = JSON.parse(await fs.readFile(resolvedConfigPath, "utf8")) as RagboxConfig;
  if (config.version !== 1) {
    throw new Error(`Unsupported ragbox config version in ${resolvedConfigPath}: ${String(config.version)}`);
  }

  return {
    config,
    configDir: path.dirname(resolvedConfigPath),
    configPath: resolvedConfigPath
  };
}

export async function resolveRagboxConfig(options: ResolveRagboxConfigOptions = {}): Promise<ResolvedRagboxConfig> {
  const cwd = options.cwd ?? process.cwd();
  const { config, configDir, configPath } = await readRagboxConfig(options.configPath, cwd);
  const sourceName = inferSourceName(config, options.source);
  const source = findSource(config, sourceName);

  if (options.source && !source) {
    throw new Error(`Source not found in ragbox config: ${options.source}`);
  }

  const pageIndexConfig = mergePageIndexConfig(config?.pageIndex, source?.pageIndex);
  const llmConfig = mergeLlmConfig(config?.llm, source?.llm);
  const indexConfig = mergeIndexConfig(
    config?.index,
    source
      ? {
          exclude: source.exclude,
          include: source.include,
          outputDir: source.outputDir
        }
      : undefined,
    source?.index
  );

  return {
    config,
    configDir,
    configPath,
    pageIndexOptions: {
      ...pageIndexConfigToOptions(configDir, pageIndexConfig),
      ...llmConfigToOptions(llmConfig),
      ...indexConfigToOptions(configDir, indexConfig)
    },
    rootDir: resolveConfigRelativePath(configDir, source?.rootDir),
    sourceName
  };
}
