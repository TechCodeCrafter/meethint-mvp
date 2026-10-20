"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildIndex, search, mergeAdjacent, correctTerms, tokenize, expandQuery, type Hit, type Index, type CodeFile } from "@/lib/search";
import { extractiveAnswer, type Answer } from "@/lib/answer";
import { buildTrace, getGraph, traceHits, traceText, traceAnswer, isFlowQuestion, isNonEvidence, type Trace } from "@/lib/trace";
import { loadGitHub, loadUploaded, filesFromDrop } from "@/lib/loaders";
import { DEMO_FILES } from "@/lib/demo";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { runTask } from "@/lib/ai-core";
import { transcribe as sttDirect } from "@/lib/stt";
import { findDuplicate } from "@/lib/dedupe";
import { splitTldr } from "@/lib/tldr";
import { verifyCitations } from "@/lib/verify";
import { updateMomentum, momentumBoost, type Momentum } from "@/lib/momentum";
import { Mic, Stop, Github, Folder, FileIcon, Code, Sparkle, Gear, X, Copy, Check, External, Chevron, Search, Sun, Moon, Lock, Arrow, Monitor, Layers, Reply, Menu, Bolt } from "./icons";
import { Listener, BrowserSpeech, NoAudioError, canCaptureMeetingAudio, hasBrowserSpeech, heuristicQuestions, type ListenMode } from "@/lib/listen";

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
  trace?: Trace;
  /** Streaming AI answer text shown while the model is still writing. */
  draft?: string;
  /** Where the AI call went: straight to the provider from this browser, or via the self-host server. */
  via?: "direct" | "server";
};

type Seg = { id: number; text: string; at: number; q?: boolean };
type Detected = { id: number; q: string; answered: boolean; at: number; resultId?: number; repeats?: number };

const EXAMPLE_REPOS = ["sindresorhus/ky", "expressjs/express", "vercel/swr", "supabase/supabase-js"];
const DEMO_QUESTIONS = [
  "How does the payment retry logic work?",
  "Where do we store user preferences?",
  "What's the current rate limit on the checkout endpoint?",
];
const ACCEPT =
  ".zip,.pdf,.docx,.pptx,.xlsx,.xls,.ods,.odt,.odp,.rtf,.epub,.ipynb,.md,.mdx,.txt,.csv,.tsv,.json,.yaml,.yml,.toml,.xml,.html,.sql,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.cpp,.h,.cs,.php,.sh,.vue,.svelte,.css,.scss,.prisma,.graphql,.proto,.tf,.env.example,*";


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
  const [speaking, setSpeaking] = useState(false);
  const [pending, setPending] = useState(0);
  const [notice, setNotice] = useState("");
  const [engineLabel, setEngineLabel] = useState("");
  const [detected, setDetected] = useState<Detected[]>([]);
  const [autoAnswer, setAutoAnswer] = useState(true);
  const [listenError, setListenError] = useState("");
  const [meetingCapable, setMeetingCapable] = useState(true);
  const listenerRef = useRef<{ stop: () => void } | null>(null);
  const segsRef = useRef<Seg[]>([]);
  const detectedRef = useRef<Detected[]>([]);
  const momentumRef = useRef<Momentum>(new Map());
  const autoRef = useRef(autoAnswer);
  autoRef.current = autoAnswer;
  const transcriptBox = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!listening && !detected.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [listening, detected.length]);

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

  /** Your key never touches this site's server: with a key, calls go browser → provider directly.
   *  Without one, the self-host relay is used only if the server has its own env key. */
  const aiVia = (): "direct" | "server" => (apiKey.trim() ? "direct" : "server");
  async function aiCall(body: Record<string, unknown>, o: { onText?: (s: string) => void; signal?: AbortSignal } = {}) {
    const b = { ...body, provider, model: model || undefined };
    if (apiKey.trim()) return runTask(b, { key: apiKey.trim(), onText: o.onText });
    if (!server.server.includes(provider)) throw new Error("Add an API key in AI settings.");
    const res = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), signal: o.signal });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "AI request failed");
    return j;
  }

  // ---------- index ----------
  const rebuild = useCallback((list: Source[]) => {
    const multi = list.length > 1;
    const files = list.flatMap((s) => s.files.map((f) => ({ ...f, src: multi ? s.label : undefined, key: undefined })));
    const idx = files.length ? buildIndex(files) : null;
    indexRef.current = idx;
    // Warm the call graph for Trace mode in the background so the first "how does X work" is fast.
    if (idx) {
      const idle = (window as any).requestIdleCallback || ((f: () => void) => setTimeout(f, 200));
      idle(() => { if (indexRef.current === idx) try { getGraph(idx); } catch {} });
    }
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
    // Heard questions lean on what the meeting has been discussing (transcript momentum).
    const boost = opts.heard ? momentumBoost(momentumRef.current) : undefined;
    let hits = search(idx, q, 8, boost?.size ? { boost, boostFactor: 1.3 } : {});
    let answer = extractiveAnswer(q, hits.slice(0, 6));
    // Trace mode: "how does X work / what calls / which file drives" -> follow the call path in the code.
    let trace: Trace | null = null;
    let hopCount = 0;
    if (isFlowQuestion(q)) {
      try { trace = buildTrace(idx, q, hits); } catch (e) { console.warn("trace failed", e); }
      if (trace && trace.hops.length < 2 && !trace.stops.length && !trace.uncalled.length) trace = null;
    }
    if (trace) {
      const th = traceHits(idx, trace);
      hopCount = th.length;
      const extra = hits.filter((h) => !th.some((t) => t.key === h.key && !(h.start > t.end + 5 || h.end < t.start - 5))).slice(0, 3);
      hits = [...th, ...extra];
      const ta = traceAnswer(trace);
      answer = {
        answer: ta.answer,
        keyPoints: ta.keyPoints,
        confidence: trace.stops.length || !trace.entry ? "Medium" : "High",
        mode: "extractive",
        cited: th.map((_, i) => i + 1),
        path: trace.hops.map((h, i) => ({ step: STEP_LABEL[h.kind], text: codeify(h.label), cite: i + 1, verified: true })),
        openFirst: trace.openFirst ? { file: trace.openFirst.path, why: trace.openFirst.why } : undefined,
      };
    }
    const ms = Math.round(performance.now() - t0);
    const id = nextId.current++;
    const useAI = aiReady;
    setResults((r) => [{ id, question: q, hits: trace ? hits : hits.slice(0, 6), answer, ms, ai: useAI ? (trace ? "writing" : "searching") : "off", heard: opts.heard, trace: trace || undefined, via: useAI ? aiVia() : undefined }, ...r]);
    if (!opts.heard) setQuestion("");
    if (!useAI) return;

    if (trace) {
      try {
        const snippets = hits.map((h, i) => {
          const lines = idx.byKey.get(h.key)!.content.split(/\r?\n/);
          const start = Math.max(1, h.start - 2);
          const end = Math.min(lines.length, h.end + 2);
          return { n: i + 1, path: (h.src && !h.path.startsWith(h.src + "/") ? h.src + "/" : "") + h.path, start, end, code: lines.slice(start - 1, end).join("\n"), focus: h.focus, hop: h.hop, also: alsoLines(lines, start, end) };
        });
        const j = await aiCall(
          { task: "trace", question: q, snippets, trace: traceText(trace, (i) => i + 1), layout: projectLayout(idx), fixes: correctTerms(idx, q) },
          { onText: (d) => d && patch(id, { draft: d }) },
        );
        // Check every step's citation: it must point at a traced hop whose cited lines perform an action.
        const path = (j.path || []).map((p: { step: string; text: string; cite?: number }) => {
          const h = p.cite ? hits[p.cite - 1] : undefined;
          const evidence = !!h && p.cite! <= hopCount && (h.hop === "prompt" || (h.focus || []).some((ln) => !isNonEvidence(idx.byKey.get(h.key)!.content.split(/\r?\n/)[ln - 1] || "")));
          return { ...p, verified: evidence };
        });
        const unverifiedSteps = path.filter((p: { verified: boolean }) => !p.verified).length;
        const unverifiedClaims = verifyCitations([j.answer || "", j.other || ""], (n) => {
          const h = hits[n - 1];
          return h ? { path: h.path, content: idx.byKey.get(h.key)!.content } : undefined;
        });
        patch(id, {
          ai: "done",
          draft: undefined,
          answer: {
            answer: j.answer || answer.answer,
            keyPoints: [],
            path: path.length ? path : answer.path,
            other: j.other || "",
            openFirst: j.openFirst || answer.openFirst,
            confidence: unverifiedSteps || unverifiedClaims.length ? downgrade(j.confidence) : j.confidence,
            unverified: unverifiedClaims,
            cited: [...new Set([...(path.map((p: { cite?: number }) => p.cite).filter(Boolean) as number[]), ...(j.cited || [])])],
            mode: "ai",
            model: j.model,
          },
        });
      } catch (e: any) {
        patch(id, { ai: "error", aiError: e.message, draft: undefined });
      }
      return;
    }

    try {
      // Step 1: let the model suggest identifiers + likely files, then search again.
      let merged = hits;
      try {
        const paths = idx.files.map((f) => f.path).slice(0, 2500);
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 6000);
        const ex = await Promise.race([
          aiCall({ task: "expand", question: q, paths, fixes: correctTerms(idx, q) }, { signal: ctl.signal }),
          new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("timeout")))),
        ]);
        clearTimeout(to);
        if (ex.terms?.length || ex.paths?.length) {
          const h2 = search(idx, q, 10, { extra: (ex.terms || []).join(" "), boost: new Set(ex.paths || []) });
          const seen = new Set<string>();
          merged = [...h2, ...hits].filter((h) => {
            const k = `${h.key}:${Math.floor(h.start / 20)}`;
            return seen.has(k) ? false : (seen.add(k), true);
          }).slice(0, 10);
          merged = mergeAdjacent(idx, merged);
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
        return { n: i + 1, path: (h.src && !h.path.startsWith(h.src + "/") ? h.src + "/" : "") + h.path, loc: h.loc, start, end, code: lines.slice(start - 1, end).join("\n"), also: alsoLines(lines, start, end) };
      });
      const fixes = correctTerms(idx, q);
      const j = await aiCall(
        { task: "answer", question: q, snippets, context: opts.context, layout: projectLayout(idx), fixes },
        { onText: (d) => d && patch(id, { draft: d }) },
      );
      // Free lexical check: every backticked name/value in a cited sentence must be in that source.
      const unverified = verifyCitations([j.answer || "", ...(j.keyPoints || [])], (n) => {
        const h = merged[n - 1];
        return h ? { path: h.path, content: idx.byKey.get(h.key)!.content } : undefined;
      });
      patch(id, {
        ai: "done",
        draft: undefined,
        answer: { answer: j.answer, keyPoints: j.keyPoints, confidence: unverified.length ? downgrade(j.confidence) : j.confidence, cited: j.cited, mode: "ai", model: j.model, unverified },
      });
    } catch (e: any) {
      patch(id, { ai: "error", aiError: e.message, draft: undefined });
    }
  }
  const askRef = useRef(ask);
  askRef.current = ask;

  // ---------- listening ----------
  async function onHeard(raw: string) {
    const text = cleanTranscript(raw);
    if (!text) return;
    const seg: Seg = { id: Date.now() + Math.random(), text, at: Date.now(), q: /\?/.test(text) };
    const earlier = segsRef.current.slice(-8).map((s) => s.text).join(" ");
    segsRef.current = [...segsRef.current, seg].slice(-80);
    setSegs(segsRef.current);
    // Warm retrieval on every segment: track which files the conversation is touching.
    if (indexRef.current && text.split(/\s+/).length >= 4) {
      try {
        const h = search(indexRef.current, text, 4, { noSplit: true });
        momentumRef.current = updateMomentum(momentumRef.current, h.filter((x) => x.score > 0.5).map((x) => x.path));
      } catch {}
    }
    let qs: string[] = [];
    if (aiReady) {
      try {
        const j = await aiCall({ task: "detect", earlier, latest: text, already: detectedRef.current.slice(-8).map((d) => d.q), vocab: indexRef.current ? projectNames(indexRef.current) : "" });
        qs = j.questions || heuristicQuestions(text);
      } catch {
        qs = heuristicQuestions(text);
      }
    } else qs = heuristicQuestions(text);
    if (qs.length) {
      segsRef.current = segsRef.current.map((x) => (x.id === seg.id ? { ...x, q: true } : x));
      setSegs(segsRef.current);
    }
    for (let q of qs) {
      // Fuzzy de-dupe: same question re-asked or re-transcribed within 90s → bump a counter, don't re-answer.
      const dup = findDuplicate(q, detectedRef.current, Date.now());
      if (dup >= 0) {
        detectedRef.current = detectedRef.current.map((d, i) => (i === dup ? { ...d, repeats: (d.repeats || 1) + 1, at: Date.now() } : d));
        setDetected([...detectedRef.current]);
        continue;
      }
      q = q.charAt(0).toUpperCase() + q.slice(1);
      const d: Detected = { id: Date.now() + Math.random(), q, answered: false, at: Date.now() };
      if (autoRef.current && indexRef.current) {
        d.answered = true;
        d.resultId = nextId.current;
        askRef.current(q, { heard: true, context: earlier + " " + text });
      } else {
        setQuestion(q);
      }
      detectedRef.current = [...detectedRef.current, d].slice(-20);
      setDetected([...detectedRef.current]);
    }
  }
  const onHeardRef = useRef(onHeard);
  onHeardRef.current = onHeard;

  async function startEngine(m: ListenMode) {
    // Microphone: prefer the browser's live speech recognition (words appear as they're spoken).
    // If a transcription key is available, use it (most reliable); otherwise the free browser engine.
    if (m === "mic" && !stt) {
      const b = new BrowserSpeech({
        onText: (t) => {
          setInterim("");
          onHeardRef.current(t);
        },
        onInterim: (t) => {
          setInterim(t);
          setSpeaking(!!t);
        },
        onError: setListenError,
        onEnd: () => setListening(false),
        onFatal: (code) => {
          setInterim("");
          setSpeaking(false);
          setListening(false);
          listenerRef.current = null;
          if (code !== "audio-capture") setShowAI(true);
          setListenError(
            code === "audio-capture"
              ? "No microphone was found. Check that a mic is connected and allowed for this site (click the icon in the address bar)."
              : `Your browser's free speech service isn't available here (Brave, Arc and some Chromium browsers block it, or the network does). To fix it: ${
                  aiReady && provider !== "openai" && provider !== "groq"
                    ? `${PROVIDERS[provider].label} can't transcribe audio, so open AI settings and paste an OpenAI or Groq key into the “Transcription key” field`
                    : "open AI settings and add an OpenAI or Groq key"
                } — transcription then runs through that key and works in any browser. Or open this page in Google Chrome.`
          );
        },
      });
      b.start();
      listenerRef.current = b;
      setEngineLabel("Live browser speech recognition (microphone)");
      return;
    }
    if (!stt) throw new Error("Listening to meeting audio needs a transcription key (OpenAI or Groq) — open AI settings. Or switch to “My microphone” to use free live browser speech recognition.");
    const l = new Listener({
      mode: m,
      transcribe: async (blob) => {
        const fd = new FormData();
        fd.append("file", blob, "seg.webm");
        fd.append("provider", stt.provider);
        // Own key: straight to the provider from this browser. No key: self-host relay with the server's env key.
        if (stt.key) return sttDirect({ provider: stt.provider, key: stt.key, file: blob });
        const r = await fetch("/api/transcribe", { method: "POST", body: fd });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Transcription failed");
        return j.text || "";
      },
      onText: (t) => onHeardRef.current(t),
      onLevel: setLevel,
      onStatus: (st) => {
        setSpeaking(st.speaking);
        setPending(st.pending);
      },
      onError: (msg) => setListenError(msg),
      onEnd: () => {
        setListening(false);
        setLevel(0);
      },
    });
    await l.start();
    listenerRef.current = l;
    setEngineLabel(`${m === "mic" ? "Microphone" : m === "both" ? "Meeting audio + mic" : "Meeting audio"} · ${stt.provider === "groq" ? "Groq Whisper" : "OpenAI"} transcription`);
  }

  async function startListening() {
    setListenError("");
    setNotice("");
    setShowAI(false);
    try {
      try {
        await startEngine(mode);
      } catch (e) {
        if (!(e instanceof NoAudioError)) throw e;
        // Common on macOS when sharing a window/screen: fall back to the microphone.
        setNotice(
          "That share had no audio (common on Mac when sharing a window or the whole screen), so I switched to your microphone — it hears the meeting through your speakers (don't use headphones). For the cleanest audio, share the meeting's Chrome tab with “Also share tab audio” on."
        );
        await startEngine("mic");
      }
      setListening(true);
      setTimeout(() => document.querySelector(".listen")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
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
    setSpeaking(false);
    setPending(0);
  }

  function answerDetected(d: Detected) {
    const rid = nextId.current;
    detectedRef.current = detectedRef.current.map((x) => (x.id === d.id ? { ...x, answered: true, resultId: rid } : x));
    setDetected(detectedRef.current);
    ask(d.q, { heard: true, context: segsRef.current.slice(-8).map((s) => s.text).join(" ") });
  }

  function scrollToResult(id?: number) {
    if (!id) return;
    document.getElementById(`r-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const latestHeard = detected.length ? detected[detected.length - 1] : null;
  const latestResult = latestHeard?.resultId ? results.find((r) => r.id === latestHeard.resultId) : undefined;
  const suggestions = sources.some((s) => s.kind === "demo") ? DEMO_QUESTIONS : [];
  const engine = stt ? `${stt.provider === "groq" ? "Groq Whisper" : "OpenAI"} transcription` : hasBrowserSpeech() ? "free browser speech (mic only)" : "no speech engine";

  // ---------- UI-only state ----------
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [ghOpen, setGhOpen] = useState(false);
  const [listenSetup, setListenSetup] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const dragDepth = useRef(0);

  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: light)");
    setTheme(m.matches ? "light" : "dark");
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (listening) setStartedAt(Date.now());
  }, [listening]);

  // Drop files anywhere on the page
  useEffect(() => {
    const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    };
    const over = (e: DragEvent) => isFiles(e) && e.preventDefault();
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      handleFilesRef.current(await filesFromDrop(e.dataTransfer!));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const handleFilesRef = useRef(handleFiles);
  handleFilesRef.current = handleFiles;

  // Keyboard shortcuts: ⌘K or / focus · L listen · Esc close
  const kbRef = useRef<(e: KeyboardEvent) => void>(() => {});
  kbRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      qRef.current?.focus();
      return;
    }
    if (e.key === "Escape") {
      setShowAI(false);
      setListenSetup(false);
      setGhOpen(false);
      setNavOpen(false);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") {
      e.preventDefault();
      qRef.current?.focus();
    } else if (e.key.toLowerCase() === "l" && hasSource) {
      e.preventDefault();
      listening ? stopListening() : setListenSetup(true);
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => kbRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // auto-grow question box
  useEffect(() => {
    const el = qRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(180, el.scrollHeight) + "px";
  }, [question]);

  const elapsed = listening ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const showLive = listening || segs.length > 0;
  const modeInfo: Record<ListenMode, { title: string; desc: string; icon: React.ReactNode }> = {
    meeting: { title: "Meeting audio", desc: "Share the Meet / Teams / Zoom tab with “Also share tab audio”. Best quality.", icon: <Monitor size={20} /> },
    both: { title: "Meeting audio + my mic", desc: "Also catches questions you ask out loud.", icon: <Layers size={20} /> },
    mic: { title: "My microphone", desc: "Hears the room or your speakers. Works anywhere.", icon: <Mic size={20} /> },
  };

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`}>
      {/* ================= SIDEBAR ================= */}
      <aside className="side" aria-label="Knowledge sources">
        <div className="side-top">
          <div className="brand">
            <span className="logo" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4" /></svg>
            </span>
            <div>
              <div className="brand-name">Code Meeting Answerer</div>
              <div className="brand-sub">Live answers from your code</div>
            </div>
          </div>
          <button className="icon-btn only-mobile" onClick={() => setNavOpen(false)} aria-label="Close sources"><X /></button>
        </div>

        <div className="side-section">
          <div className="side-label">
            <span>Knowledge</span>
            {hasSource && <span className="count">{totals.files.toLocaleString()} files</span>}
          </div>

          {sources.length === 0 && !progress && <p className="side-empty">Nothing connected yet. Add a repo, folders, files or docs.</p>}

          <ul className="src-list">
            {sources.map((s) => (
              <li key={s.id} className="src-item">
                <span className={`src-ico ${s.kind}`}>{s.kind === "github" ? <Github size={15} /> : s.kind === "demo" ? <Sparkle size={15} /> : <Folder size={15} />}</span>
                <div className="src-body">
                  <div className="src-name" title={s.label}>{s.label}</div>
                  <div className="src-meta">
                    {s.files.length.toLocaleString()} files{s.docs ? ` · ${s.docs} docs` : ""}
                    {s.ref ? ` · ${s.ref}` : ""}
                    {s.truncated ? " · partial" : ""}
                  </div>
                </div>
                <button className="icon-btn sm" onClick={() => removeSource(s.id)} aria-label={`Remove ${s.label}`} title="Remove"><X size={14} /></button>
              </li>
            ))}
          </ul>

          {progress && (
            <div className="side-progress" role="status">
              <div className="bar"><i style={{ width: `${progress.pct}%` }} /></div>
              <span>{progress.msg}</span>
            </div>
          )}
          {loadError && <div className="alert danger sm" role="alert">{loadError}<button className="icon-btn sm" onClick={() => setLoadError("")} aria-label="Dismiss"><X size={13} /></button></div>}

          <div className="add-grid">
            <button className={`add-btn ${ghOpen ? "active" : ""}`} onClick={() => setGhOpen((o) => !o)} disabled={!!progress}>
              <Github size={16} /> GitHub repo
            </button>
            <button className="add-btn" onClick={() => folderRef.current?.click()} disabled={!!progress}>
              <Folder size={16} /> Folder
            </button>
            <button className="add-btn" onClick={() => filesRef.current?.click()} disabled={!!progress}>
              <FileIcon size={16} /> Files & docs
            </button>
            <button className="add-btn" onClick={loadDemo} disabled={!!progress}>
              <Sparkle size={16} /> Demo
            </button>
          </div>
          <input ref={folderRef} type="file" multiple hidden onChange={(e) => handleFiles([...(e.target.files || [])])} />
          <input ref={filesRef} type="file" multiple hidden accept={ACCEPT} onChange={(e) => handleFiles([...(e.target.files || [])])} />

          {ghOpen && (
            <form className="gh-form" onSubmit={(e) => { e.preventDefault(); connectGitHub(); setGhOpen(false); }}>
              <input
                autoFocus
                className="field mono"
                placeholder="owner/repo or GitHub URL"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                aria-label="GitHub repository"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <input className="field mono" type="password" autoComplete="off" placeholder="Token for private repos (optional)" value={ghToken} onChange={(e) => setGhToken(e.target.value)} aria-label="GitHub token" />
              <button className="btn primary block" disabled={!repoInput.trim()}>Connect repository</button>
              <div className="gh-try">
                {EXAMPLE_REPOS.map((r) => (
                  <button type="button" key={r} className="tiny-chip" onClick={() => { connectGitHub(r); setGhOpen(false); }}>{r}</button>
                ))}
              </div>
            </form>
          )}
          <p className="side-hint">Drop folders, files, PDFs or .zip anywhere on the page. Dependencies and build folders are skipped.</p>
        </div>

        <div className="side-bottom">
          <button className={`ai-card ${aiReady ? "on" : ""}`} onClick={() => setShowAI(true)}>
            <span className="ai-dot" />
            <div>
              <div className="ai-title">{aiReady ? `AI answers on` : "AI answers off"}</div>
              <div className="ai-sub">{aiReady ? `${PROVIDERS[provider].label}${stt ? " · transcription ready" : ""}` : "Add a key for written answers & listening"}</div>
            </div>
            <Gear size={16} />
          </button>
          <div className="side-foot">
            <span><Lock size={13} /> Session only · nothing saved</span>
            <button className="icon-btn sm" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} aria-label="Toggle theme" title="Toggle theme">
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
          </div>
        </div>
      </aside>
      {navOpen && <div className="scrim only-mobile" onClick={() => setNavOpen(false)} />}

      {/* ================= MAIN ================= */}
      <main className="main">
        <div className="mobile-bar only-mobile">
          <button className="icon-btn" onClick={() => setNavOpen(true)} aria-label="Open sources"><Menu /></button>
          <span className="brand-name">Code Meeting Answerer</span>
          <button className="icon-btn" onClick={() => setShowAI(true)} aria-label="AI settings"><Gear /></button>
        </div>

        <div className="main-inner">
          {/* ---------- Command bar ---------- */}
          <div className={`command ${hasSource ? "" : "disabled"} ${listening ? "is-live" : ""}`}>
            <div className="command-row">
              <Search size={20} className="command-ico" />
              <textarea
                ref={qRef}
                rows={1}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
                placeholder={hasSource ? "Ask anything about the code or docs…" : "Connect a repo or drop files to start"}
                aria-label="Question"
                disabled={!hasSource}
              />
              <button
                className={`listen-btn ${listening ? "live" : ""}`}
                onClick={() => (listening ? stopListening() : setListenSetup(true))}
                disabled={!hasSource}
                aria-label={listening ? "Stop listening" : "Listen to meeting"}
                title={listening ? "Stop listening (L)" : "Listen to meeting (L)"}
              >
                {listening ? <><span className="live-dot" />{mmss}<Stop size={14} /></> : <><Mic size={18} /><span className="hide-sm">Listen</span></>}
              </button>
              <button className="answer-btn" onClick={() => ask()} disabled={!hasSource || !question.trim()}>
                Answer <Arrow size={16} />
              </button>
            </div>
            <div className="command-foot">
              {suggestions.length > 0 && !results.length ? (
                <div className="sugs">
                  {suggestions.map((s) => (
                    <button key={s} className="sug" onClick={() => ask(s)}>{s}</button>
                  ))}
                </div>
              ) : (
                <span className="keys hide-sm"><kbd>Enter</kbd> answer <kbd>⌘K</kbd> focus <kbd>L</kbd> listen</span>
              )}
              <span className="mode-pill">{aiReady ? <><Sparkle size={13} /> AI</> : <><Bolt size={13} /> Instant · no AI</>}</span>
            </div>
          </div>

          {/* ---------- Listen setup sheet ---------- */}
          {listenSetup && !listening && (
            <div className="sheet" role="dialog" aria-label="Start listening">
              <div className="sheet-head">
                <div>
                  <h2>Listen to the meeting</h2>
                  <p>Questions are transcribed live, shown on screen, and answered from your code.</p>
                </div>
                <button className="icon-btn" onClick={() => setListenSetup(false)} aria-label="Close"><X /></button>
              </div>
              <div className="mode-grid" role="radiogroup">
                {(["meeting", "both", "mic"] as ListenMode[]).filter((m) => meetingCapable || m === "mic").map((m) => (
                  <button key={m} role="radio" aria-checked={mode === m} className={`mode-card ${mode === m ? "sel" : ""}`} onClick={() => setMode(m)}>
                    <span className="mode-ico">{modeInfo[m].icon}</span>
                    <span className="mode-title">{modeInfo[m].title}</span>
                    <span className="mode-desc">{modeInfo[m].desc}</span>
                  </button>
                ))}
              </div>
              {mode !== "mic" && (
                <div className="how">
                  <span className="how-n">1</span> Pick the <b>Chrome Tab</b> with your call
                  <span className="how-n">2</span> Turn on <b>Also share tab audio</b>
                  <span className="how-n">3</span> Click <b>Share</b>
                </div>
              )}
              {!stt && (
                <div className="alert warn sm">
                  {mode === "mic" ? "Using free browser speech. For best accuracy (and Brave / Arc), add an OpenAI or Groq key." : "Meeting audio needs an OpenAI or Groq key for transcription."}
                  <button className="link" onClick={() => setShowAI(true)}>Add key</button>
                </div>
              )}
              <div className="sheet-foot">
                <label className="switch">
                  <input type="checkbox" checked={autoAnswer} onChange={(e) => setAutoAnswer(e.target.checked)} />
                  <span className="track"><i /></span>
                  Auto-answer questions
                </label>
                <button className="btn primary lg" onClick={() => { setListenSetup(false); startListening(); }}>
                  <Mic size={18} /> Start listening
                </button>
              </div>
            </div>
          )}

          {notice && <div className="alert warn" role="status">{notice}<button className="icon-btn sm" onClick={() => setNotice("")} aria-label="Dismiss"><X size={13} /></button></div>}
          {listenError && <div className="alert danger" role="alert">{listenError}<button className="icon-btn sm" onClick={() => setListenError("")} aria-label="Dismiss"><X size={13} /></button></div>}

          {/* ---------- Live panel ---------- */}
          {showLive && (
            <section className={`live ${listening ? "on" : ""}`} aria-label="Live meeting">
              <header className="live-head">
                <div className="live-left">
                  {listening ? <span className="live-badge"><span className="live-dot" />LIVE</span> : <span className="live-badge off">PAUSED</span>}
                  <span className="live-engine">{listening ? engineLabel : "Listening stopped"}</span>
                </div>
                <div className="live-right">
                  {listening && (
                    <span className={`vu ${speaking ? "speaking" : ""}`} aria-hidden>
                      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                        <i key={i} style={{ transform: `scaleY(${0.2 + Math.min(1, level * (1.5 - Math.abs(3 - i) * 0.25) + (speaking ? 0.25 : 0)) * 0.8})` }} />
                      ))}
                    </span>
                  )}
                  <span className="live-state">{listening ? (pending > 0 ? "Transcribing…" : speaking ? "Hearing speech" : "Listening") : ""}</span>
                  <label className="switch sm" title="Auto-answer detected questions">
                    <input type="checkbox" checked={autoAnswer} onChange={(e) => setAutoAnswer(e.target.checked)} />
                    <span className="track"><i /></span>
                    <span className="hide-sm">Auto-answer</span>
                  </label>
                  {listening ? (
                    <button className="btn danger sm" onClick={stopListening}><Stop size={12} /> Stop</button>
                  ) : (
                    <button className="btn sm" onClick={() => setListenSetup(true)}><Mic size={14} /> Resume</button>
                  )}
                </div>
              </header>

              <div className="live-body">
                <div className="transcript" ref={transcriptBox} aria-live="polite">
                  {segs.length === 0 && !interim && (
                    <div className="t-empty">
                      <span className="pulse-ring"><Mic size={18} /></span>
                      <p>Waiting for speech…</p>
                      <span>Words appear here as people talk. Questions get highlighted.</span>
                    </div>
                  )}
                  {segs.slice(-40).map((s) => (
                    <p key={s.id} className={`t-line ${s.q ? "q" : ""}`}>
                      <time>{clock(s.at)}</time>
                      <span>{s.text}</span>
                    </p>
                  ))}
                  {interim && (
                    <p className="t-line interim"><time>{clock(now)}</time><span>{interim}<i className="caret" /></span></p>
                  )}
                  {pending > 0 && !interim && <p className="t-line interim"><time>{clock(now)}</time><span className="dots"><i /><i /><i /></span></p>}
                </div>

                <div className="heard">
                  {latestHeard ? (
                    <div className="heard-card" key={latestHeard.id}>
                      <div className="heard-top">
                        <span className="heard-tag">Question heard</span>
                        <span className="heard-time">{timeAgo(latestHeard.at, now)}</span>
                      </div>
                      <p className="heard-q">{latestHeard.q}{(latestHeard.repeats || 1) > 1 && <span className="repeat-badge" title="Asked again — merged, not re-answered">×{latestHeard.repeats}</span>}</p>
                      {latestResult ? (
                        <>
                          {latestResult.ai === "searching" || latestResult.ai === "writing" ? (
                            <div className="thinking"><span className="spinner" />{latestResult.ai === "searching" ? "Searching your code…" : "Writing answer…"}</div>
                          ) : null}
                          <p className="heard-a">{renderInline(citeOrder(latestResult).remap(latestResult.answer.answer), () => scrollToResult(latestResult.id))}</p>
                          <button className="btn ghost sm" onClick={() => scrollToResult(latestResult.id)}>Sources & code <Chevron size={14} /></button>
                        </>
                      ) : (
                        <button className="btn primary" onClick={() => answerDetected(latestHeard)}>Answer this <Arrow size={15} /></button>
                      )}
                    </div>
                  ) : (
                    <div className="heard-empty">
                      <Sparkle size={18} />
                      <p>Questions about the project will pop up here — with the answer.</p>
                    </div>
                  )}
                  {detected.length > 1 && (
                    <div className="earlier">
                      {[...detected].reverse().slice(1, 5).map((d) => (
                        <button key={d.id} className="earlier-item" onClick={() => (d.answered ? scrollToResult(d.resultId) : answerDetected(d))}>
                          <span>{d.q}{(d.repeats || 1) > 1 && <span className="repeat-badge">×{d.repeats}</span>}</span>
                          {d.answered ? <Chevron size={14} /> : <span className="tiny-chip">Answer</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* ---------- Empty / onboarding ---------- */}
          {!hasSource && !progress && (
            <section className="hero">
              <span className="eyebrow"><span className="live-dot static" /> Built for live meetings</span>
              <h1>Someone asks about the code.<br /><em>You answer in seconds.</em></h1>
              <p className="lead">Connect a repo or drop your files. Ask, or let it listen to the call. Answers come from the actual code, with the exact file, lines and page.</p>
              <div className="start-grid">
                <button className="start-card" onClick={() => setGhOpen(true)}>
                  <span className="start-ico"><Github size={22} /></span>
                  <span className="start-title">Connect GitHub</span>
                  <span className="start-desc">Any public repo in one click, private with a token.</span>
                </button>
                <button className="start-card" onClick={() => folderRef.current?.click()}>
                  <span className="start-ico"><Folder size={22} /></span>
                  <span className="start-title">Upload a folder</span>
                  <span className="start-desc">Code, PDF, Word, slides, sheets. Read in your browser.</span>
                </button>
                <button className="start-card" onClick={loadDemo}>
                  <span className="start-ico"><Sparkle size={22} /></span>
                  <span className="start-title">Try the demo</span>
                  <span className="start-desc">A sample SaaS codebase with ready-made questions.</span>
                </button>
              </div>
              <ol className="flow">
                <li><span>1</span>Connect code & docs</li>
                <li><span>2</span>Ask or listen</li>
                <li><span>3</span>Answer with exact sources</li>
              </ol>
            </section>
          )}

          {/* ---------- Answers feed ---------- */}
          <div className="feed" aria-live="polite">
            {results.map((r, i) => (
              <AnswerCard key={r.id} r={r} latest={i === 0} multi={sources.length > 1} onFollow={(q) => { setQuestion(q); qRef.current?.focus(); }} />
            ))}
            {hasSource && !results.length && !showLive && (
              <div className="feed-empty">
                <div className="fe-ico"><Code size={20} /></div>
                <p><b>Ready.</b> {totals.files.toLocaleString()} files · {totals.lines.toLocaleString()} lines indexed{totals.docs ? ` · ${totals.docs} documents` : ""}.</p>
                <span>Type a question above, or press <kbd>L</kbd> to listen to the meeting.</span>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ================= SETTINGS MODAL ================= */}
      {showAI && (
        <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && setShowAI(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="AI settings">
            <div className="modal-head">
              <div>
                <h2>AI & transcription</h2>
                <p>Optional. Without a key, answers come straight from matching code, instantly, and nothing leaves your browser.</p>
              </div>
              <button className="icon-btn" onClick={() => setShowAI(false)} aria-label="Close"><X /></button>
            </div>
            <div className="modal-body">
              <label className="lbl">AI provider</label>
              <div className="seg">
                {(Object.keys(PROVIDERS) as ProviderId[]).map((p) => (
                  <button key={p} className={provider === p ? "sel" : ""} onClick={() => setProvider(p)}>{PROVIDERS[p].label}</button>
                ))}
              </div>
              <label className="lbl" htmlFor="k">API key</label>
              <input id="k" className="field" type="password" autoComplete="off" placeholder={server.server.includes(provider) ? "Using server key (optional override)" : `${PROVIDERS[provider].label} API key`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label="API key" />
              <label className="lbl" htmlFor="m">Model <span className="opt">optional</span></label>
              <input id="m" className="field" placeholder={`Default: ${PROVIDERS[provider].model}`} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" />

              <div className="keypath" aria-label="Where your key goes">
                <div className="kp-title"><Lock size={13} /> Where your key goes</div>
                {apiKey.trim() || !server.server.includes(provider) ? (
                  <>
                    <div className="kp-flow">
                      <span>This tab&apos;s memory</span><Arrow size={13} /><code>{new URL(PROVIDERS[provider].base).host}</code>
                    </div>
                    <p>
                      Your browser sends the key straight to {PROVIDERS[provider].label}. This site&apos;s server never receives it: its AI routes refuse any request that carries a key,
                      and the page&apos;s security policy only allows connections to AI providers and GitHub. Check it yourself in DevTools → Network.
                      Nothing is saved; closing the tab forgets it.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="kp-flow">
                      <span>This site&apos;s server key</span><Arrow size={13} /><code>{new URL(PROVIDERS[provider].base).host}</code>
                    </div>
                    <p>No key needed: this deployment has its own {PROVIDERS[provider].label} key, so questions and code snippets go through this server to the provider. Add your own key to go direct.</p>
                  </>
                )}
                <p className="kp-self">Want to trust no one? <a href="https://github.com/TechCodeCrafter/meethint-mvp#self-host" target="_blank" rel="noreferrer">Self-host it</a>: one <code>npm run dev</code> or a Vercel deploy.</p>
              </div>

              <div className="divider" />
              <label className="lbl">Transcription for listening</label>
              <p className="help">
                {provider === "openai" || provider === "groq"
                  ? "Uses the key above automatically. Add a different one below only if you want."
                  : `${PROVIDERS[provider].label} can't transcribe audio. Add an OpenAI or Groq key here to listen to meetings.`}
              </p>
              <div className="seg">
                <button className={sttProvider === "openai" ? "sel" : ""} onClick={() => setSttProvider("openai")}>OpenAI</button>
                <button className={sttProvider === "groq" ? "sel" : ""} onClick={() => setSttProvider("groq")}>Groq Whisper</button>
              </div>
              <input className="field" type="password" autoComplete="off" placeholder="Transcription key (optional)" value={sttKey} onChange={(e) => setSttKey(e.target.value)} aria-label="Transcription key" />
            </div>
            <div className="modal-foot">
              <span className="status-line">
                <span className={`ai-dot ${aiReady ? "on" : ""}`} /> {aiReady ? "AI answers on" : "AI answers off"} · {stt ? "transcription ready" : "free browser speech only"}
              </span>
              <span className="help"><Lock size={12} /> Keys stay in this tab&apos;s memory and go direct to the provider.</span>
              <button className="btn primary" onClick={() => setShowAI(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* ================= DROP OVERLAY ================= */}
      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <div className="drop-box">
            <Folder size={34} />
            <h3>Drop to add</h3>
            <p>Folders, code, PDFs, Word, slides, sheets or .zip</p>
          </div>
        </div>
      )}
    </div>
  );
}

function clock(t: number) {
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function timeAgo(t: number, now: number) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

/** Other lines in the file that use the same config/env names as the snippet (e.g. a second BRIDGE_PORT default). */
function alsoLines(lines: string[], start: number, end: number) {
  const snippet = lines.slice(start - 1, end).join("\n");
  const names = new Set<string>();
  for (const m of snippet.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g)) names.add(m[0]);
  if (!names.size) return [];
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length && out.length < 10; i++) {
    if (i >= start - 1 && i < end) continue;
    const l = lines[i];
    for (const n of names) if (l.includes(n)) { out.push({ line: i + 1, text: l.trim().slice(0, 200) }); break; }
  }
  return out;
}

/** Compact folder map so the model knows which directories are separate components. */
function projectLayout(idx: Index) {
  const count = new Map<string, number>();
  for (const f of idx.files) {
    const parts = ((f.src && !f.path.startsWith(f.src + "/") ? f.src + "/" : "") + f.path).split("/");
    for (let d = 1; d <= Math.min(3, parts.length - 1); d++) {
      const k = parts.slice(0, d).join("/") + "/";
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  return [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => a[0].localeCompare(b[0])).slice(0, 120).map(([k, n]) => `${k} (${n})`).join("\n");
}

/** Folder and file names, used to fix mis-heard names in the transcript. */
function projectNames(idx: Index) {
  const names = new Set<string>();
  for (const f of idx.files) {
    const parts = f.path.split("/");
    parts.slice(0, -1).forEach((p) => p.length > 2 && !p.startsWith(".") && names.add(p));
    const base = parts[parts.length - 1].replace(/\.[a-z0-9]+$/i, "");
    if (base.length > 3) names.add(base);
    if (names.size > 300) break;
  }
  return [...names].join(", ").slice(0, 3000);
}

/** Wrap function calls, routes and file names in backticks for display. */
function codeify(t: string) {
  return t
    .replace(/\b(GET|POST|PUT|PATCH|DELETE|WS|ANY) (\/[^\s,;)]*)/g, "`$1 $2`")
    .replace(/(^|[\s(])([A-Za-z_$][\w$.]*\(\))/g, "$1`$2`")
    .replace(/(^|\s)([\w-]+\.(?:py|ts|tsx|js|vue|md)(?::\d+)?)/g, "$1`$2`")
    .replace(/"([\w-]+)"/g, "`\"$1\"`");
}

const STEP_LABEL: Record<string, string> = { ui: "UI", client: "Client", api: "API", service: "Service", runtime: "Runtime", store: "Store", prompt: "Prompt" };

const HALLUCINATIONS = /^(thank you( so much)?( for watching)?|thanks for watching|please subscribe|subtitles? by.*|you|bye|\.+|okay\.?|so\.?|um+\.?|uh+\.?)[.!\s]*$/i;
/** Drop transcription noise: echoed term lists, repeated phrases, and common silent-audio hallucinations. */
function cleanTranscript(raw: string) {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t || HALLUCINATIONS.test(t)) return "";
  const words = t.split(" ");
  const commas = (t.match(/,/g) || []).length;
  // "provider, ws_client, __init__, client, config, ..." — a list of identifiers, not speech
  if (words.length >= 6 && commas / words.length > 0.35) return "";
  const codey = words.filter((w) => /[_/]|[a-z][A-Z]|^Terms:/.test(w)).length;
  if (words.length >= 6 && codey / words.length > 0.4) return "";
  if (/^Software project meeting\. Terms:/i.test(t)) return "";
  // the same short phrase repeated over and over
  const uniq = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (words.length >= 12 && uniq.size / words.length < 0.25) return "";
  return t;
}

function renderInline(text: string, onCite: (n: number) => void) {
  const parts = text.split(/(`[^`]+`|\[\d+(?:\s*,\s*\d+)*\])/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
    const m = p.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (m)
      return (
        <span key={i} className="cites">
          {m[1].split(/\s*,\s*/).map((n) => (
            <a key={n} href="#" className="cite" onClick={(e) => { e.preventDefault(); onCite(Number(n)); }} aria-label={`Source ${n}`}>{n}</a>
          ))}
        </span>
      );
    return <span key={i}>{p}</span>;
  });
}

/** Number cited sources 1..n in the order they appear in the answer; other matches continue after. */
function citeOrder(r: Result) {
  const a = r.answer;
  const total = r.hits.length;
  const appear: number[] = [];
  const txt = [...(a.path || []).map((p) => (p.cite ? `[${p.cite}]` : "")), a.answer, ...a.keyPoints, a.other || ""].join(" ");
  for (const m of txt.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) for (const n of m[1].split(/\s*,\s*/).map(Number)) if (n >= 1 && n <= total && !appear.includes(n)) appear.push(n);
  let citedOrig: number[];
  if (a.mode === "ai") {
    citedOrig = [...appear];
    for (const n of a.cited || []) if (n >= 1 && n <= total && !citedOrig.includes(n)) citedOrig.push(n);
    if (!citedOrig.length) citedOrig = r.hits.slice(0, 3).map((_, i) => i + 1);
  } else if (a.path?.length) citedOrig = [...appear];
  else citedOrig = r.hits.slice(0, 4).map((_, i) => i + 1);
  if (r.trace) {
    // trace mode: sources follow the hop order, then anything else that was cited
    const hopN = r.trace.hops.length;
    citedOrig = [...Array.from({ length: Math.min(hopN, total) }, (_, i) => i + 1), ...citedOrig.filter((n) => n > hopN)];
  }
  const rest = r.hits.map((_, i) => i + 1).filter((n) => !citedOrig.includes(n));
  const map = new Map<number, number>();
  [...citedOrig, ...rest].forEach((o, i) => map.set(o, i + 1));
  const remap = (t: string) =>
    t.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, g: string) =>
      g.split(/\s*,\s*/).map(Number).filter((n) => map.has(n)).map((n) => `[${map.get(n)}]`).join("")
    );
  return {
    cited: citedOrig.map((o) => ({ h: r.hits[o - 1], n: map.get(o)! })),
    other: rest.map((o) => ({ h: r.hits[o - 1], n: map.get(o)! })),
    remap,
  };
}

/** Path for display: drop a leading folder that just repeats the source name. */
function downgrade(c: Answer["confidence"]): Answer["confidence"] {
  return c === "High" ? "Medium" : "Low";
}

function shortPath(h: Hit) {
  if (h.src && h.path.startsWith(h.src + "/")) return h.path.slice(h.src.length + 1);
  return h.path;
}

function AnswerCard({ r, multi, latest, onFollow }: { r: Result; multi: boolean; latest: boolean; onFollow: (q: string) => void }) {
  const refs = useRef<Record<number, HTMLDivElement | null>>({});
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [showOther, setShowOther] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  // TL;DR first: every card opens collapsed; details, steps text and code are one tap away.
  const isExpanded = expanded ?? false;
  const termSet = useMemo(() => new Set(expandQuery(r.question).filter((t) => t.original).map((t) => t.term)), [r.question]);
  const a = r.answer;
  const { cited, other, remap } = citeOrder(r);
  const isOpen = (n: number) => !!open[n];
  const loading = r.ai === "searching" || r.ai === "writing";

  const cite = (n: number) => {
    setExpanded(true);
    if (!cited.some((x) => x.n === n)) setShowOther(true);
    setOpen((o) => ({ ...o, [n]: true }));
    setTimeout(() => {
      const el = refs.current[n];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.animate([{ boxShadow: "0 0 0 2px var(--accent)" }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1400 });
      }
    }, 40);
  };
  const copyAll = () => {
    const txt = `Q: ${r.question}\n\n${remap(a.answer)}\n\n${(a.path || []).map((p, i) => `${i + 1}. ${p.step}: ${remap(p.text)}`).join("\n")}${a.other ? "\n" + remap(a.other) : ""}${a.openFirst ? `\nOpen first: ${a.openFirst.file}` : ""}\n${a.keyPoints.map((k) => "- " + remap(k)).join("\n")}\n\nSources:\n${cited.map(({ h, n }) => `[${n}] ${shortPath(h)}${h.loc ? ` (${h.loc})` : ""}:${h.start}-${h.end}`).join("\n")}`;
    navigator.clipboard?.writeText(txt.replace(/`/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const renderSrc = ({ h, n }: { h: Hit; n: number }) => (
    <div className={`source ${isOpen(n) ? "open" : ""}`} key={n} ref={(el) => { refs.current[n] = el; }}>
      <button className="source-row" onClick={() => setOpen((o) => ({ ...o, [n]: !isOpen(n) }))} aria-expanded={isOpen(n)}>
        <span className="cite static">{n}</span>
        {h.hop && <span className={`hop-chip k-${h.hop}`}>{STEP_LABEL[h.hop]}</span>}
        <span className="source-ico">{h.doc ? <FileIcon size={15} /> : <Code size={15} />}</span>
        <span className="source-path">
          {multi && h.src ? <span className="dim">{h.src} › </span> : null}
          {shortPath(h).includes("/") ? <span className="dim">{shortPath(h).slice(0, shortPath(h).lastIndexOf("/") + 1)}</span> : null}
          <b>{h.path.split("/").pop()}</b>
        </span>
        <span className="source-loc">{h.loc ? h.loc : `L${h.start}–${h.end}`}</span>
        <Chevron size={15} className="chev" />
      </button>
      {isOpen(n) && (
        <div className="source-code">
          <div className="code-actions">
            <button className="btn ghost xs" onClick={() => navigator.clipboard?.writeText(`${h.path}${h.loc ? ` (${h.loc})` : ""}:${h.start}-${h.end}`)}><Copy size={12} /> Path</button>
            <button className="btn ghost xs" onClick={() => navigator.clipboard?.writeText(h.code)}><Copy size={12} /> Code</button>
            {h.origin && !h.doc && (
              <a className="btn ghost xs" target="_blank" rel="noreferrer" href={`https://github.com/${h.origin.owner}/${h.origin.repo}/blob/${h.origin.sha}/${h.path}#L${h.start}-L${h.end}`}><External size={12} /> GitHub</a>
            )}
          </div>
          <pre className={`code ${h.doc ? "doc" : ""}`}>
            {h.code.split("\n").map((l, j) => {
              const hit = h.focus ? h.focus.includes(h.start + j) : tokenize(l).some((t) => termSet.has(t));
              return (
                <div key={j} className={`ln ${hit ? "hit" : ""}`}>
                  <span>{h.start + j}</span>
                  <span>{l || " "}</span>
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );

  return (
    <article className="answer" id={`r-${r.id}`}>
      <header className="answer-head">
        <div className="answer-tags">
          {r.heard ? <span className="tag heard"><Mic size={12} /> Heard in meeting</span> : <span className="tag">Asked</span>}
          {r.trace && <span className="tag tracetag"><Layers size={12} /> Trace</span>}
          {a.mode === "ai" ? <span className="tag ai" title={r.via === "direct" ? "Sent from your browser straight to the provider. This site's server never saw your key." : "Answered by this site's own server key (self-host relay)."}><Sparkle size={12} /> {a.model}{r.via === "direct" && <Lock size={11} />}</span> : <span className="tag"><Bolt size={12} /> From the code</span>}
          <span className={`tag conf ${a.confidence}`}><i />{a.confidence} match</span>
          <span className="tag dim">{r.ms} ms</span>
        </div>
        <div className="answer-actions">
          <button className="icon-btn sm" onClick={() => onFollow(`${r.question} — follow-up: `)} title="Ask a follow-up" aria-label="Ask a follow-up"><Reply size={15} /></button>
          <button className="icon-btn sm" onClick={copyAll} title="Copy answer & sources" aria-label="Copy answer">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
        </div>
      </header>
      <h3 className="answer-q">{r.question}</h3>

      {loading && a.mode !== "ai" && !r.draft && (
        <div className="thinking"><span className="spinner" />{r.ai === "searching" ? "Searching deeper…" : "Writing a clear answer…"}<span className="shimmer" /></div>
      )}
      {(() => {
        const streaming = !!r.draft && a.mode !== "ai" && r.draft.length > 24;
        const [tldr, rest] = splitTldr(remap(streaming ? r.draft! : a.answer));
        return (
          <div className={`answer-body ${streaming ? "streaming" : ""}`}>
            <p className={`answer-text tldr ${loading && a.mode !== "ai" && !streaming ? "pending" : ""}`}>
              {renderInline(tldr, cite)}
              {streaming && !rest && <span className="acaret" />}
            </p>
            {rest && (isExpanded || streaming) && (
              <p className="answer-text rest">{renderInline(rest, cite)}{streaming && <span className="acaret" />}</p>
            )}
            {rest && !isExpanded && !streaming && (
              <button className="tldr-more" onClick={() => setExpanded(true)}>Read more</button>
            )}
          </div>
        );
      })()}
      {a.unverified && a.unverified.length > 0 && (
        <div className="verify-note" title={a.unverified.map((u) => `[${u.n}] missing: ${u.terms.join(", ")}`).join("\n")}>
          <span className="tag warn">Check</span>
          {a.unverified.length === 1 ? "1 claim names" : `${a.unverified.length} claims name`} something its cited source doesn&apos;t contain:{" "}
          {a.unverified.slice(0, 3).flatMap((u) => u.terms).slice(0, 4).map((t, i) => <code key={i}>{t}</code>)}
        </div>
      )}
      {r.ai === "error" && <div className="alert danger sm">AI couldn&apos;t answer: {r.aiError?.slice(0, 160)}. Showing the instant answer from the code.</div>}

      {a.path && a.path.length > 0 && (
        <ol className={`trace ${isExpanded ? "" : "compact"}`}>
          {(isExpanded ? a.path : a.path.slice(0, 4)).map((p, i) => {
            const h = p.cite ? r.hits[p.cite - 1] : undefined;
            const kind = (h?.hop || p.step || "").toLowerCase();
            const line = h ? (h.focus?.find((x) => x !== h.start) ?? h.focus?.[0] ?? h.start) : 0;
            return (
              <li key={i} className={`trace-step k-${kind}`}>
                <span className="trace-rail"><i /></span>
                <div className="trace-body">
                  <div className="trace-top">
                    <span className={`hop-chip k-${kind}`}>{p.step}</span>
                    {h && (
                      <button className="trace-file" onClick={() => p.cite && cite(p.cite)} title="Show the code">
                        <span className="cite static">{remap(`[${p.cite}]`).replace(/[\[\]]/g, "")}</span>
                        {h.path.split("/").pop()}<span className="dim">:{line}</span>
                      </button>
                    )}
                    {p.verified === false && <span className="tag warn" title="This step's citation doesn't point at traced code that performs the action">Not verified</span>}
                  </div>
                  {isExpanded && <div className="trace-text">{renderInline(remap(p.text), cite)}</div>}
                </div>
              </li>
            );
          })}
          {!isExpanded && a.path.length > 4 && <li className="trace-more">+{a.path.length - 4} more steps</li>}
        </ol>
      )}
      {isExpanded && a.other && <p className="trace-other">{renderInline(remap(a.other), cite)}</p>}
      {isExpanded && r.trace && r.trace.stops.length > 0 && a.mode === "ai" && (
        <div className="trace-stop"><span>Trace stops</span>{r.trace.stops[0]}</div>
      )}
      {a.openFirst && (
        <div className="open-first">
          <span className="of-label">Open first</span>
          <code>{a.openFirst.file}</code>
          {a.openFirst.why && <span className="of-why">{renderInline(a.openFirst.why, cite)}</span>}
          <button className="icon-btn sm" onClick={() => navigator.clipboard?.writeText(a.openFirst!.file)} title="Copy path" aria-label="Copy path"><Copy size={13} /></button>
        </div>
      )}

      {!isExpanded && a.path && a.path.length > 0 && (
        <button className="more-btn" onClick={() => setExpanded(true)}>Show steps &amp; code <Chevron size={13} /></button>
      )}

      {isExpanded && a.keyPoints.length > 0 && (
        <ul className="points">
          {a.keyPoints.map((k, i) => (
            <li key={i}>{renderInline(remap(k), cite)}</li>
          ))}
        </ul>
      )}

      {!isExpanded && cited.length > 0 && !a.path?.length && (
        <button className="collapsed-src" onClick={() => setExpanded(true)}>
          <span className="collapsed-files">
            {cited.slice(0, 3).map(({ h, n }) => (
              <span key={n} className="mini-src"><span className="cite static">{n}</span>{h.path.split("/").pop()}</span>
            ))}
          </span>
          <span className="collapsed-more">{a.keyPoints.length ? "Details & code" : "Show code"} <Chevron size={13} /></span>
        </button>
      )}

      {isExpanded && cited.length > 0 && (
        <div className="sources">
          <div className="sources-label">Sources</div>
          {cited.map(renderSrc)}
          {other.length > 0 && (
            <>
              <button className="more-btn" onClick={() => setShowOther((s) => !s)}>
                {showOther ? "Hide" : "Show"} {other.length} more match{other.length > 1 ? "es" : ""} <Chevron size={13} style={{ transform: showOther ? "rotate(180deg)" : "none" }} />
              </button>
              {showOther && other.map(renderSrc)}
            </>
          )}
        </div>
      )}
    </article>
  );
}
