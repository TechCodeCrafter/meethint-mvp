export const PROVIDERS = {
  openai: { label: "OpenAI", env: "OPENAI_API_KEY", model: "gpt-5-mini", base: "https://api.openai.com/v1" },
  anthropic: { label: "Anthropic", env: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5", base: "https://api.anthropic.com/v1" },
  xai: { label: "xAI (Grok)", env: "XAI_API_KEY", model: "grok-4-fast", base: "https://api.x.ai/v1" },
  groq: { label: "Groq", env: "GROQ_API_KEY", model: "llama-3.3-70b-versatile", base: "https://api.groq.com/openai/v1" },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
