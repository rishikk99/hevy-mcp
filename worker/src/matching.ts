// Fuzzy exercise-name matching. Port of src/hevy_mcp/matching.py: exact, then
// whole-token containment, then substring, then a character-similarity ratio
// gated on every query word being accounted for.

import { FUZZY_THRESHOLD } from "./config";
import { sequenceRatio } from "./difflib";
import { normalizeName } from "./normalize";
import { pyRound } from "./pyjson";

export interface Match {
  name: string;
  nameNorm: string;
  score: number;
  how: string;
}

export function scoreCandidate(queryNorm: string, candidateNorm: string): [number, string] {
  if (!queryNorm || !candidateNorm) return [0, "none"];
  if (queryNorm === candidateNorm) return [1, "exact"];

  const queryTokens = queryNorm.split(" ");
  const candidateTokens = candidateNorm.split(" ");
  const candidateSet = new Set(candidateTokens);

  if (queryTokens.every((t) => candidateSet.has(t))) {
    // Every query word appears; prefer the tersest candidate that qualifies.
    const coverage = queryTokens.length / candidateTokens.length;
    return [0.9 + 0.09 * coverage, "all_terms"];
  }

  if (candidateNorm.includes(queryNorm)) return [0.85, "substring"];

  // Without this gate "ohp barbell" scores well against "Squat (Barbell)" on
  // the shared equipment word alone: a confidently wrong answer.
  if (!tokensSupported(queryTokens, candidateTokens)) return [0, "none"];

  return [sequenceRatio(queryNorm, candidateNorm), "ratio"];
}

function tokensSupported(queryTokens: string[], candidateTokens: string[], tokenThreshold = 0.7): boolean {
  for (const token of queryTokens) {
    let best = 0;
    for (const candidate of candidateTokens) {
      if (candidate.includes(token)) {
        best = 1;
        break;
      }
      best = Math.max(best, sequenceRatio(token, candidate));
    }
    if (best < tokenThreshold) return false;
  }
  return true;
}

export function findMatches(query: string, candidates: string[], threshold = FUZZY_THRESHOLD, limit = 5): Match[] {
  const queryNorm = normalizeName(query);
  const scored: Match[] = [];
  for (const candidate of candidates) {
    const candidateNorm = normalizeName(candidate);
    const [score, how] = scoreCandidate(queryNorm, candidateNorm);
    if (score >= threshold) scored.push({ name: candidate, nameNorm: candidateNorm, score: pyRound(score, 3), how });
  }
  scored.sort(
    (x, y) =>
      y.score - x.score ||
      [...x.name].length - [...y.name].length ||
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
  );
  return scored.slice(0, limit);
}

export function bestMatch(query: string, candidates: string[], threshold = FUZZY_THRESHOLD): [Match | null, Match[]] {
  const matches = findMatches(query, candidates, threshold);
  if (!matches.length) return [null, []];
  return [matches[0], matches.slice(1)];
}
