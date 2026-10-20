import type { CodeFile } from "./search";
import { docKind, extractDoc } from "./docs";

export const MAX_FILES = 4000;
export const MAX_TEXT_BYTES = 600_000;
export const MAX_DOC_BYTES = 30_000_000;
export const MAX_TOTAL_BYTES = 80_000_000;

// Any path segment matching these is skipped (dependencies, build output, caches, virtualenvs).
const SKIP_SEGMENT =
  /^(node_modules|bower_components|jspm_packages|vendor|third_party|site-packages|dist-packages|__pycache__|venv|virtualenv|env|\.?venv.*|.*-venv|.*_venv|dist|build|out|target|bin|obj|coverage|htmlcov|Pods|Carthage|DerivedData|storybook-static|\.next|\.nuxt|\.svelte-kit|\.turbo|\.vercel|\.cache|\.parcel-cache|\.gradle|\.dart_tool|\.terraform|\.serverless|\.aws-sam|cdk\.out|\.tox|\.nox|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.ipynb_checkpoints|\.idea|\.vscode|\.git|\.hg|\.svn|\.yarn|\.pnpm-store|\.expo|\.angular|logs?|tmp|temp)$/i;
const KEEP_HIDDEN = /^\.(github|gitlab|circleci|devcontainer|husky|cursor|claude|config)$/i;

const SKIP_FILE =
  /(\.min\.(js|css)|\.map|\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|go\.sum|\.snap|\.pbxproj|\.xcuserstate|\.DS_Store|_pb2\.pyi?|\.pb\.go|\.generated\.\w+|\.bundle\.js|\.chunk\.js)$/i;

const TEXT_EXT = new Set(
  (
    "js jsx ts tsx mjs cjs mts cts vue svelte astro py pyi rb go rs java kt kts scala swift m mm h hpp hh c cc cpp cs fs php pl lua r dart ex exs erl elm clj cljs hs ml " +
    "sql prisma graphql gql proto thrift sh bash zsh ps1 bat yaml yml toml ini cfg conf env properties json json5 jsonc xml html htm css scss sass less " +
    "md mdx txt rst adoc org tf tfvars hcl dockerfile makefile gradle cmake nix sol move zig nim v tex csv tsv log eml"
  ).split(" ")
);
const NAMED = /(^|\/)(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Podfile|Brewfile|Justfile|Jenkinsfile|\.env\.example|\.env\.sample|\.gitignore|\.dockerignore|\.editorconfig|\.nvmrc|CODEOWNERS)$/i;

export function skipPath(path: string): boolean {
  const segs = path.split("/");
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (SKIP_SEGMENT.test(s)) return true;
    if (s.startsWith(".") && !KEEP_HIDDEN.test(s)) return true;
  }
  return SKIP_FILE.test(path);
}

export function fileType(path: string): "text" | "doc" | null {
  if (skipPath(path)) return null;
  if (NAMED.test(path)) return "text";
  if (docKind(path)) return "doc";
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m && TEXT_EXT.has(m[1]) ? "text" : null;
}

function sizeOk(t: "text" | "doc", size: number) {
  return t === "doc" ? size <= MAX_DOC_BYTES : size <= MAX_TEXT_BYTES;
}

function looksBinary(s: string) {
  return s.slice(0, 2000).includes("\u0000");
}

/** Lower is better: source code first, then docs/config, then tests/examples. */
function rank(p: string) {
  if (/(^|\/)(test|tests|__tests__|spec|e2e|fixtures|examples?|samples?|benchmarks?|migrations)\//i.test(p)) return 3;
  if (/\.(json|ya?ml|csv|tsv|log|xml|lock)$/i.test(p)) return 2;
  if (/\.(md|mdx|txt|rst)$/i.test(p)) return 1;
  return 0;
}

export type RepoRef = { owner: string; repo: string; ref?: string; subpath?: string };

export function parseRepo(input: string): RepoRef | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  let m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.+))?)?/i);
  if (m) return { owner: m[1], repo: m[2], ref: m[3], subpath: m[4] };
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([^\s]+))?$/);
  if (m) return { owner: m[1], repo: m[2], ref: m[3] };
  return null;
}

type Progress = (msg: string, pct?: number) => void;

async function gh(url: string, token?: string) {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).message || "";
    } catch {}
    if (res.status === 404) throw new Error("Repository not found. Check the URL, or add a token for private repos.");
    if (res.status === 403 || res.status === 429)
      throw new Error(`GitHub rate limit hit (${detail || res.status}). Add a GitHub token, or wait a few minutes.`);
    if (res.status === 401) throw new Error("GitHub rejected the token. Check it has read access to this repo.");
    throw new Error(`GitHub error ${res.status}: ${detail}`);
  }
  return res.json();
}

export type LoadResult = { label: string; files: CodeFile[]; skipped: number; truncated: boolean; ref?: string };

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k], k);
      }
    })
  );
}

export async function loadGitHub(input: string, token: string | undefined, onProgress: Progress): Promise<LoadResult> {
  const r = parseRepo(input);
  if (!r) throw new Error("Enter a GitHub URL like https://github.com/owner/repo or owner/repo.");
  onProgress("Looking up repository…", 2);
  const meta = await gh(`https://api.github.com/repos/${r.owner}/${r.repo}`, token);
  const ref = r.ref || meta.default_branch;
  onProgress(`Reading file tree on ${ref}…`, 6);
  const tree = await gh(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token);
  const sha: string = tree.sha;
  let blobs: { path: string; size: number; t: "text" | "doc" }[] = (tree.tree || [])
    .filter((t: any) => t.type === "blob")
    .map((b: any) => ({ path: b.path, size: b.size, t: fileType(b.path) }));
  if (r.subpath) blobs = blobs.filter((b) => b.path.startsWith(r.subpath + "/"));
  const all = blobs.length;
  let wanted = blobs.filter((b) => b.t && sizeOk(b.t, b.size));
  wanted.sort((a, b) => rank(a.path) - rank(b.path));
  let truncated = !!tree.truncated;
  if (wanted.length > MAX_FILES) {
    wanted = wanted.slice(0, MAX_FILES);
    truncated = true;
  }
  let total = 0;
  wanted = wanted.filter((b) => (total += b.size) <= MAX_TOTAL_BYTES);

  const origin = { owner: r.owner, repo: r.repo, sha };
  const files: CodeFile[] = [];
  let done = 0;
  await pool(wanted, token ? 12 : 16, async (b) => {
    try {
      const url = token
        ? `https://api.github.com/repos/${r.owner}/${r.repo}/contents/${encodePath(b.path)}?ref=${sha}`
        : `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${sha}/${encodePath(b.path)}`;
      const res = await fetch(url, token ? { headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${token}` } } : undefined);
      if (res.ok) {
        if (b.t === "doc") {
          const text = await extractDoc(b.path, await res.arrayBuffer());
          if (text?.trim()) files.push({ path: b.path, content: text, origin, doc: true });
        } else {
          const text = await res.text();
          if (!looksBinary(text)) files.push({ path: b.path, content: text, origin });
        }
      }
    } catch {}
    done++;
    if (done % 5 === 0 || done === wanted.length)
      onProgress(`Downloading files ${done}/${wanted.length}…`, 8 + Math.round((done / Math.max(1, wanted.length)) * 88));
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { label: `${r.owner}/${r.repo}${r.subpath ? "/" + r.subpath : ""}`, ref, files, skipped: all - files.length, truncated };
}

function encodePath(p: string) {
  return p.split("/").map(encodeURIComponent).join("/");
}

type Entry = { path: string; size: number; t: "text" | "doc"; read: () => Promise<ArrayBuffer> };

function relPathOf(f: File): string {
  return ((f as any).relPath || (f as any).webkitRelativePath || f.name).replace(/^\/+/, "");
}

/** Files from pickers or drag & drop (folders, files, .zip archives, documents). */
export async function loadUploaded(list: File[], onProgress: Progress): Promise<LoadResult> {
  const entries: Entry[] = [];
  let seen = 0;
  for (const f of list) {
    const path = relPathOf(f);
    if (/\.zip$/i.test(f.name)) {
      onProgress(`Unpacking ${f.name}…`, 3);
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      const zs = Object.values(zip.files).filter((e) => !e.dir);
      const roots = new Set(zs.map((e) => e.name.split("/")[0]));
      const strip = roots.size === 1 && zs.every((e) => e.name.includes("/"));
      const base = f.name.replace(/\.zip$/i, "");
      for (const e of zs) {
        seen++;
        const inner = strip ? e.name.split("/").slice(1).join("/") : e.name;
        const t = fileType(inner);
        const size = (e as any)._data?.uncompressedSize ?? 0;
        if (!t || !sizeOk(t, size)) continue;
        entries.push({ path: list.length > 1 ? `${base}/${inner}` : inner, size, t, read: () => e.async("arraybuffer") });
      }
      continue;
    }
    seen++;
    const t = fileType(path);
    if (!t || !sizeOk(t, f.size)) continue;
    entries.push({ path, size: f.size, t, read: () => f.arrayBuffer() });
  }
  entries.sort((a, b) => rank(a.path) - rank(b.path));
  let truncated = false;
  let picked = entries;
  if (picked.length > MAX_FILES) {
    picked = picked.slice(0, MAX_FILES);
    truncated = true;
  }
  let total = 0;
  picked = picked.filter((e) => (total += e.size) <= MAX_TOTAL_BYTES || ((truncated = true), false));

  const files: CodeFile[] = [];
  let done = 0;
  await pool(picked, 8, async (e) => {
    try {
      const buf = await e.read();
      if (e.t === "doc") {
        onProgress(`Reading document ${e.path.split("/").pop()}…`);
        const text = await extractDoc(e.path, buf);
        if (text?.trim()) files.push({ path: e.path, content: text, doc: true });
      } else {
        const text = new TextDecoder().decode(buf);
        if (!looksBinary(text)) files.push({ path: e.path, content: text });
      }
    } catch (err) {
      console.warn("Could not read", e.path, err);
    }
    done++;
    if (done % 10 === 0 || done === picked.length) onProgress(`Reading ${done}/${picked.length} files…`, 5 + Math.round((done / picked.length) * 90));
  });
  files.sort((a, b) => a.path.localeCompare(b.path));

  const first = list[0];
  const root = relPathOf(first).split("/")[0];
  const label =
    list.length === 1
      ? first.name
      : relPathOf(first).includes("/") && list.every((f) => relPathOf(f).startsWith(root + "/"))
      ? root
      : `${files.length} uploaded files`;
  return { label, files, skipped: seen - files.length, truncated };
}

/** Recursively collect files from a drag-and-drop DataTransfer (supports folders). Keeps folder names. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].map((it) => (it as any).webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length) return [...dt.files];
  const out: File[] = [];
  async function walk(entry: any, prefix: string): Promise<void> {
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      (file as any).relPath = prefix + file.name;
      out.push(file);
    } else if (entry.isDirectory) {
      if (prefix && (SKIP_SEGMENT.test(entry.name) || (entry.name.startsWith(".") && !KEEP_HIDDEN.test(entry.name)))) return;
      const reader = entry.createReader();
      let batch: any[] = [];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      } while (batch.length);
    }
  }
  for (const e of items) await walk(e, "");
  return out;
}
