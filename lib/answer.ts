// Extractive answer: built only from retrieved code, no model involved.
import { expandQuery, tokenize, type Hit } from "./search";

export type Answer = {
  answer: string;
  keyPoints: string[];
  confidence: "High" | "Medium" | "Low";
  mode: "extractive" | "ai";
  model?: string;
  cited?: number[];
  path?: { step: string; text: string; cite?: number; verified?: boolean }[];
  other?: string;
  openFirst?: { file: string; why: string };
};

type Found = { text: string; path: string; line: number; score: number };

const DEF_PATTERNS: RegExp[] = [
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(<]/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_]\w*)/,
  /^\s*(?:public|private|protected|internal|static|override|async|final|\s)+[\w<>\[\],\s]*?\b([a-zA-Z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\{/,
  /^\s*(?:router|app|server|api)\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)/,
  /^\s*@(?:app|router|bp|api)\.(?:route|get|post|put|patch|delete)\(\s*['"]([^'"]+)/,
  /^\s*(?:export\s+)?(?:interface|type|struct|enum)\s+([A-Za-z_]\w*)/,
  /^\s*(?:CREATE\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)/i,
  /^\s*model\s+([A-Z]\w*)\s*\{/,
];
const NOT_FN = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "constructor", "super", "new", "await"]);

const VALUE_RE =
  /\b([A-Za-z_][\w.]*)\s*(?:[:=]|=>)\s*(-?\d[\d_.]*(?:\s*[*x]\s*\d[\d_.]*)*(?:\s*(?:ms|s|m|h))?|['"`][^'"`\n]{1,60}['"`]|true|false)\s*[,;)}]?\s*(?:\/\/.*|#.*)?$/;

const OBJ_RE = /\b([A-Za-z_]\w*)\s*:\s*(\{[^{}\n]{3,80}\})\s*,?\s*$/;

const STORAGE: [RegExp, string][] = [
  [/localStorage\.(setItem|getItem)|sessionStorage\./, "browser localStorage / sessionStorage"],
  [/AsyncStorage\./, "React Native AsyncStorage"],
  [/UserDefaults|@AppStorage/, "iOS UserDefaults"],
  [/SharedPreferences/, "Android SharedPreferences"],
  [/document\.cookie|cookies\(\)|res\.cookie\(|setCookie/, "cookies"],
  [/\.from\(\s*['"`](\w+)['"`]\s*\)/, "Supabase table"],
  [/prisma\.(\w+)\./, "Prisma model"],
  [/\.collection\(\s*['"`](\w+)['"`]/, "a document collection"],
  [/\b(?:INSERT\s+INTO|insert\s+into|UPDATE|update)\s+["`]?([a-z_][\w.]*)["`]?\s*(?:\(|SET\b|set\b|VALUES\b)/, "SQL table"],
  [/\bredis\b|\.hset\(|\.setex\(/i, "Redis"],
  [/\bfs\.(writeFile|appendFile)|writeFileSync/, "the filesystem"],
  [/\bs3\b.*put|PutObjectCommand/i, "S3 object storage"],
  [/mongoose\.model|new Schema\(/, "MongoDB (Mongoose)"],
  [/\.objects\.(create|update|filter)|models\.Model/, "the Django ORM"],
  [/ActiveRecord|\.save!?\b|has_many|belongs_to/, "ActiveRecord"],
  [/indexedDB|idb\./, "IndexedDB"],
];

function lineAt(h: Hit, i: number) {
  return h.start + i;
}

function cleanComment(l: string) {
  return l
    .trim()
    .replace(/^(\/\/+|#+|\/\*+|\*+\/?|"""|'''|--)\s?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/("""|\'\'\')\s*$/, "")
    .replace(/^@\w+\s*/, "")
    .trim();
}

function rel(path: string, a: number, b?: number) {
  return b && b !== a ? `\`${path}\` (lines ${a}–${b})` : `\`${path}\` (line ${a})`;
}

export function extractiveAnswer(question: string, hits: Hit[]): Answer {
  if (!hits.length)
    return {
      answer:
        "I couldn't find code that matches this question in the loaded files. Try different wording (use names you'd expect in the code, like a function or table name), or load the repo that contains it.",
      keyPoints: [],
      confidence: "Low",
      mode: "extractive",
    };

  const qTerms = expandQuery(question);
  const orig = new Set(qTerms.filter((t) => t.original).map((t) => t.term));
  const all = new Set(qTerms.map((t) => t.term));
  const overlap = (s: string) => {
    let o = 0;
    for (const t of new Set(tokenize(s))) if (orig.has(t)) o += 1;
      else if (all.has(t)) o += 0.4;
    return o;
  };

  const defs: Found[] = [];
  const values: Found[] = [];
  const comments: Found[] = [];
  const storage: Found[] = [];

  hits.forEach((h, hi) => {
    const weight = h.score * (1 - hi * 0.08);
    const lines = h.code.split("\n");
    lines.forEach((l, i) => {
      const ln = lineAt(h, i);
      for (const re of DEF_PATTERNS) {
        const m = l.match(re);
        if (m) {
          const name = m[2] ? `${m[1].toUpperCase()} ${m[2]}` : m[1];
          if (!name || NOT_FN.has(name)) continue;
          defs.push({ text: name, path: h.path, line: ln, score: weight * (0.5 + overlap(name + " " + l)) });
          break;
        }
      }
      const v = l.match(VALUE_RE);
      if (v && !/^\s*(import|from|require|#include|using)\b/.test(l)) {
        const name = v[1];
        const isConst = /^[A-Z][A-Z0-9_]{2,}$/.test(name.split(".").pop() || "");
        const ov = overlap(name);
        if (ov > 0 || isConst)
          values.push({ text: `${name} = ${v[2].trim()}`, path: h.path, line: ln, score: weight * (ov * 1.4 + overlap(l) * 0.3 + (isConst ? 0.5 : 0)) });
      }
      const o = l.match(OBJ_RE);
      if (o && /\d/.test(o[2])) {
        const ov = overlap(o[1]);
        values.push({ text: `${o[1]}: ${o[2].replace(/\s+/g, " ")}`, path: h.path, line: ln, score: weight * (ov * 1.6 + 0.2) });
      }
      const isC = (x?: string) => x !== undefined && /^\s*(\/\/|#(?!include|!|\[)|\*(?!\/)|\/\*|"""|'''|--\s)/.test(x);
      if (isC(l) && !isC(lines[i - 1])) {
        let c = cleanComment(l);
        for (let k = i + 1; k < Math.min(lines.length, i + 4) && isC(lines[k]); k++) {
          const nx = cleanComment(lines[k]);
          if (!nx) break;
          c += " " + nx;
        }
        c = c.replace(/\s+/g, " ").trim();
        if (c.length > 220) c = c.slice(0, 217) + "…";
        if (c.split(/\s+/).length >= 4 && !/eslint|prettier|ts-ignore|noqa|TODO:?\s*$/i.test(c)) {
          const ov = overlap(c);
          if (ov > 0) comments.push({ text: c, path: h.path, line: ln, score: weight * ov });
        }
      }
      for (const [re, label] of STORAGE) {
        const m = l.match(re);
        if (m) {
          const target = label.includes("table") || label.includes("model") || label.includes("collection") ? m[m.length - 1] : "";
          storage.push({
            text: target ? `${label} \`${target}\`` : label,
            path: h.path,
            line: ln,
            score: weight * (0.6 + overlap(l)),
          });
          break;
        }
      }
    });
  });

  const top = (arr: Found[], n: number) => {
    const seen = new Set<string>();
    return arr
      .sort((a, b) => b.score - a.score)
      .filter((f) => (seen.has(f.text) ? false : (seen.add(f.text), true)))
      .slice(0, n);
  };
  const tDefs = top(defs, 4);
  const tVals = top(values, 4);
  const tComments = top(comments, 3);
  const tStore = top(storage, 3);

  const q = question.toLowerCase();
  const isWhere = /\bwhere\b|\bwhich file\b|\blocated\b|\bdefined\b/.test(q);
  const isValue = /\bwhat('?s| is| are)? (the )?(current |default )?(value|rate|limit|timeout|max|min|number|count|size|ttl|port|url|version)|\bhow (many|much|long|often)\b|\bvalue\b|\blimit\b|\btimeout\b/.test(q);
  const isStore = /\bstor(e|ed|age)|\bsave[ds]?\b|\bpersist|\bkept\b|\bdatabase\b/.test(q);

  const h0 = hits[0];
  const others = hits.slice(1, 3).filter((h) => h.path !== h0.path);
  const inTop = defs.filter((d) => d.path === h0.path && d.line >= h0.start && d.line <= h0.end).sort((a, b) => b.score - a.score);
  const mainDef = inTop[0] || tDefs.find((d) => d.path === h0.path) || tDefs[0];

  const parts: string[] = [];
  if (h0.doc) {
    const lines = h0.code.split("\n");
    const ranked = lines
      .map((l, i) => ({ l: l.trim(), i, s: overlap(l) }))
      .filter((x) => x.s > 0 && !/^\[(Page|Slide|Sheet|Cell) /.test(x.l) && x.l.length > 3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2)
      .sort((a, b) => a.i - b.i);
    const where = `\`${h0.path}\`${h0.loc ? ` (${h0.loc})` : ""}`;
    if (ranked.length) {
      const quote = ranked.map((x) => x.l).join(" … ");
      parts.push(`From ${where}: “${quote.length > 400 ? quote.slice(0, 397) + "…" : quote}”`);
    } else parts.push(`The best match is ${where}.`);
    const rest = hits.slice(1, 3).filter((h) => h.path !== h0.path);
    if (rest.length) parts.push(`Also see ${rest.map((o) => `\`${o.path}\`${o.loc ? ` (${o.loc})` : ""}`).join(" and ")}.`);
    const coverage = orig.size ? h0.matched.filter((m) => orig.has(m)).length / orig.size : 0;
    return { answer: parts.join(" "), keyPoints: tVals.filter((v) => v.path === h0.path).slice(0, 3).map((v) => `\`${v.text}\``), confidence: coverage >= 0.66 ? "High" : coverage >= 0.34 ? "Medium" : "Low", mode: "extractive" };
  }
  if (isValue && tVals.length && tVals[0].score > 0.4) {
    const v = tVals[0];
    parts.push(`The current value is \`${v.text}\`, set in ${rel(v.path, v.line)}.`);
    if (tVals[1] && tVals[1].score > 0.3) parts.push(`Related: \`${tVals[1].text}\` in ${rel(tVals[1].path, tVals[1].line)}.`);
  } else if (isStore && tStore.length) {
    const s = tStore[0];
    parts.push(`It looks like this is stored in ${s.text}, written in ${rel(s.path, s.line)}.`);
    if (mainDef) parts.push(`The relevant code is \`${mainDef.text}\` in ${rel(mainDef.path, mainDef.line)}.`);
  } else if (isWhere) {
    parts.push(`The best match is ${rel(h0.path, h0.start, h0.end)}${mainDef ? `, around \`${mainDef.text}\`` : ""}.`);
  } else {
    parts.push(
      mainDef
        ? `This is handled by \`${mainDef.text}\` in ${rel(mainDef.path, mainDef.line)}; the relevant section is lines ${h0.start}–${h0.end}.`
        : `The most relevant section is ${rel(h0.path, h0.start, h0.end)}.`
    );
    const here = mainDef?.path || h0.path;
    const c = tComments.find((x) => x.path === here) || tComments[0];
    if (c) parts.push(c.path === here ? `The code comment there says: “${c.text}”` : `A comment in \`${c.path}\` says: “${c.text}”`);
  }
  const said = parts.join(" ");
  const rest = others.filter((o) => !said.includes(o.path));
  if (rest.length) parts.push(`Related code: ${rest.map((o) => `\`${o.path}\``).join(" and ")}.`);

  const kp: string[] = [];
  for (const d of tDefs.slice(0, 3)) kp.push(`\`${d.text}\` is defined at ${rel(d.path, d.line)}`);
  for (const v of tVals.slice(0, 3)) if (!parts[0].includes(v.text)) kp.push(`\`${v.text}\` at ${rel(v.path, v.line)}`);
  for (const s of tStore.slice(0, 2)) kp.push(`Storage: ${s.text} at ${rel(s.path, s.line)}`);
  for (const c of tComments.slice(0, 2)) if (!parts.join(" ").includes(c.text)) kp.push(`Comment: “${c.text}” at ${rel(c.path, c.line)}`);

  const coverage = orig.size ? hits[0].matched.filter((m) => orig.has(m)).length / orig.size : 0;
  const confidence = coverage >= 0.66 ? "High" : coverage >= 0.34 ? "Medium" : "Low";

  return { answer: parts.join(" "), keyPoints: kp.slice(0, 6), confidence, mode: "extractive" };
}
