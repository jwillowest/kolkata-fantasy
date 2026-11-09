"""Optimal-lineup solver for start/sit regret."""
from __future__ import annotations

# Lineup slot ids (espn_api POSITION_MAP). Flex slots are filled after single-position slots,
# narrowest first, so greedy fill is optimal for ESPN's nested flex sets (FLEX within OP).
FLEX_ORDER = [3, 5, 11, 14, 23, 15, 24, 25, 7, 1]  # RB/WR, WR/TE, DL, DB, FLEX, DP, ER, Rookie, OP, TQB
BENCH = {20, 21}


def _slot_order(slot_counts: dict[int, int]) -> list[int]:
    singles = [s for s in slot_counts if s not in FLEX_ORDER]
    flex = [s for s in FLEX_ORDER if s in slot_counts]
    out = []
    for s in singles + flex:
        out += [s] * slot_counts[s]
    return out


def optimal(players: list[dict], slot_counts: dict[int, int]) -> tuple[float, list[dict]]:
    pool = sorted(players, key=lambda p: p["pts"], reverse=True)
    used, chosen, total = set(), [], 0.0
    for slot in _slot_order(slot_counts):
        for i, p in enumerate(pool):
            if i not in used and slot in p["elig"]:
                used.add(i)
                chosen.append(p)
                total += p["pts"]
                break
    return round(total, 2), chosen


def actual(players: list[dict]) -> tuple[float, list[dict]]:
    starters = [p for p in players if p["slot"] not in BENCH]
    return round(sum(p["pts"] for p in starters), 2), starters
