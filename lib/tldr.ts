/** First sentence (or two short ones) as the TL;DR; the rest is detail. */
export function splitTldr(text: string): [string, string] {
  const t = text.trim();
  if (t.length <= 170) return [t, ""];
  const re = /[.!?](?:\s*\[\d+\])*(?=\s+[A-Z`(\[]|\s*$)/g;
  let m: RegExpExecArray | null, cut = -1;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].length;
    if (cut < 0 || end <= 170) cut = end;
    if (end > 120) break;
  }
  if (cut < 0 || cut >= t.length - 10) return [t, ""];
  return [t.slice(0, cut).trim(), t.slice(cut).trim()];
}

