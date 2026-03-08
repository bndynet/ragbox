export {
  createIndex,
  inspectIndex,
  queryIndex,
  validateIndex,
  watchIndex
} from "./sdk";

export type {
  CreateIndexOptions,
  CreateIndexResult,
  IndexCounts,
  InspectIndexDocument,
  InspectIndexResult,
  QueryIndexOptions,
  QueryResult,
  SdkOptions,
  ValidateIndexResult,
  ValidationIssue,
  WatchIndexHandle,
  WatchIndexOptions,
  WatchIndexReadyResult
} from "./sdk";

export * as advanced from "./advanced";
