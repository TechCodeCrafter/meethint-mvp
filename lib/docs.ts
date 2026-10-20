// Text extraction for documents, done entirely in the browser.
// Libraries are lazy-loaded from /vendor only when a document of that type is seen.

export const DOC_EXT = new Set(["pdf", "docx", "pptx", "xlsx", "xls", "ods", "odt", "odp", "rtf", "ipynb", "epub"]);

export function docKind(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m && DOC_EXT.has(m[1]) ? m[1] : null;
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string) {
  if (!scripts.has(src))
    scripts.set(
      src,
      new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => res();
        s.onerror = () => rej(new Error("Failed to load " + src));
        document.head.appendChild(s);
      })
    );
  return scripts.get(src)!;
}

let pdfjs: any = null;
async function getPdf() {
  if (!pdfjs) {
    pdfjs = await import(/* webpackIgnore: true */ "/vendor/pdf.min.mjs" as any);
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  }
  return pdfjs;
}

async function pdfText(buf: ArrayBuffer): Promise<string> {
  const lib = await getPdf();
  const doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push(`[Page ${i}]`);
    let line = "";
    let lastY: number | null = null;
    for (const it of tc.items as any[]) {
      const y = it.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
        if (line.trim()) out.push(line.trim());
        line = "";
      }
      line += it.str + (it.hasEOL ? "\n" : "");
      if (it.hasEOL) {
        if (line.trim()) out.push(line.trim());
        line = "";
      }
      if (y !== undefined) lastY = y;
    }
    if (line.trim()) out.push(line.trim());
    page.cleanup?.();
  }
  return out.join("\n");
}

async function docxText(buf: ArrayBuffer): Promise<string> {
  await loadScript("/vendor/mammoth.browser.min.js");
  const r = await (window as any).mammoth.extractRawText({ arrayBuffer: buf });
  return String(r.value || "").replace(/\n{3,}/g, "\n\n");
}

async function sheetText(buf: ArrayBuffer): Promise<string> {
  await loadScript("/vendor/xlsx.full.min.js");
  const XLSX = (window as any).XLSX;
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const out: string[] = [];
  for (const name of wb.SheetNames) {
    out.push(`[Sheet ${name}]`);
    const csv: string = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    out.push(...csv.split("\n").filter((l: string) => l.replace(/,/g, "").trim()).slice(0, 5000));
  }
  return out.join("\n");
}

function xmlText(xml: string) {
  return xml
    .replace(/<\/(a:p|text:p|text:h|w:p)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

async function zipDoc(buf: ArrayBuffer, kind: string): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);
  if (kind === "pptx") {
    const slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    const out: string[] = [];
    for (const s of slides) {
      const n = s.match(/slide(\d+)/)![1];
      out.push(`[Slide ${n}]`, xmlText(await zip.file(s)!.async("string")));
      const notes = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
      if (notes) out.push("Notes: " + xmlText(await notes.async("string")).replace(/\n/g, " "));
    }
    return out.join("\n");
  }
  if (kind === "odt" || kind === "odp") {
    const c = zip.file("content.xml");
    return c ? xmlText(await c.async("string")) : "";
  }
  if (kind === "epub") {
    const parts = Object.keys(zip.files).filter((n) => /\.(x?html?)$/i.test(n)).sort();
    const out: string[] = [];
    for (const p of parts) out.push(htmlToText(await zip.file(p)!.async("string")));
    return out.join("\n");
  }
  return "";
}

function htmlToText(h: string) {
  return h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h\d|li|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function rtfText(s: string) {
  return s
    .replace(/\\par[d]?/g, "\n")
    .replace(/\{\\\*[^{}]*\}/g, "")
    .replace(/\\'[0-9a-f]{2}/gi, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ipynbText(s: string) {
  try {
    const nb = JSON.parse(s);
    return (nb.cells || [])
      .map((c: any, i: number) => `[Cell ${i + 1} · ${c.cell_type}]\n${(Array.isArray(c.source) ? c.source.join("") : c.source || "").trimEnd()}`)
      .join("\n\n");
  } catch {
    return s;
  }
}

/** Returns extracted text, or null if the type isn't a supported document. */
export async function extractDoc(name: string, buf: ArrayBuffer): Promise<string | null> {
  const kind = docKind(name);
  if (!kind) return null;
  switch (kind) {
    case "pdf":
      return pdfText(buf);
    case "docx":
      return docxText(buf);
    case "xlsx":
    case "xls":
    case "ods":
      return sheetText(buf);
    case "pptx":
    case "odt":
    case "odp":
    case "epub":
      return zipDoc(buf, kind);
    case "rtf":
      return rtfText(new TextDecoder().decode(buf));
    case "ipynb":
      return ipynbText(new TextDecoder().decode(buf));
  }
  return null;
}
