// Live meeting audio capture.
// - "meeting": tab / window / screen audio via getDisplayMedia (Chrome/Edge desktop)
// - "both": meeting audio mixed with the local microphone
// - "mic": microphone only
// Audio is cut into short segments at natural pauses and sent for transcription.
// A free fallback uses the browser's built-in speech recognition (microphone only).

export type ListenMode = "meeting" | "both" | "mic";

export type ListenerOpts = {
  mode: ListenMode;
  transcribe: (blob: Blob) => Promise<string>;
  onText: (text: string) => void;
  onLevel?: (level: number) => void;
  onStatus?: (s: { speaking: boolean; pending: number }) => void;
  onError: (msg: string) => void;
  onEnd: () => void;
};

const MIN_SEG = 2500;
const MAX_SEG = 10000;
const QUIET_MS = 600;

export class NoAudioError extends Error {}

// Phrases speech models commonly hallucinate on silence/noise.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.|subtitles by.*|amara\.org.*|please subscribe.*|okay\.?)$/i;

export function canCaptureMeetingAudio() {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}

export function hasBrowserSpeech() {
  return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const m of c) if ((window as any).MediaRecorder?.isTypeSupported?.(m)) return m;
  return "";
}

export class Listener {
  private streams: MediaStream[] = [];
  private ctx: AudioContext | null = null;
  private rec: MediaRecorder | null = null;
  private timer: any = null;
  private stopped = false;
  private segStart = 0;
  private lastLoud = 0;
  private hadSpeech = false;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private speaking = false;
  private status() {
    this.o.onStatus?.({ speaking: this.speaking, pending: this.pending });
  }

  constructor(private o: ListenerOpts) {}

  async start() {
    const { mode } = this.o;
    let mixed: MediaStream;
    try {
      const parts: MediaStream[] = [];
      if (mode !== "mic") {
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as any,
          // @ts-ignore - Chrome hints
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
        } as any);
        this.streams.push(display);
        if (!display.getAudioTracks().length) {
          this.cleanup();
          throw new NoAudioError(
            "No audio was shared. Choose the meeting tab (Google Meet, Teams or Zoom web) and turn on “Also share tab audio”, or choose “Entire screen” and turn on “Also share system audio” (Windows / ChromeOS / recent macOS)."
          );
        }
        display.getVideoTracks().forEach((t) => (t.onended = () => this.stop()));
        display.getAudioTracks().forEach((t) => (t.onended = () => this.stop()));
        parts.push(display);
      }
      if (mode !== "meeting") {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.streams.push(mic);
        parts.push(mic);
      }
      this.ctx = new AudioContext();
      const dest = this.ctx.createMediaStreamDestination();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 1024;
      for (const p of parts) {
        const a = new MediaStream(p.getAudioTracks());
        const src = this.ctx.createMediaStreamSource(a);
        src.connect(dest);
        src.connect(analyser);
      }
      mixed = dest.stream;
      this.monitor(analyser);
    } catch (e: any) {
      this.cleanup();
      if (e?.name === "NotAllowedError") throw new Error("Permission was denied. Allow screen/tab or microphone access and try again.");
      throw e;
    }
    this.record(mixed);
  }

  private monitor(analyser: AnalyserNode) {
    const buf = new Float32Array(analyser.fftSize);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      this.o.onLevel?.(Math.min(1, rms * 8));
      if (rms > 0.012) {
        this.lastLoud = now;
        this.hadSpeech = true;
      }
      const sp = now - this.lastLoud < 500;
      if (sp !== this.speaking) {
        this.speaking = sp;
        this.status();
      }
      const el = now - this.segStart;
      if (this.rec?.state === "recording" && ((el > MIN_SEG && now - this.lastLoud > QUIET_MS && this.hadSpeech) || el > MAX_SEG)) {
        this.rec.stop(); // triggers next segment
      }
    }, 120);
  }

  private record(stream: MediaStream) {
    if (this.stopped) return;
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48000 } : undefined);
    this.rec = rec;
    const chunks: Blob[] = [];
    const speech = () => this.hadSpeech;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const had = speech();
      this.hadSpeech = false;
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (!this.stopped) this.record(stream);
      if (had && blob.size > 2000) {
        // transcribe in parallel, deliver in order
        this.pending++;
        this.status();
        const p = this.o.transcribe(blob).catch((e: any) => {
          this.o.onError(e.message || "Transcription failed");
          return "";
        });
        this.queue = this.queue.then(async () => {
          const t = (await p).trim();
          this.pending--;
          this.status();
          if (t && !HALLUCINATIONS.test(t)) this.o.onText(t);
        });
      }
    };
    this.segStart = performance.now();
    rec.start();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.rec?.state === "recording") this.rec.stop();
    } catch {}
    this.cleanup();
    this.o.onEnd();
  }

  private cleanup() {
    clearInterval(this.timer);
    this.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    this.streams = [];
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

/** Free fallback: browser speech recognition (microphone only, Chrome/Edge/Safari). */
export class BrowserSpeech {
  private r: any;
  private stopped = false;
  constructor(private o: { onText: (t: string) => void; onInterim?: (t: string) => void; onError: (m: string) => void; onEnd: () => void }) {}
  start() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) throw new Error("This browser has no built-in speech recognition. Use Chrome or Edge, or add an OpenAI/Groq key.");
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.o.onText(res[0].transcript.trim());
        else interim += res[0].transcript;
      }
      this.o.onInterim?.(interim);
    };
    r.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      this.o.onError(e.error === "not-allowed" ? "Microphone permission was denied." : `Speech recognition error: ${e.error}`);
    };
    r.onend = () => {
      if (!this.stopped) {
        try {
          r.start();
        } catch {}
      } else this.o.onEnd();
    };
    r.start();
    this.r = r;
  }
  stop() {
    this.stopped = true;
    try {
      this.r?.stop();
    } catch {}
  }
}

const Q_START = /^(how|what|what's|whats|where|where's|why|when|which|who|whose|can|could|does|do|did|is|are|was|were|will|would|should|have|has|any|so how|so what|so where|and how|and what|and where|but how|but what|quick question)\b/i;

/** Cheap question detection (used without an AI key). */
export function heuristicQuestions(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).length >= 4 && (s.endsWith("?") || Q_START.test(s)))
    .map((s) => s.replace(/^(so|and|but|okay|ok|um|uh|hey|right)[, ]+/i, "").replace(/[.]+$/, "?"))
    .map((s) => (s.endsWith("?") ? s : s + "?"));
}
