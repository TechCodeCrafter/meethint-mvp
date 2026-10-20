import { PROVIDERS, type ProviderId } from "./providers";

/** Thrown when a provider call fails; `hint` is a user-facing fix. */
export class LLMError extends Error {
  constructor(msg: string, public hint?: string) { super(msg); }
}

/** Pull the (possibly incomplete) "answer" string out of a streaming JSON object. */
export function partialAnswer(buf: string): string {
  const m = buf.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return "";
  let s = m[1].replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
  try { return JSON.parse(`"${s}"`); } catch { return s.replace(/\\n/g, " ").replace(/\\"/g, '"'); }
}

async function readSSE(r: Response, onData: (d: any) => void) {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try { onData(JSON.parse(d)); } catch {}
    }
  }
}

function netError(e: any, label: string): never {
  if (e instanceof LLMError) throw e;
  // Browsers report CORS-blocked error responses (e.g. OpenAI 401) as a bare TypeError.
  if (e?.name === "TypeError") throw new LLMError(`Couldn't reach ${label}.`, "Check that the API key is correct and active, and that you're online.");
  throw e;
}

export async function callLLM(opts: {
  provider: ProviderId; model?: string; key: string; system: string; user: string; maxTokens?: number;
  /** When set, the response is streamed and this receives the accumulated raw text. */
  onText?: (raw: string) => void;
}): Promise<{ text: string; model: string }> {
  const p = PROVIDERS[opts.provider];
  if (!p) throw new LLMError("Unknown provider");
  if (!opts.key) throw new LLMError("No API key available for this provider.");
  const model = opts.model?.trim() || p.model;
  const label = `${p.label} · ${model}`;
  const stream = !!opts.onText;
  try {
    if (opts.provider === "anthropic") {
      const r = await fetch(`${p.base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.key,
          "anthropic-version": "2023-06-01",
          // Required for CORS when called from the browser with the user's own key.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 1000, system: opts.system, messages: [{ role: "user", content: opts.user }], stream }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new LLMError(j?.error?.message || `Anthropic error ${r.status}`);
      }
      if (!stream) {
        const j = await r.json();
        return { text: (j.content || []).map((c: any) => c.text || "").join(""), model: label };
      }
      let text = "";
      await readSSE(r, (d) => {
        if (d.type === "content_block_delta" && d.delta?.text) { text += d.delta.text; opts.onText!(text); }
      });
      return { text, model: label };
    }
    const body: any = {
      model,
      messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }],
      response_format: { type: "json_object" },
    };
    if (stream) body.stream = true;
    // Fast mode for OpenAI reasoning models
    if (opts.provider === "openai" && /^(gpt-5|o\d)/.test(model)) body.reasoning_effort = /^gpt-5(-mini|-nano)?$/.test(model) ? "minimal" : "low";
    const send = (b: any) =>
      fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
        body: JSON.stringify(b),
      });
    let r = await send(body);
    if (!r.ok) {
      let j: any = await r.json().catch(() => ({}));
      if (body.reasoning_effort && /reasoning/i.test(j?.error?.message || "")) {
        delete body.reasoning_effort;
        r = await send(body);
        if (!r.ok) j = await r.json().catch(() => ({}));
      }
      if (!r.ok) throw new LLMError(j?.error?.message || `${p.label} error ${r.status}`);
    }
    if (!stream) {
      const j = await r.json();
      return { text: j.choices?.[0]?.message?.content || "", model: label };
    }
    let text = "";
    await readSSE(r, (d) => {
      const t = d.choices?.[0]?.delta?.content;
      if (t) { text += t; opts.onText!(text); }
    });
    return { text, model: label };
  } catch (e) {
    netError(e, p.label);
  }
}

export function parseJson(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model did not return JSON");
  return JSON.parse(m[0]);
}
