"""Phase 4: simulations.

Per season (real weekly scores, ESPN's seeding and bracket rules from ffdash.sim):
  weighted   each week's score divided by that week's league average; 100 = average team.
  swap       every team's record if it had played every other team's schedule.
  schedules  N_SIMS random schedules: teams shuffled within their division across the real
             schedule's slots, so divisions and the schedule's shape stay the same.
  divisions  N_SIMS random division setups: teams shuffled across all slots (new divisions and
             a new schedule each time).
             Both report playoff, top-seed and title odds, plus how often the real champion
             still wins (how often the title "changes hands").
  projection current season only: remaining weeks and playoff rounds simulated by resampling
             each team's own scores this season, on the real remaining schedule.

Seeds are fixed per season so numbers for finished seasons don't move week to week.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict

import numpy as np

from .. import sim

log = logging.getLogger(__name__)
N_SIMS = 10_000


def _team_rows(season: dict) -> dict[int, dict]:
    return {t["team_id"]: t for t in season["teams"]}


def weighted(m: sim.Season) -> np.ndarray:
    week_mean = m.scores.mean(axis=0, keepdims=True)
    return 100 * (m.scores / week_mean).mean(axis=1)


def swap_matrix(m: sim.Season) -> np.ndarray:
    """wins[a, b] = a's wins playing b's schedule (when b's opponent is a, a faces b instead)."""
    n, W = m.scores.shape
    opp = m.opp[:, :W]
    out = np.zeros((n, n))
    for a in range(n):
        for b in range(n):
            o = opp[b].copy()
            o[o == a] = b
            if a == b:
                o = opp[a]
            mine, theirs = m.scores[a], m.scores[o, np.arange(W)]
            out[a, b] = np.sum(np.where(o >= 0, (mine > theirs) + 0.5 * (mine == theirs), 0))
    return out


def _simulate(m: sim.Season, perms: np.ndarray, slot_div: np.ndarray, scores: np.ndarray | None = None,
              playoff: np.ndarray | None = None, opp_fixed: np.ndarray | None = None) -> dict:
    """perms (K, n): team at each schedule slot. Returns per-team tallies."""
    K, n = perms.shape
    W = m.opp.shape[1] if opp_fixed is not None else m.played
    inv = np.argsort(perms, axis=1)                                        # team -> slot
    if opp_fixed is None:
        tmpl = m.opp[:, :W]                                                # slot -> slot
        opp_slot = tmpl[inv]                                               # (K, n, W): team's opponent slot
        opp = np.where(opp_slot >= 0, np.take_along_axis(perms[:, None, :].repeat(n, 1), np.maximum(opp_slot, 0), axis=2), -1)
        div = slot_div[inv]
    else:
        opp = np.broadcast_to(opp_fixed[None], (K, n, W))
        div = np.broadcast_to(m.div[None], (K, n))
    S = scores if scores is not None else np.broadcast_to(m.scores[None], (K, n, W))
    wins, pw, pg = sim.play(S, opp)
    pf = S.sum(axis=2)
    t = {k: np.zeros(n) for k in ("playoff", "seed1", "final", "title")}
    hist = np.zeros((n, W + 1))
    for k in range(K):
        order = sim.seeds(wins[k], pf[k], pw[k], pg[k], div[k], m.rule)
        t["playoff"][order[:m.n_playoff]] += 1
        t["seed1"][order[0]] += 1
        res = sim.bracket(order, m.n_playoff, playoff[k] if playoff is not None else m.playoff)
        if res:
            t["title"][res[0]] += 1
            t["final"][[res[0], res[1]]] += 1
        hist[np.arange(n), np.minimum(np.round(wins[k]).astype(int), W)] += 1
    return {"wins": wins.mean(axis=0), "hist": hist / K, **{k: v / K for k, v in t.items()}}


def season_sims(season: dict) -> dict | None:
    m = sim.model(season)
    if m is None:
        return None
    t0 = time.time()
    n, W = m.scores.shape
    rng = np.random.default_rng(season["year"])
    rows = _team_rows(season)
    tid = m.team_ids
    pf = m.scores.sum(axis=1)

    # actual result with the real schedule (validated against ESPN)
    wins0, pw0, pg0 = sim.play(m.scores[None], m.opp[None, :, :W])
    real_order = sim.seeds(wins0[0], pf, pw0[0], pg0[0], m.div, m.rule)
    real_res = sim.bracket(real_order, m.n_playoff, m.playoff) if m.complete else None
    fr = {t["final_rank"]: tid.index(t["team_id"]) for t in season["teams"] if t.get("final_rank")}
    validation = {
        "seeds": [tid[i] for i in real_order[:m.n_playoff]] == [t["team_id"] for t in sorted(season["teams"], key=lambda t: t["seed"] or 99)][:m.n_playoff],
        "champion": (real_res == (fr.get(1), fr.get(2))) if m.complete else None,
    }

    sw = swap_matrix(m)
    wtd = weighted(m)
    week_mean = m.scores.mean(axis=0)

    out_modes = {}
    if m.complete:
        slot_div = m.div.copy()
        # schedules: shuffle within divisions
        perms = np.tile(np.arange(n), (N_SIMS, 1))
        for d in np.unique(m.div):
            idx = np.where(m.div == d)[0]
            perms[:, idx] = np.array([rng.permutation(idx) for _ in range(N_SIMS)])
        out_modes["schedules"] = _simulate(m, perms, slot_div)
        # divisions: shuffle across all slots
        perms = np.array([rng.permutation(n) for _ in range(N_SIMS)])
        out_modes["divisions"] = _simulate(m, perms, slot_div)

    projection = None
    if not m.complete:
        Wt = m.opp.shape[1]
        remain = Wt - W
        K = N_SIMS
        draw = lambda size: np.take_along_axis(np.broadcast_to(m.scores[None], (K, n, W)),
                                               rng.integers(0, W, size=(K, n, size)), axis=2)
        S = np.concatenate([np.broadcast_to(m.scores[None], (K, n, W)), draw(remain)], axis=2) if remain else np.broadcast_to(m.scores[None], (K, n, W))
        R = m.playoff.shape[1]
        # a playoff round lasts round_len weeks: sum that many resampled weeks
        sampled = draw(R * m.round_len).reshape(K, n, R, m.round_len).sum(axis=3) if R else np.zeros((K, n, 0))
        po = np.where(np.isnan(m.playoff)[None], sampled, m.playoff[None])
        perms = np.tile(np.arange(n), (K, 1))
        r = _simulate(m, perms, m.div, scores=S, playoff=po, opp_fixed=m.opp)
        projection = {"weeks_left": int(remain), **{k: v for k, v in r.items()}}

    teams = []
    for i, t_id in enumerate(tid):
        t = rows[t_id]
        others = [sw[i, j] for j in range(n) if j != i]
        row = {
            "team_id": t_id, "name": t["name"], "franchise": t.get("franchise"), "owner_key": t.get("owner_key"),
            "wins": float(wins0[0][i]), "pf": round(float(pf[i]), 1), "seed": real_order.index(i) + 1,
            "weighted": round(float(wtd[i]), 1),
            "above_avg_wk": round(float((m.scores[i] - week_mean).mean()), 1),
            "swap_mean": round(float(np.mean(others)), 2), "swap_best": float(max(others)), "swap_worst": float(min(others)),
            "schedule_luck": round(float(wins0[0][i] - np.mean(others)), 2),
            "champion": bool(real_res and real_res[0] == i),
        }
        for mode, r in out_modes.items():
            row[mode] = {"wins": round(float(r["wins"][i]), 2), "playoff": round(float(r["playoff"][i]), 4),
                         "seed1": round(float(r["seed1"][i]), 4), "final": round(float(r["final"][i]), 4),
                         "title": round(float(r["title"][i]), 4), "hist": [round(float(x), 4) for x in r["hist"][i]]}
        if projection:
            row["projection"] = {"wins": round(float(projection["wins"][i]), 2), "playoff": round(float(projection["playoff"][i]), 4),
                                 "seed1": round(float(projection["seed1"][i]), 4), "final": round(float(projection["final"][i]), 4),
                                 "title": round(float(projection["title"][i]), 4)}
        teams.append(row)

    champ = next((r for r in teams if r["champion"]), None)
    summary = {}
    for mode in out_modes:
        fav = max(teams, key=lambda r: r[mode]["title"])
        summary[mode] = {
            "champion_kept": champ[mode]["title"] if champ else None,
            "changes_hands": round(1 - champ[mode]["title"], 4) if champ else None,
            "favorite": fav["team_id"], "favorite_title": fav[mode]["title"],
        }
    log.info("sims %s: %.1fs", season["year"], time.time() - t0)
    return {
        "year": season["year"], "complete": m.complete, "weeks": int(W), "n_sims": N_SIMS,
        "n_playoff": m.n_playoff, "rule": m.rule, "validation": validation,
        "teams": sorted(teams, key=lambda r: r["seed"]),
        "swap": {"order": tid, "wins": sw.round(1).tolist()},
        "summary": summary, "weeks_left": projection["weeks_left"] if projection else 0,
    }


def build(seasons: list[dict]) -> dict:
    out = {s["year"]: r for s in seasons if (r := season_sims(s))}
    agg = defaultdict(lambda: defaultdict(float)); names, years = {}, defaultdict(set)
    for y, s in out.items():
        if not s["complete"]:
            continue
        for t in s["teams"]:
            a = agg[t["owner_key"]]; names[t["owner_key"]] = t["franchise"]; years[t["owner_key"]].add(y)
            a["titles"] += t["champion"]; a["playoffs"] += t["seed"] <= s["n_playoff"]
            a["schedule_luck"] += t["schedule_luck"]
            for mode in ("schedules", "divisions"):
                a[f"xtitles_{mode}"] += t[mode]["title"]; a[f"xplayoffs_{mode}"] += t[mode]["playoff"]
    rows = [{
        "owner_key": k, "franchise": names[k], "seasons": len(years[k]),
        "titles": int(a["titles"]), "xtitles": round(a["xtitles_schedules"], 2), "xtitles_div": round(a["xtitles_divisions"], 2),
        "titles_vs_x": round(a["titles"] - a["xtitles_schedules"], 2),
        "playoffs": int(a["playoffs"]), "xplayoffs": round(a["xplayoffs_schedules"], 2),
        "playoffs_vs_x": round(a["playoffs"] - a["xplayoffs_schedules"], 2),
        "schedule_luck": round(a["schedule_luck"], 2),
    } for k, a in agg.items()]
    rows.sort(key=lambda r: r["titles_vs_x"], reverse=True)
    return {"seasons": out, "all_time": rows, "n_sims": N_SIMS}
