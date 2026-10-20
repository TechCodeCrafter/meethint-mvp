# MeetHint MVP (Code Meeting Answerer)

Answer questions about your codebase live in meetings, with the exact files and line numbers as sources. No login and no database: everything stays in the browser session.

Live: https://code-meeting-answerer.vercel.app

## Features
- **Sources:** connect a public or private GitHub repo, or upload folders, files, and docs (PDF, DOCX, PPTX, XLSX, ZIP). Dependency and build folders are skipped.
- **Ask or listen:** type a question, or listen to the meeting (tab audio, mic, or both). Questions are detected in the live transcript and answered automatically.
- **Grounded answers:** code-aware BM25 retrieval plus an optional AI write-up (OpenAI, Anthropic, xAI, or Groq, using your own key). Every claim cites a source.
- **Trace mode:** for "how does X work" questions, it follows the call path in the code (UI → client request → API route → runtime → store/prompt). It shows which runtime the call selects, lists endpoints the UI no longer calls, checks citations, and names the one file to open first.

## Stack
Next.js 15 (App Router), React 19, TypeScript. Retrieval and tracing run in the browser (`lib/search.ts`, `lib/trace.ts`). The server routes in `app/api/*` only proxy AI and transcription calls.

## Run locally
```bash
npm install
npm run dev
```
Optional server-side keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`. Users can also paste a key in the app; it's kept in memory only.
