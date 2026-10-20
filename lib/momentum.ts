// Transcript momentum: as the meeting talks, keep a decaying score of the files it keeps touching.
// Heard questions are often vague ("so how does that get retried?"); boosting recently discussed
// files makes their retrieval land where the conversation already is.

export type Momentum = Map<string, number>;

/** Decay old scores, then add this segment's top hits (rank-weighted). */
export function updateMomentum(m: Momentum, hitPaths: string[], decay = 0.6): Momentum {
  const out: Momentum = new Map();
  for (const [p, w] of m) if (w * decay >= 0.15) out.set(p, w * decay);
  hitPaths.slice(0, 4).forEach((p, i) => out.set(p, (out.get(p) || 0) + 1 / (i + 1)));
  return out;
}

/** Files hot enough to boost: score ≥ min, at most `k`. */
export function momentumBoost(m: Momentum, k = 4, min = 0.8): Set<string> {
  return new Set([...m].filter(([, w]) => w >= min).sort((a, b) => b[1] - a[1]).slice(0, k).map(([p]) => p));
}
