import { QueryFailureStage } from "./types";

export class QueryStageError extends Error {
  readonly stage: QueryFailureStage;
  readonly cause: unknown;

  constructor(stage: QueryFailureStage, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    super(`Query failed during ${stage}: ${message}`);
    this.name = "QueryStageError";
    this.stage = stage;
    this.cause = error;
  }
}

export async function runQueryStage<T>(stage: QueryFailureStage, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof QueryStageError) {
      throw error;
    }
    throw new QueryStageError(stage, error);
  }
}
