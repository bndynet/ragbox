import { PageIndexOptions } from "./types";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseExtraArgs(value: string | undefined): string[] | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.split(/\s+/) : undefined;
}

export function loadPageIndexConfig(overrides: PageIndexOptions = {}): Required<Pick<PageIndexOptions, "pythonPath" | "model" | "baseUrl" | "concurrency">> &
  PageIndexOptions {
  const env = overrides.env ?? process.env;

  return {
    pythonPath: overrides.pythonPath ?? env.PAGEINDEX_PYTHON ?? "python3",
    cliPath: overrides.cliPath ?? env.PAGEINDEX_CLI,
    model: overrides.model ?? env.PAGEINDEX_MODEL ?? env.LLM_MODEL ?? "gpt-4o-mini",
    baseUrl: overrides.baseUrl ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: overrides.apiKey ?? env.OPENAI_API_KEY,
    concurrency: overrides.concurrency ?? parsePositiveInt(env.PAGEINDEX_CONCURRENCY, 1),
    outputDir: overrides.outputDir ?? env.RAGBOX_OUTPUT_DIR,
    outputArg: overrides.outputArg ?? env.PAGEINDEX_OUTPUT_ARG,
    extraArgs: overrides.extraArgs ?? parseExtraArgs(env.PAGEINDEX_EXTRA_ARGS),
    progress: overrides.progress,
    env
  };
}
