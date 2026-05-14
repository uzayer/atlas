import { invoke } from "@tauri-apps/api/core";

export interface LLMConfig {
  provider: "anthropic" | "openai" | "google";
  model: string;
  apiKey: string;
  system?: string;
}

export interface LLMMessage {
  role: string;
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number } | null;
  stop_reason: string | null;
}

export async function sendChatMessage(
  config: LLMConfig,
  messages: LLMMessage[]
): Promise<LLMResponse> {
  return invoke<LLMResponse>("chat_send", {
    req: {
      provider: config.provider,
      model: config.model,
      api_key: config.apiKey,
      messages,
      system: config.system ?? null,
    },
  });
}

export const DEFAULT_MODELS: Record<string, { provider: string; label: string }[]> = {
  anthropic: [
    { provider: "anthropic", label: "Claude Sonnet 4.6" },
    { provider: "anthropic", label: "Claude Opus 4.6" },
    { provider: "anthropic", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { provider: "openai", label: "GPT-4o" },
    { provider: "openai", label: "GPT-4o mini" },
    { provider: "openai", label: "o3" },
  ],
  google: [
    { provider: "google", label: "Gemini 2.5 Pro" },
    { provider: "google", label: "Gemini 2.5 Flash" },
  ],
};

export const MODEL_IDS: Record<string, string> = {
  "Claude Sonnet 4.6": "claude-sonnet-4-6-20250514",
  "Claude Opus 4.6": "claude-opus-4-6-20250514",
  "Claude Haiku 4.5": "claude-haiku-4-5-20251001",
  "GPT-4o": "gpt-4o",
  "GPT-4o mini": "gpt-4o-mini",
  "o3": "o3",
  "Gemini 2.5 Pro": "gemini-2.5-pro-preview-06-05",
  "Gemini 2.5 Flash": "gemini-2.5-flash-preview-05-20",
};
