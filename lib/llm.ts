import { PROVIDERS, type ProviderId } from "./providers";

export function resolveKey(provider: ProviderId, apiKey?: string) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("Unknown provider");
  const key = apiKey?.trim() || process.env[p.env];
  if (!key) throw new Error("No API key available for this provider.");
  return { p, key };
}

export async function callLLM(opts: {
  provider: ProviderId; model?: string; apiKey?: string; system: string; user: string; maxTokens?: number;
}): Promise<{ text: string; model: string }> {
  const { p, key } = resolveKey(opts.provider, opts.apiKey);
  const model = opts.model?.trim() || p.model;
  if (opts.provider === "anthropic") {
    const r = await fetch(`${p.base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 1000, system: opts.system, messages: [{ role: "user", content: opts.user }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `Anthropic error ${r.status}`);
    return { text: (j.content || []).map((c: any) => c.text || "").join(""), model: `${p.label} · ${model}` };
  }
  const body: any = {
    model,
    messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }],
    response_format: { type: "json_object" },
  };
  // Fast mode for OpenAI reasoning models
  if (opts.provider === "openai" && /^(gpt-5|o\d)/.test(model)) body.reasoning_effort = /^gpt-5(-mini|-nano)?$/.test(model) ? "minimal" : "low";
  const send = async (b: any) => {
    const r = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(b),
    });
    return { r, j: await r.json() };
  };
  let { r, j } = await send(body);
  if (!r.ok && body.reasoning_effort && /reasoning/i.test(j?.error?.message || "")) {
    delete body.reasoning_effort;
    ({ r, j } = await send(body));
  }
  if (!r.ok) throw new Error(j?.error?.message || `${p.label} error ${r.status}`);
  return { text: j.choices?.[0]?.message?.content || "", model: `${p.label} · ${model}` };
}

export function parseJson(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model did not return JSON");
  return JSON.parse(m[0]);
}
