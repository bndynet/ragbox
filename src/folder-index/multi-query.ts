import { loadPageIndexConfig } from "./config";
import { chatCompletion } from "./llm-client";
import { queryFolder } from "./query";
import { PageIndexOptions, QueryResult, QuerySource } from "./types";

export type MultiQueryTarget = {
  name: string;
  target: string;
  options?: PageIndexOptions;
};

export type MultiQuerySource = QuerySource & {
  source: string;
  originalReference: string;
};

export type MultiQuerySourceResult = QueryResult & {
  source: string;
};

export type MultiQueryResult = {
  version: 1;
  target: "multiple";
  sourcesQueried: string[];
  question: string;
  model: string;
  answer: string;
  results: MultiQuerySourceResult[];
  sources: MultiQuerySource[];
  warnings: string[];
  timingsMs: {
    query: number;
    answer: number;
    total: number;
  };
};

function elapsedSince(startedAt: number): number {
  return Date.now() - startedAt;
}

function sourceReference(source: string, reference: string): string {
  return `${source}:${reference}`;
}

function answerContext(results: MultiQuerySourceResult[]): string {
  const parts = results.flatMap((result) =>
    result.sources.map((source) => `Source: ${sourceReference(result.source, source.reference)}\n${source.text}`)
  );
  return parts.length > 0 ? parts.join("\n\n---\n\n") : "(no relevant context found)";
}

function sourceAnswerSummary(results: MultiQuerySourceResult[]): string {
  return results
    .map((result) => {
      const warnings = result.warnings.length > 0 ? `\nWarnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      return `Source: ${result.source}\nAnswer:\n${result.answer}${warnings}`;
    })
    .join("\n\n---\n\n");
}

export async function queryMultipleIndexes(
  targets: MultiQueryTarget[],
  question: string,
  answerOptions: PageIndexOptions = {}
): Promise<MultiQueryResult> {
  if (targets.length === 0) {
    throw new Error("At least one query source is required.");
  }

  const totalStartedAt = Date.now();
  const queryStartedAt = Date.now();
  const results: MultiQuerySourceResult[] = [];

  for (const target of targets) {
    results.push({
      ...(await queryFolder(target.target, question, target.options ?? answerOptions)),
      source: target.name
    });
  }

  const queryMs = elapsedSince(queryStartedAt);
  const warnings = results.flatMap((result) => result.warnings.map((warning) => `[${result.source}] ${warning}`));
  const sources = results.flatMap((result) =>
    result.sources.map((source) => ({
      ...source,
      source: result.source,
      originalReference: source.reference,
      reference: sourceReference(result.source, source.reference)
    }))
  );

  const prompt = `Answer the user question using only the provided multi-source context.
Synthesize across sources when they complement each other.
If sources conflict, call that out briefly.
If the context is insufficient, say that the indexed documents do not contain enough information.
Use source references in the form source:path#node_id when possible.

User question:
${question}

Per-source draft answers:
${sourceAnswerSummary(results)}

Multi-source context:
${answerContext(results)}`;

  const answerStartedAt = Date.now();
  const answer = await chatCompletion([{ role: "user", content: prompt }], answerOptions);
  const answerMs = elapsedSince(answerStartedAt);

  return {
    version: 1,
    target: "multiple",
    sourcesQueried: targets.map((target) => target.name),
    question,
    model: loadPageIndexConfig(answerOptions).model,
    answer,
    results,
    sources,
    warnings,
    timingsMs: {
      query: queryMs,
      answer: answerMs,
      total: elapsedSince(totalStartedAt)
    }
  };
}
