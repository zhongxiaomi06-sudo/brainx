"""Candidate supply scoring and Top-3 selection."""

from __future__ import annotations

from decision import _bootstrap  # noqa: F401

import re
from dataclasses import dataclass
from typing import Any

try:
    from resume_scorer import Dimension, DimScore, _score_dimension, build_dimensions
except ImportError:  # compatibility for the older checkout used by this project
    @dataclass(frozen=True)
    class Dimension:
        name: str
        weight: float
        keywords: list[str]
        core: bool
        strong_keywords: list[str]

    @dataclass(frozen=True)
    class DimScore:
        name: str
        weight: float
        score: float
        weighted: float
        hits: list[str]
        evidence: list[str]
        core: bool

    def build_dimensions(jd_text: str, weights_config: Any = None) -> tuple[list[Dimension], str]:
        text = jd_text or ""
        tokens = [token for token in re.findall(r"[A-Za-z0-9+#.-]{2,}|[\u4e00-\u9fff]{2,}", text)]
        unique = list(dict.fromkeys(tokens))
        groups = [
            ("核心职责", 25, True),
            ("技术能力", 25, True),
            ("行业经验", 20, False),
            ("项目交付", 20, False),
            ("其他要求", 10, False),
        ]
        dims = []
        cursor = 0
        for name, weight, core in groups:
            keywords = unique[cursor:cursor + 8] or unique[:8]
            cursor += 8
            dims.append(Dimension(name, weight, keywords, core, keywords[:3]))
        return dims, "decision compatibility scorer"

    def _score_dimension(text: str, dim: Dimension) -> DimScore:
        hits = [kw for kw in dim.keywords if kw.lower() in (text or "").lower()]
        score = min(10.0, 3.0 + len(hits) * 1.5) if hits else 0.0
        evidence = []
        lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
        for line in lines:
            if any(hit.lower() in line.lower() for hit in hits):
                evidence.append(line[:200])
                if len(evidence) == 2:
                    break
        return DimScore(dim.name, dim.weight, score, score / 10.0 * dim.weight, hits, evidence, dim.core)


PASS_SCORE = 55


def score_pool(jd_text: str, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    dims, _source = build_dimensions(jd_text)
    scored = []
    for candidate in candidates:
        text = candidate.get("raw_text") or ""
        if len(text.strip()) < 10:
            continue
        total = 0.0
        evidence: list[str] = []
        for dim in dims:
            ds = _score_dimension(text, dim)
            total += ds.weighted
            if ds.evidence:
                evidence.append(ds.evidence[0])
        scored.append({
            "fingerprint": candidate.get("fingerprint", ""),
            "name": candidate.get("name") or "未知",
            "score": round(total, 1),
            "evidence": evidence[:2],
            "phone": candidate.get("phone") or "",
            "email": candidate.get("email") or "",
        })
    return sorted(scored, key=lambda row: (-row["score"], row["fingerprint"]))


def supply_hits(scored: list[dict[str, Any]], pass_score: float = PASS_SCORE) -> int:
    return sum(1 for row in scored if float(row.get("score", 0)) >= pass_score)


def pick_trial(
    scored: list[dict[str, Any]], pass_score: float = PASS_SCORE, limit: int = 3
) -> list[dict[str, Any]]:
    eligible = [row for row in scored if float(row.get("score", 0)) >= pass_score]
    eligible.sort(key=lambda row: (-float(row.get("score", 0)), row.get("fingerprint", "")))
    return eligible[: max(0, limit)]
