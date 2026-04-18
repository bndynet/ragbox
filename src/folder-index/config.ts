import { PageIndexOptions } from "./types";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadPageIndexConfig(overrides: PageIndexOptions = {}): Required<Pick<PageIndexOptions, "pythonPath" | "model" | "baseUrl" | "concurrency">> &
  PageIndexOptions {
  const env = overrides.env ?? process.env;

  return {
    pythonPath: overrides.pythonPath ?? env.PAGEINDEX_PYTHON ?? "python3",
    retriever: overrides.retriever,
    lexicalIndex: overrides.lexicalIndex,
    model: overrides.model ?? env.PAGEINDEX_MODEL ?? env.LLM_MODEL ?? "gpt-4o-mini",
    baseUrl: overrides.baseUrl ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: overrides.apiKey ?? env.OPENAI_API_KEY,
    llmClient: overrides.llmClient,
    concurrency: overrides.concurrency ?? parsePositiveInt(env.PAGEINDEX_CONCURRENCY, 1),
    exclude: overrides.exclude,
    include: overrides.include,
    outputDir: overrides.outputDir ?? env.RAGBOX_OUTPUT_DIR,
    progress: overrides.progress,
    trace: overrides.trace,
    watchDebounceMs: overrides.watchDebounceMs ?? parseNonNegativeInt(env.RAGBOX_WATCH_DEBOUNCE_MS, 500),
    watchHealthFile: overrides.watchHealthFile ?? env.RAGBOX_WATCH_HEALTH_FILE,
    watchLockFile: overrides.watchLockFile ?? env.RAGBOX_WATCH_LOCK_FILE,
    watchProgress: overrides.watchProgress,
    watchRetryAttempts: overrides.watchRetryAttempts ?? parseNonNegativeInt(env.RAGBOX_WATCH_RETRY_ATTEMPTS, 0),
    watchRetryDelayMs: overrides.watchRetryDelayMs ?? parseNonNegativeInt(env.RAGBOX_WATCH_RETRY_DELAY_MS, 1000),
    watchStaging:
      overrides.watchStaging ??
      (parseBoolean(env.RAGBOX_WATCH_STAGING) || Boolean(overrides.watchStagingOutputDir ?? env.RAGBOX_WATCH_STAGING_OUTPUT_DIR)),
    watchStagingOutputDir: overrides.watchStagingOutputDir ?? env.RAGBOX_WATCH_STAGING_OUTPUT_DIR,
    watchWebhookUrl: overrides.watchWebhookUrl ?? env.RAGBOX_WATCH_WEBHOOK_URL,
    env
  };
}
