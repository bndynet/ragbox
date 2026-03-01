import { loadPageIndexConfig } from "./config";
import { ChatMessage, PageIndexOptions } from "./types";

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export async function chatCompletion(messages: ChatMessage[], options: PageIndexOptions = {}): Promise<string> {
  const config = loadPageIndexConfig(options);

  if (!config.apiKey) {
    throw new Error("OPENAI_API_KEY is required for query");
  }

  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed with ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM response did not contain message content");
  }

  return content;
}
