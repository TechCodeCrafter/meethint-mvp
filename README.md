# MeetHint (Code Meeting Answerer)

Answer questions about your codebase live in a meeting, with the exact files and line numbers as proof. No login, no database, no history: everything lives in the current browser tab.

Hosted: https://code-meeting-answerer.vercel.app

## Your key, your browser

- **With your own key:** the browser calls the AI provider directly (`api.openai.com`, `api.anthropic.com`, `api.x.ai` or `api.groq.com`). This site's server never receives the key or your code.
- **Server routes refuse keys:** `/api/ai` and `/api/transcribe` reject any request that includes an API key. They only work as a relay for keys that a self-hoster sets in the server environment.
- **Locked connections:** a Content-Security-Policy (`next.config.mjs`) only allows connections to this origin, the four AI providers and GitHub.
- **Check it yourself:** open DevTools → Network while you ask a question.
- **Without a key:** answers come from local code search, and nothing leaves the tab.

Your key still sits in this page's memory, so you're trusting the JavaScript this site serves. If you'd rather not, self-host it.

## Self-host

Run it locally:

```bash
git clone https://github.com/TechCodeCrafter/meethint-mvp
cd meethint-mvp
npm install
npm run dev        # http://localhost:3000
```

Or deploy your own copy to Vercel: run `vercel deploy`, or import the repo in the Vercel dashboard.

Optional server keys let your team use AI without anyone pasting a key. They're read only on the server and never sent to the browser:

```bash
OPENAI_API_KEY=...      # answers + meeting transcription
ANTHROPIC_API_KEY=...
XAI_API_KEY=...
GROQ_API_KEY=...        # answers + Whisper transcription
```

## What it does

- **Sources:** a public or private GitHub repo, or uploaded folders, files and documents (PDF, DOCX, PPTX, XLSX, ZIP). Dependency and build folders are skipped.
- **Ask or listen:** type a question, or let it listen to the meeting (tab audio, microphone or both). Questions are detected in the transcript and answered automatically. Re-asked or re-transcribed questions within 90 seconds are merged, not answered twice.
- **Grounded answers, TL;DR first:** an instant answer from code-aware search appears right away. The AI write-up streams in on top of it (OpenAI, Anthropic, xAI or Groq). Every claim cites a file and line range.
- **Citation check:** every backticked name, path or value in a cited sentence must appear in the source it cites. If one doesn't, the answer is flagged and its confidence label drops one level.
- **Trace mode:** "how does X work" questions follow the call path through the code: UI function → request → API route → runtime → store or prompt. It shows which runtime the call selects and lists routes that exist but the UI no longer calls. It ends with the single file to open first.
- **Transcript momentum:** files the meeting keeps touching get a small boost, so vague follow-ups ("so how does that get retried?") land in the right place.

## How it works

| Piece | File | Notes |
|---|---|---|
| Search | `lib/search.ts` | BM25 over an inverted index of overlapping 40-line chunks, with identifier-aware tokens (camelCase and snake_case split), synonyms, mis-heard-name correction, and "X vs Y" split retrieval. |
| Trace | `lib/trace.ts` | Static call graph: defs, client requests and server routes for Python, JS/TS and Vue (FastAPI, Flask, Express, Next.js, WebSockets). |
| AI tasks | `lib/ai-core.ts` | Prompts and post-processing; runs in the browser or the server relay. |
| Providers | `lib/llm.ts`, `lib/stt.ts` | `fetch` calls to the providers with streaming. |
| UI | `app/page.tsx` | The app. |

On a 4,000-file repo (cal.com), warm search takes about 2–35 ms and a trace about 8–40 ms. The call graph is built in the background right after indexing.

## Tests

```bash
npm test     # node:test, ~50 golden cases for URL matching, def parsing, search, dedupe, citations
```

## License

MIT. See [LICENSE](LICENSE).
