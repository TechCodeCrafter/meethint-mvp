"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildIndex, search, tokenize, expandQuery, type Hit, type Index, type CodeFile } from "@/lib/search";
import { extractiveAnswer, type Answer } from "@/lib/answer";
import { loadGitHub, loadUploaded, filesFromDrop } from "@/lib/loaders";
import { DEMO_FILES } from "@/lib/demo";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { Listener, BrowserSpeech, canCaptureMeetingAudio, hasBrowserSpeech, heuristicQuestions, type ListenMode } from "@/lib/listen";

type Source = {
  id: number;
  kind: "github" | "upload" | "demo";
  label: string;
  ref?: string;
  files: CodeFile[];
  docs: number;
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
  ai: "off" | "searching" | "writing" | "done" | "error";
  aiError?: string;
  heard?: boolean;
};

type Seg = { id: number; text: string; at: number };
type Detected = { id: number; q: string; answered: boolean };

const EXAMPLE_REPOS = ["sindresorhus/ky", "expressjs/express", "vercel/swr", "supabase/supabase-js"];
const DEMO_QUESTIONS = [
  "How does the payment retry logic work?",
  "Where do we store user preferences?",
  "What's the current rate limit on the checkout endpoint?",
];
const ACCEPT =
  ".zip,.pdf,.docx,.pptx,.xlsx,.xls,.ods,.odt,.odp,.rtf,.epub,.ipynb,.md,.mdx,.txt,.csv,.tsv,.json,.yaml,.yml,.toml,.xml,.html,.sql,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.cpp,.h,.cs,.php,.sh,.vue,.svelte,.css,.scss,.prisma,.graphql,.proto,.tf,.env.example,*";

function normQ(s: string) {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) || []);
}
function similar(a: string, b: string) {
  const A = normQ(a),
    B = normQ(b);
  let i = 0;
  A.forEach((w) => B.has(w) && i++);
  return i / Math.max(1, Math.min(A.size, B.size)) > 0.75;
}

export default function Page() {
  // ---------- sources ----------
  const [sources, setSources] = useState<Source[]>([]);
  const indexRef = useRef<Index | null>(null);
  const [addOpen, setAddOpen] = useState(true);
  const [tab, setTab] = useState<"github" | "upload" | "demo">("github");
  const [repoInput, setRepoInput] = useState("");
  const [ghToken, setGhToken] = useState("");
  const [progress, setProgress] = useState<{ msg: string; pct: number } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [over, setOver] = useState(false);
  const sid = useRef(1);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);

  // ---------- questions ----------
  const [question, setQuestion] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const nextId = useRef(1);
  const qRef = useRef<HTMLTextAreaElement>(null);

  // ---------- AI ----------
  const [showAI, setShowAI] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [sttProvider, setSttProvider] = useState<"openai" | "groq">("openai");
  const [sttKey, setSttKey] = useState("");
  const [server, setServer] = useState<{ server: ProviderId[]; stt: string[] }>({ server: [], stt: [] });

  // ---------- listening ----------
  const [listening, setListening] = useState(false);
  const [mode, setMode] = useState<ListenMode>("meeting");
  const [level, setLevel] = useState(0);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [interim, setInterim] = useState("");
  const [detected, setDetected] = useState<Detected[]>([]);
  const [autoAnswer, setAutoAnswer] = useState(true);
  const [listenError, setListenError] = useState("");
  const [meetingCapable, setMeetingCapable] = useState(true);
  const listenerRef = useRef<{ stop: () => void } | null>(null);
  const segsRef = useRef<Seg[]>([]);
  const detectedRef = useRef<Detected[]>([]);
  const autoRef = useRef(autoAnswer);
  autoRef.current = autoAnswer;
  const transcriptBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j) => {
        setServer({ server: j.server || [], stt: j.stt || [] });
        if (j.server?.length) setProvider(j.server[0]);
      })
      .catch(() => {});
    const ok = canCaptureMeetingAudio();
    setMeetingCapable(ok);
    if (!ok) setMode("mic");
  }, []);

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  });

  useEffect(() => {
    transcriptBox.current?.scrollTo({ top: transcriptBox.current.scrollHeight });
  }, [segs, interim]);

  const aiReady = !!apiKey.trim() || server.server.includes(provider);
  const stt = useMemo(() => {
    if (sttKey.trim()) return { provider: sttProvider, key: sttKey.trim() };
    if (apiKey.trim() && (provider === "openai" || provider === "groq")) return { provider, key: apiKey.trim() };
    if (server.stt.length) return { provider: server.stt[0] as "openai" | "groq", key: "" };
    return null;
  }, [sttKey, sttProvider, apiKey, provider, server.stt]);

  const aiBody = () => ({ provider, model: model || undefined, apiKey: apiKey || undefined });

  // ---------- index ----------
  const rebuild = useCallback((list: Source[]) => {
    const multi = list.length > 1;
    const files = list.flatMap((s) => s.files.map((f) => ({ ...f, src: multi ? s.label : undefined, key: undefined })));
    indexRef.current = files.length ? buildIndex(files) : null;
  }, []);

  function addSource(r: { label: string; ref?: string; files: CodeFile[]; skipped: number; truncated?: boolean }, kind: Source["kind"]) {
    if (!r.files.length)
      throw new Error("No readable files found. Supported: source code, config, Markdown, PDF, Word, PowerPoint, Excel, CSV and more (no images or binaries).");
    setProgress({ msg: "Building search index…", pct: 98 });
    const lines = r.files.reduce((n, f) => n + f.content.split("\n").length, 0);
    const s: Source = { id: sid.current++, kind, label: r.label, ref: r.ref, files: r.files, docs: r.files.filter((f) => f.doc).length, lines, skipped: r.skipped, truncated: r.truncated };
    setSources((prev) => {
      const next = [...prev.filter((p) => !(p.kind === kind && p.label === s.label)), s];
      rebuild(next);
      return next;
    });
    setProgress(null);
    setAddOpen(false);
    setTimeout(() => qRef.current?.focus(), 50);
  }

  function removeSource(id: number) {
    setSources((prev) => {
      const next = prev.filter((s) => s.id !== id);
      rebuild(next);
      if (!next.length) setAddOpen(true);
      return next;
    });
  }

  async function connectGitHub(input = repoInput) {
    setLoadError("");
    setProgress({ msg: "Connecting…", pct: 1 });
    try {
      const r = await loadGitHub(input, ghToken.trim() || undefined, (msg, pct) => setProgress((p) => ({ msg, pct: pct ?? p?.pct ?? 0 })));
      addSource(r, "github");
      setRepoInput("");
    } catch (e: any) {
      setProgress(null);
      setLoadError(e.message || String(e));
    }
  }

  async function handleFiles(list: File[]) {
    if (!list.length) return;
    setLoadError("");
    setProgress({ msg: `Scanning ${list.length.toLocaleString()} file(s)…`, pct: 2 });
    try {
      const r = await loadUploaded(list, (msg, pct) => setProgress((p) => ({ msg, pct: pct ?? p?.pct ?? 0 })));
      addSource(r, "upload");
    } catch (e: any) {
      setProgress(null);
      setLoadError(e.message || String(e));
    }
    if (folderRef.current) folderRef.current.value = "";
    if (filesRef.current) filesRef.current.value = "";
  }

  function loadDemo() {
    setLoadError("");
    addSource({ label: "acme/sample-saas (demo)", files: DEMO_FILES, skipped: 0 }, "demo");
  }

  // ---------- answering ----------
  const patch = (id: number, p: Partial<Result>) => setResults((r) => r.map((x) => (x.id === id ? { ...x, ...p } : x)));

  async function ask(qText = question, opts: { heard?: boolean; context?: string } = {}) {
    const q = qText.trim();
    const idx = indexRef.current;
    if (!q || !idx) return;
    const t0 = performance.now();
    const hits = search(idx, q, 8);
    const answer = extractiveAnswer(q, hits.slice(0, 6));
    const ms = Math.round(performance.now() - t0);
    const id = nextId.current++;
    const useAI = aiReady;
    setResults((r) => [{ id, question: q, hits: hits.slice(0, 6), answer, ms, ai: useAI ? "searching" : "off", heard: opts.heard }, ...r]);
    if (opts.heard && document.activeElement !== qRef.current)
      setTimeout(() => document.querySelector(".results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    if (!opts.heard) setQuestion("");
    if (!useAI) return;

    try {
      // Step 1: let the model suggest identifiers + likely files, then search again.
      let merged = hits;
      try {
        const paths = idx.files.map((f) => f.path).slice(0, 2500);
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 6000);
        const ex = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "expand", question: q, paths, ...aiBody() }),
          signal: ctl.signal,
        }).then((r) => r.json());
        clearTimeout(to);
        if (ex.terms?.length || ex.paths?.length) {
          const h2 = search(idx, q, 10, { extra: (ex.terms || []).join(" "), boost: new Set(ex.paths || []) });
          const seen = new Set<string>();
          merged = [...h2, ...hits].filter((h) => {
            const k = `${h.key}:${Math.floor(h.start / 20)}`;
            return seen.has(k) ? false : (seen.add(k), true);
          }).slice(0, 10);
        }
      } catch {}
      if (!merged.length) {
        patch(id, { ai: "done" });
        return;
      }
      patch(id, { ai: "writing", hits: merged });
      const snippets = merged.map((h, i) => {
        const file = idx.byKey.get(h.key)!;
        const lines = file.content.split(/\r?\n/);
        const start = Math.max(1, h.start - 12);
        const end = Math.min(lines.length, h.end + 12);
        return { n: i + 1, path: (h.src ? h.src + " › " : "") + h.path, loc: h.loc, start, end, code: lines.slice(start - 1, end).join("\n") };
      });
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "answer", question: q, snippets, context: opts.context, ...aiBody() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "AI request failed");
      patch(id, {
        ai: "done",
        answer: { answer: j.answer, keyPoints: j.keyPoints, confidence: j.confidence, cited: j.cited, mode: "ai", model: j.model },
      });
    } catch (e: any) {
      patch(id, { ai: "error", aiError: e.message });
    }
  }
  const askRef = useRef(ask);
  askRef.current = ask;

  // ---------- listening ----------
  async function onHeard(text: string) {
    const seg = { id: Date.now() + Math.random(), text, at: Date.now() };
    const earlier = segsRef.current.slice(-8).map((s) => s.text).join(" ");
    segsRef.current = [...segsRef.current, seg].slice(-60);
    setSegs(segsRef.current);
    let qs: string[] = [];
    if (aiReady) {
      try {
        const j = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "detect", earlier, latest: text, already: detectedRef.current.slice(-8).map((d) => d.q), ...aiBody() }),
        }).then((r) => r.json());
        qs = j.questions || [];
      } catch {
        qs = heuristicQuestions(text);
      }
    } else qs = heuristicQuestions(text);
    for (let q of qs) {
      if (detectedRef.current.some((d) => similar(d.q, q))) continue;
      q = q.charAt(0).toUpperCase() + q.slice(1);
      const d: Detected = { id: Date.now() + Math.random(), q, answered: false };
      detectedRef.current = [...detectedRef.current, d].slice(-20);
      if (autoRef.current && indexRef.current) {
        d.answered = true;
        askRef.current(q, { heard: true, context: earlier + " " + text });
      }
      setDetected([...detectedRef.current]);
    }
  }
  const onHeardRef = useRef(onHeard);
  onHeardRef.current = onHeard;

  function vocabPrompt() {
    const idx = indexRef.current;
    if (!idx) return "";
    const names = new Set<string>();
    for (const f of idx.files) {
      const base = f.path.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "");
      if (base.length > 2 && !/^(index|main|test|utils?)$/i.test(base)) names.add(base);
      if (names.size > 80) break;
    }
    return `Software project meeting. Terms: ${[...names].join(", ")}.`;
  }

  async function startListening() {
    setListenError("");
    setShowAI(false);
    try {
      if (stt) {
        const prompt = vocabPrompt();
        const l = new Listener({
          mode,
          transcribe: async (blob) => {
            const fd = new FormData();
            fd.append("file", blob, "seg.webm");
            fd.append("provider", stt.provider);
            if (stt.key) fd.append("apiKey", stt.key);
            fd.append("prompt", prompt);
            const r = await fetch("/api/transcribe", { method: "POST", body: fd });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error || "Transcription failed");
            return j.text || "";
          },
          onText: (t) => onHeardRef.current(t),
          onLevel: setLevel,
          onError: (m) => setListenError(m),
          onEnd: () => {
            setListening(false);
            setLevel(0);
          },
        });
        await l.start();
        listenerRef.current = l;
      } else {
        if (mode !== "mic") throw new Error("Listening to meeting audio needs a transcription key (OpenAI or Groq) — open AI settings. Or switch to “My microphone” to use free browser speech recognition.");
        const b = new BrowserSpeech({
          onText: (t) => {
            setInterim("");
            onHeardRef.current(t);
          },
          onInterim: setInterim,
          onError: setListenError,
          onEnd: () => setListening(false),
        });
        b.start();
        listenerRef.current = b;
      }
      setListening(true);
    } catch (e: any) {
      setListenError(e.message || String(e));
      setListening(false);
    }
  }

  function stopListening() {
    listenerRef.current?.stop();
    listenerRef.current = null;
    setListening(false);
    setInterim("");
    setLevel(0);
  }

  function answerDetected(d: Detected) {
    detectedRef.current = detectedRef.current.map((x) => (x.id === d.id ? { ...x, answered: true } : x));
    setDetected(detectedRef.current);
    ask(d.q, { heard: true, context: segsRef.current.slice(-8).map((s) => s.text).join(" ") });
  }

  const totals = useMemo(
    () => ({
      files: sources.reduce((n, s) => n + s.files.length, 0),
      lines: sources.reduce((n, s) => n + s.lines, 0),
      docs: sources.reduce((n, s) => n + s.docs, 0),
    }),
    [sources]
  );
  const hasSource = sources.length > 0;
  const suggestions = sources.some((s) => s.kind === "demo") ? DEMO_QUESTIONS : [];
  const engine = stt ? `${stt.provider === "groq" ? "Groq Whisper" : "OpenAI"} transcription` : hasBrowserSpeech() ? "free browser speech (mic only)" : "no speech engine";

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
          <button className={`btn sm ${aiReady ? "on" : ""}`} onClick={() => setShowAI((s) => !s)} aria-expanded={showAI}>
            {aiReady ? "AI: on" : "AI: off"}
          </button>
        </div>
      </header>

      {showAI && (
        <section className="card settings" aria-label="AI settings">
          <p className="section-label">AI answers</p>
          <p className="hint" style={{ marginTop: 0 }}>
            Without a key, answers are pulled straight from the matching code (instant, nothing leaves your browser). With a key you get written explanations, smarter search, and question
            detection from meeting audio. Keys live only in this tab&apos;s memory and are passed to the provider per request; they are never stored.
          </p>
          <div className="grid">
            <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} aria-label="Provider">
              {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
                <option key={p} value={p}>{PROVIDERS[p].label}</option>
              ))}
            </select>
            <input className="input" type="password" autoComplete="off" placeholder={server.server.includes(provider) ? "Using server key (optional override)" : "API key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label="API key" />
            <input className="input" placeholder={`Model (default ${PROVIDERS[provider].model})`} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" />
          </div>
          <p className="section-label" style={{ marginTop: 16 }}>Transcription (for listening)</p>
          <p className="hint" style={{ marginTop: 0 }}>
            {provider === "openai" || provider === "groq"
              ? "Uses the key above automatically. Override here if you want a different one."
              : "Anthropic and xAI don't transcribe audio. Add an OpenAI or Groq key to listen to meeting audio."}
          </p>
          <div className="grid two">
            <select value={sttProvider} onChange={(e) => setSttProvider(e.target.value as any)} aria-label="Transcription provider">
              <option value="openai">OpenAI (gpt-4o-mini-transcribe)</option>
              <option value="groq">Groq (Whisper large v3 turbo)</option>
            </select>
            <input className="input" type="password" autoComplete="off" placeholder="Transcription key (optional)" value={sttKey} onChange={(e) => setSttKey(e.target.value)} aria-label="Transcription key" />
          </div>
          <p className="ok">
            {aiReady ? "AI answers on." : "AI answers off."} Listening engine: {engine}.
          </p>
        </section>
      )}

      {/* ---------- sources ---------- */}
      <section className="card source" aria-label="Your code and documents">
        <div className="source-head">
          <p className="section-label" style={{ margin: 0 }}>1 · Code &amp; documents</p>
          {hasSource && (
            <span className="meta">
              {totals.files.toLocaleString()} files{totals.docs ? ` (${totals.docs} docs)` : ""} · {totals.lines.toLocaleString()} lines indexed
            </span>
          )}
        </div>

        {hasSource && (
          <ul className="srcs">
            {sources.map((s) => (
              <li key={s.id}>
                <span className="status-dot" />
                <span className="sname">{s.label}</span>
                {s.ref && <span className="meta">@{s.ref}</span>}
                <span className="meta">
                  {s.files.length.toLocaleString()} files{s.docs ? ` · ${s.docs} docs` : ""}
                  {s.skipped ? ` · ${s.skipped.toLocaleString()} skipped` : ""}
                  {s.truncated ? " · partially indexed" : ""}
                </span>
                <button className="x" onClick={() => removeSource(s.id)} aria-label={`Remove ${s.label}`} title="Remove">×</button>
              </li>
            ))}
          </ul>
        )}
        {hasSource && !addOpen && (
          <button className="btn sm" onClick={() => setAddOpen(true)} style={{ marginTop: 10 }}>+ Add more files, folders or repos</button>
        )}

        {addOpen && (
          <div style={{ marginTop: hasSource ? 14 : 10 }}>
            <div className="tabs" role="tablist">
              {(["github", "upload", "demo"] as const).map((t) => (
                <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === "github" ? "GitHub repo" : t === "upload" ? "Files, folders & docs" : "Try a demo"}
                </button>
              ))}
              {hasSource && <button className="tab" onClick={() => setAddOpen(false)}>Done</button>}
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
                    <button key={r} className="chip mono" onClick={() => connectGitHub(r)} disabled={!!progress}>{r}</button>
                  ))}
                </div>
                <details className="token">
                  <summary>Private repo or hitting rate limits? Add a GitHub token</summary>
                  <div className="row">
                    <input className="input mono" type="password" autoComplete="off" placeholder="github_pat_… (read-only, kept in memory only)" value={ghToken} onChange={(e) => setGhToken(e.target.value)} aria-label="GitHub token" />
                  </div>
                  <p className="hint">Fine-grained token with read-only “Contents” access. Branches and sub-folders work: github.com/owner/repo/tree/branch/path</p>
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
                <p>
                  <b>Drop folders, files or .zip archives here</b> — drop several at once, or add more later.
                  <br />
                  Code, PDF, Word, PowerPoint, Excel, CSV, Markdown, notebooks and more. Read in your browser, never uploaded.
                </p>
                <div className="row">
                  <button className="btn primary" onClick={() => folderRef.current?.click()} disabled={!!progress}>Choose folder</button>
                  <button className="btn" onClick={() => filesRef.current?.click()} disabled={!!progress}>Choose files, docs or .zip</button>
                </div>
                <p className="hint small">Dependencies and build output (node_modules, virtualenvs, site-packages, dist, hidden folders) are skipped automatically.</p>
                <input ref={folderRef} type="file" multiple hidden onChange={(e) => handleFiles([...(e.target.files || [])])} />
                <input ref={filesRef} type="file" multiple hidden accept={ACCEPT} onChange={(e) => handleFiles([...(e.target.files || [])])} />
              </div>
            )}

            {tab === "demo" && (
              <div>
                <p className="hint" style={{ marginTop: 0 }}>Load a small sample SaaS codebase (payments, preferences, rate limiting) to see how answers look.</p>
                <button className="btn primary" style={{ marginTop: 10 }} onClick={loadDemo}>Load sample codebase</button>
              </div>
            )}
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

      {/* ---------- live listening ---------- */}
      <section className={`card listen ${listening ? "live" : ""}`} aria-label="Live listening">
        <div className="listen-row">
          <div className="listen-title">
            <span className={`rec ${listening ? "on" : ""}`} aria-hidden />
            <div>
              <p className="section-label" style={{ margin: 0 }}>2 · Listen to the meeting</p>
              <span className="meta">
                {listening ? `Listening · ${engine}` : "Hears questions from the call and answers them automatically"}
              </span>
            </div>
          </div>
          <div className="listen-ctl">
            {!listening && (
              <select value={mode} onChange={(e) => setMode(e.target.value as ListenMode)} aria-label="Audio source" className="select">
                {meetingCapable && <option value="meeting">Meeting audio (tab / screen)</option>}
                {meetingCapable && <option value="both">Meeting audio + my mic</option>}
                <option value="mic">My microphone</option>
              </select>
            )}
            <label className="toggle">
              <input type="checkbox" checked={autoAnswer} onChange={(e) => setAutoAnswer(e.target.checked)} />
              <span>Auto-answer</span>
            </label>
            {listening ? (
              <button className="btn stop" onClick={stopListening}>Stop</button>
            ) : (
              <button className="btn primary" onClick={startListening} disabled={!hasSource} title={hasSource ? "" : "Add code or documents first"}>
                Start listening
              </button>
            )}
          </div>
        </div>
        {listening && (
          <div className="meter" aria-hidden><i style={{ width: `${Math.round(level * 100)}%` }} /></div>
        )}
        {!listening && !listenError && hasSource && mode !== "mic" && (
          <p className="hint small">
            In the share dialog, pick the meeting tab (Meet / Teams / Zoom web) and turn on <b>“Also share tab audio”</b> — or pick <b>Entire screen</b> with <b>“Share system audio”</b> for desktop apps.
            {!stt && " Needs an OpenAI or Groq key in AI settings for transcription."}
          </p>
        )}
        {listenError && <div className="err" role="alert">{listenError}</div>}
        {(segs.length > 0 || interim) && (
          <div className="transcript" ref={transcriptBox} aria-live="off">
            {segs.slice(-12).map((s) => (
              <p key={s.id}>{s.text}</p>
            ))}
            {interim && <p className="interim">{interim}</p>}
          </div>
        )}
        {detected.length > 0 && (
          <div className="detected">
            <p className="section-label">Questions heard</p>
            {[...detected].reverse().slice(0, 6).map((d) => (
              <div key={d.id} className="dq">
                <span>{d.q}</span>
                {d.answered ? <span className="badge">Answered</span> : <button className="btn sm primary" onClick={() => answerDetected(d)}>Answer</button>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------- ask ---------- */}
      <section className="card ask" aria-label="Ask a question">
        <p className="section-label">3 · Or type the question</p>
        <textarea
          ref={qRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
          placeholder={hasSource ? "e.g. How does the payment retry logic work?" : "Add code or documents first"}
          aria-label="Question"
          disabled={!hasSource}
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
          <button className="btn primary answer-btn" onClick={() => ask()} disabled={!hasSource || !question.trim()}>Answer</button>
        </div>
      </section>

      <div className="results" aria-live="polite">
        {results.map((r) => (
          <AnswerCard key={r.id} r={r} multi={sources.length > 1} />
        ))}
        {hasSource && !results.length && (
          <div className="empty">Answers appear here with the exact files, lines and pages they came from. Ask as many questions as you like.</div>
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

function AnswerCard({ r, multi }: { r: Result; multi: boolean }) {
  const refs = useRef<Record<number, HTMLDivElement | null>>({});
  const [showOther, setShowOther] = useState(false);
  const termSet = useMemo(() => new Set(expandQuery(r.question).filter((t) => t.original).map((t) => t.term)), [r.question]);
  const a = r.answer;
  const numbered = r.hits.map((h, i) => ({ h, n: i + 1 }));
  const cited = a.mode === "ai" && a.cited?.length ? numbered.filter((x) => a.cited!.includes(x.n)) : a.mode === "ai" ? numbered.slice(0, 3) : numbered;
  const other = numbered.filter((x) => !cited.includes(x));
  const cite = (n: number) => {
    if (!cited.some((x) => x.n === n)) setShowOther(true);
    setTimeout(() => {
      const el = refs.current[n];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.animate([{ outline: "2px solid var(--accent)" }, { outline: "2px solid transparent" }], { duration: 1200 });
      }
    }, 30);
  };
  const copyAll = () => {
    const txt = `Q: ${r.question}\n\n${a.answer}\n\n${a.keyPoints.map((k) => "- " + k).join("\n")}\n\nSources:\n${cited.map(({ h, n }) => `[${n}] ${h.path}${h.loc ? ` (${h.loc})` : ""}:${h.start}-${h.end}`).join("\n")}`;
    navigator.clipboard?.writeText(txt.replace(/`/g, ""));
  };
  const renderSrc = ({ h, n }: { h: Hit; n: number }) => (
    <div className="src" key={n} ref={(el) => { refs.current[n] = el; }}>
      <div className="src-head">
        <span className="src-path">
          <span className="cite">{n}</span>
          <span>
            {multi && h.src ? <span className="lines">{h.src} › </span> : null}
            {h.path}
            <span className="lines">{h.loc ? ` · ${h.loc}` : ""}{h.doc ? "" : `:${h.start}–${h.end}`}</span>
          </span>
        </span>
        <span className="src-actions">
          <button className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(`${h.path}${h.loc ? ` (${h.loc})` : ""}:${h.start}-${h.end}`)} title="Copy file path and lines">Copy path</button>
          {h.origin && !h.doc && (
            <a className="btn ghost sm" target="_blank" rel="noreferrer" href={`https://github.com/${h.origin.owner}/${h.origin.repo}/blob/${h.origin.sha}/${h.path}#L${h.start}-L${h.end}`}>GitHub ↗</a>
          )}
        </span>
      </div>
      <pre className={`code ${h.doc ? "doc" : ""}`}>
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
  );
  return (
    <article className="card ans">
      <div className="ans-q">
        <b>{r.question}</b>
        <button className="btn ghost sm" onClick={copyAll} title="Copy answer and sources">Copy</button>
      </div>
      <div className="badges">
        {r.heard && <span className="badge heard">Heard in meeting</span>}
        {a.mode === "ai" ? <span className="badge ai">AI answer · {a.model}</span> : <span className="badge">From the code · no AI</span>}
        <span className={`badge ${a.confidence}`}>Match: {a.confidence}</span>
        <span className="badge">{r.ms} ms search</span>
        {(r.ai === "searching" || r.ai === "writing") && (
          <span className="ai-wait"><span className="spinner" />{r.ai === "searching" ? "Searching deeper…" : "Writing answer…"}</span>
        )}
        {r.ai === "error" && <span className="badge Low" title={r.aiError}>AI failed: {r.aiError?.slice(0, 90)}</span>}
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
      {cited.length > 0 && <p className="section-label">Sources</p>}
      {cited.map(renderSrc)}
      {other.length > 0 && (
        <>
          <button className="btn ghost sm more" onClick={() => setShowOther((s) => !s)}>
            {showOther ? "Hide" : "Show"} {other.length} other match{other.length > 1 ? "es" : ""}
          </button>
          {showOther && other.map(renderSrc)}
        </>
      )}
    </article>
  );
}
