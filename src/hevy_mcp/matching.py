"""Fuzzy exercise-name matching, stdlib only.

Tiers, best first: exact normalized equality, then whole-token containment
(so "bench" finds "Bench Press (Barbell)"), then difflib ratio. The result
carries the runner-up candidates so a wrong pick is visible rather than silent.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

from hevy_mcp.config import FUZZY_THRESHOLD
from hevy_mcp.normalize import normalize_name


@dataclass
class Match:
    name: str
    name_norm: str
    score: float
    how: str


def score_candidate(query_norm: str, candidate_norm: str) -> tuple[float, str]:
    """Score one candidate against the normalized query."""
    if not query_norm or not candidate_norm:
        return 0.0, "none"

    if query_norm == candidate_norm:
        return 1.0, "exact"

    query_tokens = query_norm.split()
    candidate_tokens = candidate_norm.split()

    if set(query_tokens) <= set(candidate_tokens):
        # Every query word appears; prefer the tersest candidate that qualifies.
        coverage = len(query_tokens) / len(candidate_tokens)
        return 0.9 + 0.09 * coverage, "all_terms"

    if query_norm in candidate_norm:
        return 0.85, "substring"

    # Last tier: character similarity, but only when every query word is
    # actually accounted for in the candidate. Without this gate a query like
    # "ohp barbell" scores well against "Squat (Barbell)" purely on the shared
    # equipment word, which is a confidently wrong answer.
    if not _tokens_supported(query_tokens, candidate_tokens):
        return 0.0, "none"

    ratio = SequenceMatcher(None, query_norm, candidate_norm).ratio()
    return ratio, "ratio"


def _tokens_supported(
    query_tokens: list[str],
    candidate_tokens: list[str],
    *,
    token_threshold: float = 0.7,
) -> bool:
    """True when each query word resembles some word in the candidate."""
    for token in query_tokens:
        best = 0.0
        for candidate in candidate_tokens:
            if token in candidate:
                best = 1.0
                break
            best = max(best, SequenceMatcher(None, token, candidate).ratio())
        if best < token_threshold:
            return False
    return True


def find_matches(
    query: str,
    candidates: list[str],
    *,
    threshold: float = FUZZY_THRESHOLD,
    limit: int = 5,
) -> list[Match]:
    """Rank candidate exercise names against a loosely typed query."""
    query_norm = normalize_name(query)
    scored: list[Match] = []

    for candidate in candidates:
        candidate_norm = normalize_name(candidate)
        score, how = score_candidate(query_norm, candidate_norm)
        if score >= threshold:
            scored.append(Match(candidate, candidate_norm, round(score, 3), how))

    scored.sort(key=lambda m: (-m.score, len(m.name), m.name))
    return scored[:limit]


def best_match(
    query: str,
    candidates: list[str],
    *,
    threshold: float = FUZZY_THRESHOLD,
) -> tuple[Match | None, list[Match]]:
    """Return ``(best, alternatives)``."""
    matches = find_matches(query, candidates, threshold=threshold)
    if not matches:
        return None, []
    return matches[0], matches[1:]
