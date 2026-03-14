import { loadPageIndexConfig } from "./config";
import { ChatMessage, LlmChatRequest, PageIndexOptions } from "./types";

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export async function chatCompletion(messages: ChatMessage[], options: PageIndexOptions = {}): Promise<string> {
  const config = loadPageIndexConfig(options);
  const request: LlmChatRequest = {
    messages,
    model: config.model,
    temperature: 0
  };

  if (options.llmClient) {
    return await options.llmClient.chatCompletion(request);
  }

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
      model: request.model,
      messages: request.messages,
      temperature: request.temperature
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
