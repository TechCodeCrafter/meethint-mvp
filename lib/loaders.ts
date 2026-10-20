import type { CodeFile } from "./search";

export const MAX_FILES = 1500;
export const MAX_FILE_BYTES = 400_000;
export const MAX_TOTAL_BYTES = 40_000_000;

const SKIP_DIR =
  /(^|\/)(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|\.turbo|\.vercel|\.cache|dist|build|out|coverage|vendor|target|bin|obj|Pods|DerivedData|__pycache__|\.venv|venv|env|\.idea|\.vscode|\.gradle|\.dart_tool|bower_components|jspm_packages|public\/static|storybook-static)(\/|$)/i;

const SKIP_FILE =
  /(\.min\.(js|css)|\.map|\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum|\.snap|\.pbxproj|\.xcuserstate|\.DS_Store)$/i;

const TEXT_EXT = new Set(
  (
    "js jsx ts tsx mjs cjs mts cts vue svelte astro py rb go rs java kt kts scala swift m mm h hpp hh c cc cpp cs fs php pl lua r dart ex exs erl elm clj cljs hs ml " +
    "sql prisma graphql gql proto thrift sh bash zsh ps1 bat yaml yml toml ini cfg conf env properties json json5 xml html htm css scss sass less " +
    "md mdx txt rst tf tfvars hcl dockerfile makefile gradle cmake nix sol move zig nim v vhd tex csv"
  ).split(" ")
);
const NAMED = /(^|\/)(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|Podfile|Brewfile|Justfile|\.env\.example|\.env\.sample|\.gitignore|\.dockerignore|\.editorconfig|\.nvmrc)$/i;

export function isIndexable(path: string, size?: number): boolean {
  if (SKIP_DIR.test(path) || SKIP_FILE.test(path)) return false;
  if (size !== undefined && size > MAX_FILE_BYTES) return false;
  if (NAMED.test(path)) return true;
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return !!m && TEXT_EXT.has(m[1]);
}

function looksBinary(s: string) {
  return s.slice(0, 2000).includes("\u0000");
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
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).message || "";
    } catch {}
    if (res.status === 404) throw new Error("Repository not found. Check the URL, or add a token for private repos.");
    if (res.status === 403 || res.status === 429)
      throw new Error(
        `GitHub rate limit hit (${detail || res.status}). Add a GitHub token in the field below, or wait a few minutes.`
      );
    if (res.status === 401) throw new Error("GitHub rejected the token. Check it has read access to this repo.");
    throw new Error(`GitHub error ${res.status}: ${detail}`);
  }
  return res.json();
}

export type LoadedRepo = {
  label: string;
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  files: CodeFile[];
  skipped: number;
  truncated: boolean;
};

export async function loadGitHub(input: string, token: string | undefined, onProgress: Progress): Promise<LoadedRepo> {
  const r = parseRepo(input);
  if (!r) throw new Error("Enter a GitHub URL like https://github.com/owner/repo or owner/repo.");
  onProgress("Looking up repository…", 2);
  const meta = await gh(`https://api.github.com/repos/${r.owner}/${r.repo}`, token);
  const ref = r.ref || meta.default_branch;
  onProgress(`Reading file tree on ${ref}…`, 6);
  const tree = await gh(
    `https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token
  );
  const sha: string = tree.sha;
  let blobs: { path: string; size: number }[] = (tree.tree || []).filter((t: any) => t.type === "blob");
  if (r.subpath) blobs = blobs.filter((b) => b.path.startsWith(r.subpath + "/"));
  const all = blobs.length;
  let wanted = blobs.filter((b) => isIndexable(b.path, b.size));
  // Prefer source over docs/tests if we must truncate
  wanted.sort((a, b) => rank(a.path) - rank(b.path));
  let truncated = !!tree.truncated;
  if (wanted.length > MAX_FILES) {
    wanted = wanted.slice(0, MAX_FILES);
    truncated = true;
  }
  let total = 0;
  wanted = wanted.filter((b) => (total += b.size) <= MAX_TOTAL_BYTES);

  const files: CodeFile[] = [];
  let done = 0;
  const queue = [...wanted];
  const workers = Array.from({ length: token ? 12 : 16 }, async () => {
    while (queue.length) {
      const b = queue.shift()!;
      try {
        const url = token
          ? `https://api.github.com/repos/${r.owner}/${r.repo}/contents/${encodePath(b.path)}?ref=${sha}`
          : `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${sha}/${encodePath(b.path)}`;
        const res = await fetch(url, token ? { headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${token}` } } : undefined);
        if (res.ok) {
          const text = await res.text();
          if (!looksBinary(text)) files.push({ path: b.path, content: text });
        }
      } catch {}
      done++;
      if (done % 5 === 0 || done === wanted.length)
        onProgress(`Downloading files ${done}/${wanted.length}…`, 8 + Math.round((done / Math.max(1, wanted.length)) * 85));
    }
  });
  await Promise.all(workers);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    label: `${r.owner}/${r.repo}${r.subpath ? "/" + r.subpath : ""}`,
    owner: r.owner,
    repo: r.repo,
    ref,
    sha,
    files,
    skipped: all - files.length,
    truncated,
  };
}

function rank(p: string) {
  if (/(^|\/)(test|tests|__tests__|spec|e2e|fixtures|examples?|docs?)\//i.test(p)) return 2;
  if (/\.(md|mdx|txt|json|ya?ml|lock|csv)$/i.test(p)) return 1;
  return 0;
}

function encodePath(p: string) {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Files from <input type=file> (folder or multi) or drag & drop, including .zip archives. */
export async function loadUploaded(list: File[], onProgress: Progress): Promise<{ files: CodeFile[]; skipped: number }> {
  const files: CodeFile[] = [];
  let skipped = 0;
  let i = 0;
  let total = 0;
  for (const f of list) {
    i++;
    const path = ((f as any).webkitRelativePath || (f as any).relPath || f.name).replace(/^\/+/, "");
    if (/\.zip$/i.test(f.name)) {
      onProgress(`Unpacking ${f.name}…`, 10);
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      const entries = Object.values(zip.files).filter((e) => !e.dir);
      // strip a single common root folder (GitHub zip downloads)
      const roots = new Set(entries.map((e) => e.name.split("/")[0]));
      const strip = roots.size === 1 && entries.every((e) => e.name.includes("/"));
      let j = 0;
      for (const e of entries) {
        j++;
        const p = strip ? e.name.split("/").slice(1).join("/") : e.name;
        if (!isIndexable(p) || files.length >= MAX_FILES) {
          skipped++;
          continue;
        }
        const text = await e.async("string");
        if (text.length > MAX_FILE_BYTES || looksBinary(text) || (total += text.length) > MAX_TOTAL_BYTES) {
          skipped++;
          continue;
        }
        files.push({ path: p, content: text });
        if (j % 25 === 0) onProgress(`Reading ${j}/${entries.length} from zip…`, 10 + Math.round((j / entries.length) * 85));
      }
      continue;
    }
    // strip the top folder name from webkitdirectory uploads
    const clean = (f as any).webkitRelativePath ? path.split("/").slice(1).join("/") || path : path;
    if (!isIndexable(clean, f.size) || files.length >= MAX_FILES || (total += f.size) > MAX_TOTAL_BYTES) {
      skipped++;
      continue;
    }
    const text = await f.text();
    if (looksBinary(text)) {
      skipped++;
      continue;
    }
    files.push({ path: clean, content: text });
    if (i % 25 === 0) onProgress(`Reading ${i}/${list.length} files…`, Math.round((i / list.length) * 95));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

/** Recursively collect files from a drag-and-drop DataTransfer (supports folders). */
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
      if (SKIP_DIR.test(prefix + entry.name)) return;
      const reader = entry.createReader();
      let batch: any[] = [];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      } while (batch.length);
    }
  }
  for (const e of items) await walk(e, "");
  // If a single folder was dropped, strip it as the root
  const roots = new Set(out.map((f) => ((f as any).relPath as string).split("/")[0]));
  if (items.length === 1 && items[0].isDirectory && roots.size === 1)
    out.forEach((f) => ((f as any).relPath = ((f as any).relPath as string).split("/").slice(1).join("/")));
  return out;
}
