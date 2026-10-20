"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildIndex, search, tokenize, expandQuery, type Hit, type Index } from "@/lib/search";
import { extractiveAnswer, type Answer } from "@/lib/answer";
import { loadGitHub, loadUploaded, filesFromDrop } from "@/lib/loaders";
import { DEMO_FILES } from "@/lib/demo";
import { PROVIDERS, type ProviderId } from "@/lib/providers";

type Source = {
  kind: "github" | "upload" | "demo";
  label: string;
  ref?: string;
  gh?: { owner: string; repo: string; sha: string };
  files: number;
  lines: number;
  skipped: number;
  truncated?: boolean;
};

type Result = {
  id: number;
  question: string;
  hits: Hit[];
  answer: Answer;
  ms: number;
  ai: "off" | "loading" | "done" | "error";
  aiError?: string;
};

const EXAMPLE_REPOS = ["sindresorhus/ky", "expressjs/express", "vercel/swr", "supabase/supabase-js"];
const DEMO_QUESTIONS = [
  "How does the payment retry logic work?",
  "Where do we store user preferences?",
  "What's the current rate limit on the checkout endpoint?",
];

export default function Page() {
  const [tab, setTab] = useState<"github" | "upload" | "demo">("github");
  const [repoInput, setRepoInput] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const indexRef = useRef<Index | null>(null);
  const [progress, setProgress] = useState<{ msg: string; pct: number } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [over, setOver] = useState(false);

  const [question, setQuestion] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const nextId = useRef(1);

  const [showAI, setShowAI] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [serverProviders, setServerProviders] = useState<ProviderId[]>([]);

  const qRef = useRef<HTMLTextAreaElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j) => {
        setServerProviders(j.server || []);
        if (j.server?.length) setProvider(j.server[0]);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, [tab, source]);

  const aiReady = !!apiKey.trim() || serverProviders.includes(provider);

  const finishLoad = useCallback((files: { path: string; content: string }[], s: Omit<Source, "files" | "lines">) => {
    if (!files.length) throw new Error("No readable code files found. Supported: source code, config, SQL, Markdown (no binaries, max 400 KB per file).");
    setProgress({ msg: "Building search index…", pct: 97 });
    const idx = buildIndex(files);
    indexRef.current = idx;
    setSource({ ...s, files: files.length, lines: idx.lineCount });
    setResults([]);
    setProgress(null);
    setTimeout(() => qRef.current?.focus(), 50);
  }, []);

  async function connectGitHub(input = repoInput) {
    setLoadError("");
    setProgress({ msg: "Connecting…", pct: 1 });
    try {
      const r = await loadGitHub(input, ghToken.trim() || undefined, (msg, pct) => setProgress({ msg, pct: pct ?? 0 }));
      finishLoad(r.files, {
        kind: "github",
        label: r.label,
        ref: r.ref,
        gh: { owner: r.owner, repo: r.repo, sha: r.sha },
        skipped: r.skipped,
        truncated: r.truncated,
      });
    } catch (e: any) {
      setProgress(null);
      setLoadError(e.message || String(e));
    }
  }

  async function handleFiles(list: File[]) {
    if (!list.length) return;
    setLoadError("");
    setProgress({ msg: `Reading ${list.length} file(s)…`, pct: 2 });
    try {
      const { files, skipped } = await loadUploaded(list, (msg, pct) => setProgress({ msg, pct: pct ?? 0 }));
      const first = list[0] as any;
      const root = first.webkitRelativePath?.split("/")[0];
      const label = list.length === 1 && /\.zip$/i.test(list[0].name) ? list[0].name : root || `${files.length} uploaded files`;
      finishLoad(files, { kind: "upload", label, skipped });
    } catch (e: any) {
      setProgress(null);
      setLoadError(e.message || String(e));
    }
  }

  function loadDemo() {
    setLoadError("");
    finishLoad(DEMO_FILES, { kind: "demo", label: "acme/sample-saas (demo)", skipped: 0 });
  }

  async function ask(qText = question) {
    const q = qText.trim();
    const idx = indexRef.current;
    if (!q || !idx) return;
    const t0 = performance.now();
    const hits = search(idx, q, 6);
    const answer = extractiveAnswer(q, hits);
    const ms = Math.round(performance.now() - t0);
    const id = nextId.current++;
    const useAI = aiReady && hits.length > 0;
    setResults((r) => [{ id, question: q, hits, answer, ms, ai: useAI ? "loading" : "off" }, ...r]);
    setQuestion("");
    if (!useAI) return;
    try {
      // give the model a little more surrounding context than the display snippet
      const snippets = hits.map((h, i) => {
        const file = idx.files.find((f) => f.path === h.path)!;
        const lines = file.content.split(/\r?\n/);
        const start = Math.max(1, h.start - 12);
        const end = Math.min(lines.length, h.end + 12);
        return { n: i + 1, path: h.path, start, end, code: lines.slice(start - 1, end).join("\n") };
      });
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, snippets, provider, model: model || undefined, apiKey: apiKey || undefined }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "AI request failed");
      setResults((r) =>
        r.map((x) =>
          x.id === id
            ? { ...x, ai: "done", answer: { answer: j.answer, keyPoints: j.keyPoints, confidence: j.confidence, cited: j.cited, mode: "ai", model: j.model } }
            : x
        )
      );
    } catch (e: any) {
      setResults((r) => r.map((x) => (x.id === id ? { ...x, ai: "error", aiError: e.message } : x)));
    }
  }

  function reset() {
    indexRef.current = null;
    setSource(null);
    setResults([]);
    setLoadError("");
  }

  const suggestions = source?.kind === "demo" ? DEMO_QUESTIONS : [];

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>?</span>
          Code Meeting Answerer
        </div>
        <div className="top-right">
          <span className="pill hide-sm" title="No login, no database. Closing the tab clears everything.">
            <span className="dot" />Session only · nothing saved
          </span>
          <button className="btn sm" onClick={() => setShowAI((s) => !s)} aria-expanded={showAI}>
            {aiReady ? "AI: on" : "AI: off"}
          </button>
        </div>
      </header>

      {showAI && (
        <section className="card settings" aria-label="AI settings">
          <p className="section-label">AI-written answers (optional)</p>
          <p className="hint" style={{ marginTop: 0 }}>
            Without a key, answers are pulled straight from the matching code (instant, nothing leaves your browser). Add a key to get a written
            explanation from the same snippets. The key lives only in this tab&apos;s memory and is forwarded to the provider per request; it is never stored.
          </p>
          <div className="grid">
            <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} aria-label="Provider">
              {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
                <option key={p} value={p}>{PROVIDERS[p].label}</option>
              ))}
            </select>
            <input className="input" type="password" autoComplete="off" placeholder={serverProviders.includes(provider) ? "Using server key (optional override)" : "API key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label="API key" />
            <input className="input" placeholder={`Model (default ${PROVIDERS[provider].model})`} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" />
          </div>
          {aiReady && <p className="ok">AI answers are on for this session.</p>}
        </section>
      )}

      {!source ? (
        <section className="card source" aria-label="Connect code">
          <p className="section-label">1 · Connect your code</p>
          <div className="tabs" role="tablist">
            {(["github", "upload", "demo"] as const).map((t) => (
              <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === "github" ? "GitHub repo" : t === "upload" ? "Upload files" : "Try a demo"}
              </button>
            ))}
          </div>

          {tab === "github" && (
            <div>
              <form className="row" onSubmit={(e) => { e.preventDefault(); connectGitHub(); }}>
                <input className="input mono" placeholder="https://github.com/owner/repo  or  owner/repo" value={repoInput} onChange={(e) => setRepoInput(e.target.value)} aria-label="GitHub repository" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <button className="btn primary" disabled={!repoInput.trim() || !!progress}>Connect</button>
              </form>
              <div className="chips">
                <span className="hint" style={{ margin: 0 }}>Try:</span>
                {EXAMPLE_REPOS.map((r) => (
                  <button key={r} className="chip mono" onClick={() => { setRepoInput(r); connectGitHub(r); }} disabled={!!progress}>{r}</button>
                ))}
              </div>
              <details className="token">
                <summary>Private repo or hitting rate limits? Add a GitHub token</summary>
                <div className="row">
                  <input className="input mono" type="password" autoComplete="off" placeholder="github_pat_… (read-only, kept in memory only)" value={ghToken} onChange={(e) => setGhToken(e.target.value)} aria-label="GitHub token" />
                </div>
                <p className="hint">Use a fine-grained token with read-only “Contents” access. Branches and sub-folders work too: github.com/owner/repo/tree/branch/path</p>
              </details>
            </div>
          )}

          {tab === "upload" && (
            <div
              className={`drop ${over ? "over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={async (e) => { e.preventDefault(); setOver(false); handleFiles(await filesFromDrop(e.dataTransfer)); }}
            >
              <p>Drop a project folder, files, or a .zip here. Files are read in your browser and never uploaded to a server.</p>
              <div className="row">
                <button className="btn primary" onClick={() => folderRef.current?.click()} disabled={!!progress}>Choose folder</button>
                <button className="btn" onClick={() => filesRef.current?.click()} disabled={!!progress}>Choose files or .zip</button>
              </div>
              <input ref={folderRef} type="file" multiple hidden onChange={(e) => handleFiles([...(e.target.files || [])])} />
              <input ref={filesRef} type="file" multiple hidden onChange={(e) => handleFiles([...(e.target.files || [])])} />
            </div>
          )}

          {tab === "demo" && (
            <div>
              <p className="hint" style={{ marginTop: 0 }}>Load a small sample SaaS codebase (payments, preferences, rate limiting) to see how answers look.</p>
              <button className="btn primary" style={{ marginTop: 10 }} onClick={loadDemo}>Load sample codebase</button>
            </div>
          )}

          {progress && (
            <div className="progress" role="status">
              <div className="bar"><i style={{ width: `${progress.pct}%` }} /></div>
              <p>{progress.msg}</p>
            </div>
          )}
          {loadError && <div className="err" role="alert">{loadError}</div>}
        </section>
      ) : (
        <section className="card loaded" aria-label="Connected source">
          <div>
            <div className="name"><span className="status-dot" />{source.label}{source.ref ? <span className="meta"> @ {source.ref}</span> : null}</div>
            <div className="meta">
              {source.files.toLocaleString()} files indexed · {source.lines.toLocaleString()} lines
              {source.skipped ? ` · ${source.skipped.toLocaleString()} skipped (binary, vendor, or too large)` : ""}
              {source.truncated ? " · large repo, partially indexed" : ""}
            </div>
          </div>
          <button className="btn sm" onClick={reset}>Change source</button>
        </section>
      )}

      <section className="card ask" aria-label="Ask a question">
        <p className="section-label">2 · Ask what was asked in the meeting</p>
        <textarea
          ref={qRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); ask(); } }}
          placeholder={source ? "e.g. How does the payment retry logic work?" : "Connect a repo or upload files first"}
          aria-label="Question"
          disabled={!source}
        />
        {suggestions.length > 0 && (
          <div className="chips">
            {suggestions.map((s) => (
              <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>
            ))}
          </div>
        )}
        <div className="ask-actions">
          <span className="kbd"><kbd>Enter</kbd> to answer · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
          <button className="btn primary answer-btn" onClick={() => ask()} disabled={!source || !question.trim()}>Answer</button>
        </div>
      </section>

      <div className="results" aria-live="polite">
        {results.map((r) => (
          <AnswerCard key={r.id} r={r} source={source} />
        ))}
        {source && !results.length && (
          <div className="empty">Answers appear here with the exact files and lines they came from. Ask as many questions as you like.</div>
        )}
      </div>

      <p className="foot">No login · no database · nothing persists after you close this tab.</p>
    </div>
  );
}

function renderInline(text: string, onCite: (n: number) => void) {
  const parts = text.split(/(`[^`]+`|\[\d+(?:\s*,\s*\d+)*\])/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
    const m = p.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (m)
      return (
        <span key={i}>
          {m[1].split(/\s*,\s*/).map((n) => (
            <a key={n} href="#" className="cite" onClick={(e) => { e.preventDefault(); onCite(Number(n)); }} aria-label={`Source ${n}`}>{n}</a>
          ))}
        </span>
      );
    return <span key={i}>{p}</span>;
  });
}

function AnswerCard({ r, source }: { r: Result; source: Source | null }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const termSet = useMemo(() => new Set(expandQuery(r.question).filter((t) => t.original).map((t) => t.term)), [r.question]);
  const cite = (n: number) => {
    const el = refs.current[n - 1];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.animate([{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }], { duration: 1200 });
    }
  };
  const a = r.answer;
  const copyAll = () => {
    const txt = `Q: ${r.question}\n\n${a.answer}\n\n${a.keyPoints.map((k) => "- " + k).join("\n")}\n\nSources:\n${r.hits.map((h, i) => `[${i + 1}] ${h.path}:${h.start}-${h.end}`).join("\n")}`;
    navigator.clipboard?.writeText(txt.replace(/`/g, ""));
  };
  return (
    <article className="card ans">
      <div className="ans-q">
        <b>{r.question}</b>
        <button className="btn ghost sm" onClick={copyAll} title="Copy answer and sources">Copy</button>
      </div>
      <div className="badges">
        {a.mode === "ai" ? <span className="badge ai">AI answer · {a.model}</span> : <span className="badge">From the code · no AI</span>}
        <span className={`badge ${a.confidence}`}>Match: {a.confidence}</span>
        <span className="badge">{r.ms} ms search</span>
        {r.ai === "loading" && <span className="ai-wait"><span className="spinner" />Writing AI answer…</span>}
        {r.ai === "error" && <span className="badge Low" title={r.aiError}>AI failed: {r.aiError?.slice(0, 80)}</span>}
      </div>
      <p className="ans-text">{renderInline(a.answer, cite)}</p>
      {a.keyPoints.length > 0 && (
        <>
          <p className="section-label">Key points</p>
          <ul className="kp">
            {a.keyPoints.map((k, i) => (
              <li key={i}>{renderInline(k, cite)}</li>
            ))}
          </ul>
        </>
      )}
      {r.hits.length > 0 && <p className="section-label">Sources</p>}
      {r.hits.map((h, i) => (
        <div className="src" key={i} ref={(el) => { refs.current[i] = el; }}>
          <div className="src-head">
            <span className="src-path">
              <span className="cite">{i + 1}</span>
              <span>{h.path}<span className="lines">:{h.start}–{h.end}</span></span>
            </span>
            <span className="src-actions">
              <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(`${h.path}:${h.start}-${h.end}`)} title="Copy file path and lines">Copy path</button>
              {source?.gh && (
                <a className="btn ghost sm" target="_blank" rel="noreferrer" href={`https://github.com/${source.gh.owner}/${source.gh.repo}/blob/${source.gh.sha}/${h.path}#L${h.start}-L${h.end}`}>
                  GitHub ↗
                </a>
              )}
            </span>
          </div>
          <pre className="code">
            {h.code.split("\n").map((l, j) => {
              const hit = tokenize(l).some((t) => termSet.has(t));
              return (
                <div key={j} className={`ln ${hit ? "hit" : ""}`}>
                  <span>{h.start + j}</span>
                  <span>{l || " "}</span>
                </div>
              );
            })}
          </pre>
        </div>
      ))}
    </article>
  );
}
