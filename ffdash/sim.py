"""Season simulation engine: replay any schedule with the real weekly scores, seed playoffs the
way ESPN does for this league, and run the playoff bracket.

Fantasy scores don't depend on the opponent, so a team's week-w score is fixed and only the
schedule (who it faced) changes. Rules reproduced from ESPN (validated against real seeds and
champions in ffdash.analysis.phase4):

  * Division winners take the top seeds; everyone else is ordered by record.
  * Ties: TOTAL_POINTS_SCORED -> points for. H2H_RECORD -> two tied teams use head-to-head
    record, then points. Three or more: if every tied pair met equally often, head-to-head win %
    within the group; otherwise a team that beat every other tied team goes first, else the
    highest points for. The rest are re-broken the same way.
  * Fixed bracket (no reseeding), top seeds get byes; a playoff round is one matchup period
    (2020-21 rounds were two weeks long, already summed in the matchup score). Ties go to the
    higher seed.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Season:
    year: int
    team_ids: list[int]          # index -> ESPN team id
    div: np.ndarray              # (n,) division id per team index
    opp: np.ndarray              # (n, W) opponent team index per regular-season week (-1 = bye)
    played: int                  # completed regular-season weeks (W - played remain)
    scores: np.ndarray           # (n, played) actual regular-season scores
    playoff: np.ndarray          # (n, R) actual score per playoff round (nan if not played yet)
    n_playoff: int
    rule: str                    # "H2H_RECORD" | "TOTAL_POINTS_SCORED"
    complete: bool
    round_len: int = 1           # weeks per playoff round (2 in 2020-21)


def model(season: dict) -> Season | None:
    teams = sorted(t["team_id"] for t in season["teams"])
    ix = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    reg = season["settings"]["reg_season_periods"]
    opp = np.full((n, reg), -1, dtype=int)
    sc = np.full((n, reg), np.nan)
    rounds = sorted({m["period"] for m in season["matchups"] if m["period"] > reg})
    po = np.full((n, len(rounds)), np.nan)
    for m in season["matchups"]:
        h, a, p = ix.get(m["home"]), ix.get(m["away"]), m["period"]
        done = m["winner"] != "UNDECIDED"
        if p <= reg:
            if a is not None:
                opp[h, p - 1], opp[a, p - 1] = a, h
            if done:
                sc[h, p - 1] = m["home_score"] or 0
                if a is not None:
                    sc[a, p - 1] = m["away_score"] or 0
        elif done:
            r = rounds.index(p)
            po[h, r] = m["home_score"] or 0
            if a is not None:
                po[a, r] = m["away_score"] or 0
    played = int(np.sum(~np.isnan(sc).any(axis=0)))
    if played == 0:
        return None
    # Pad to the rounds the bracket needs (ESPN creates future playoff weeks late).
    n_po = int(season["settings"]["playoff_team_count"])
    need = int(np.ceil(np.log2(n_po))) if n_po > 1 else 0
    if po.shape[1] < need:
        po = np.concatenate([po, np.full((n, need - po.shape[1]), np.nan)], axis=1)
    div = np.array([next(t["division_id"] for t in season["teams"] if t["team_id"] == tid) for tid in teams])
    sched = season["settings"].get("schedule") or {}
    return Season(season["year"], teams, div, opp, played, sc[:, :played], po,
                  int(season["settings"]["playoff_team_count"]), sched.get("playoffSeedingRule") or "H2H_RECORD",
                  bool(season["complete"]), int(sched.get("playoffMatchupPeriodLength") or 1))


# ---------------------------------------------------------------- regular season
def play(scores: np.ndarray, opp: np.ndarray):
    """Vectorised over sims. scores (K, n, W); opp (K, n, W) opponent index.
    Returns wins (K, n) with ties as 0.5, and pairwise wins/games (K, n, n) for tiebreakers."""
    K, n, W = scores.shape
    has = opp >= 0
    o = np.where(has, opp, 0)
    mine = scores
    theirs = np.take_along_axis(scores, o, axis=1)
    r = np.where(has, (mine > theirs) + 0.5 * (mine == theirs), 0.0)
    wins = r.sum(axis=2)
    pw = np.zeros((K, n, n)); pg = np.zeros((K, n, n))
    k_idx = np.repeat(np.arange(K), n * W).reshape(K, n, W)
    i_idx = np.broadcast_to(np.arange(n)[None, :, None], (K, n, W))
    np.add.at(pw, (k_idx[has], i_idx[has], o[has]), r[has])
    np.add.at(pg, (k_idx[has], i_idx[has], o[has]), 1)
    return wins, pw, pg


# ---------------------------------------------------------------- seeding
def _break(group: list[int], pf, pw, pg, rule: str) -> list[int]:
    if len(group) <= 1:
        return group
    if rule != "H2H_RECORD":
        return sorted(group, key=lambda t: -pf[t])
    if len(group) == 2:
        a, b = group
        if pw[a, b] != pw[b, a]:
            return [a, b] if pw[a, b] > pw[b, a] else [b, a]
        return sorted(group, key=lambda t: -pf[t])
    pairs = {pg[a, b] for a in group for b in group if a < b}
    if len(pairs) == 1 and 0 not in pairs:
        # Balanced: every tied pair met equally often -> head-to-head win % within the group.
        pct = {t: sum(pw[t, o] for o in group if o != t) / sum(pg[t, o] for o in group if o != t) for t in group}
        best = max(pct.values())
        top = [t for t in group if pct[t] == best]
        if len(top) == 1:
            first = top[0]
        elif len(top) < len(group):
            first = _break(top, pf, pw, pg, rule)[0]
        else:  # everyone level on head-to-head: most points
            first = max(group, key=lambda t: pf[t])
    else:
        # Unbalanced: a team that beat every other tied team goes first, else most points.
        sweep = [t for t in group if all(pg[t, o] > 0 and pw[t, o] == pg[t, o] for o in group if o != t)]
        first = sweep[0] if len(sweep) == 1 else max(group, key=lambda t: pf[t])
    return [first] + _break([t for t in group if t != first], pf, pw, pg, rule)


def _order(teams: list[int], wins, pf, pw, pg, rule) -> list[int]:
    out = []
    for w in sorted({wins[t] for t in teams}, reverse=True):
        out += _break([t for t in teams if wins[t] == w], pf, pw, pg, rule)
    return out


def seeds(wins, pf, pw, pg, div, rule) -> list[int]:
    """Full seed order (team indices), division winners first."""
    teams = list(range(len(wins)))
    winners = [_order([t for t in teams if div[t] == d], wins, pf, pw, pg, rule)[0] for d in sorted(set(div.tolist()))]
    winners = _order(winners, wins, pf, pw, pg, rule)
    return winners + [t for t in _order(teams, wins, pf, pw, pg, rule) if t not in winners]


# ---------------------------------------------------------------- playoffs
def bracket(seed_order: list[int], n_playoff: int, po: np.ndarray) -> tuple[int, int] | None:
    """Fixed bracket with byes for the top seeds. po (n, R) playoff-round scores.
    Returns (champion, runner-up) team indices, or None if a needed score is missing."""
    field = seed_order[:n_playoff]
    size = 1
    while size < n_playoff:
        size *= 2
    # Standard bracket slots for `size`, seeds beyond n_playoff are byes.
    slots = [1]
    while len(slots) < size:
        m = 2 * len(slots) + 1
        slots = [x for s in slots for x in (s, m - s)]
    alive = [field[s - 1] if s <= n_playoff else None for s in slots]
    seed_of = {t: i for i, t in enumerate(field)}
    rnd = 0
    while len(alive) > 1:
        nxt, played_any = [], False
        for a, b in zip(alive[::2], alive[1::2]):
            if a is None or b is None:
                nxt.append(a if b is None else b)
                continue
            played_any = True
            if rnd >= po.shape[1]:
                return None
            sa, sb = po[a, rnd], po[b, rnd]
            if np.isnan(sa) or np.isnan(sb):
                return None
            hi, lo = (a, b) if seed_of[a] < seed_of[b] else (b, a)
            win = hi if po[hi, rnd] >= po[lo, rnd] else lo
            nxt.append(win)
            if len(alive) == 2:
                return win, (b if win == a else a)
        alive = nxt
        rnd += 1 if played_any else 0
    return (alive[0], None) if alive else None
