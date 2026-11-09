"""Phase 3: draft vs ADP.

For each pick: consensus ADP (FantasyPros ECR, or ESPN ADP where flagged), the pick slot, and the
player's regular-season fantasy points in this league's scoring.

  steal / reach    = pick - ADP. Positive = taken later than consensus (steal), negative = reach.
                     D/ST and K are left out: consensus ranks them far below where leagues draft them.
  expected points  = position-aware: what the consensus's Nth-ranked player at that position scored
                     this season (mean of positional ranks N-WINDOW..N+WINDOW).
  value vs ADP     = points - expected(position, consensus positional rank)
  pick value       = points - expected(position, order taken in our draft), e.g. the 5th RB taken
                     is measured against what consensus RB3-RB7 scored.
"""
from __future__ import annotations

import math
from collections import defaultdict

from ..consensus import adp_for

WINDOW = 2
NO_STEAL = {"D/ST", "K"}


def _reg_periods(season: dict) -> set[int]:
    reg = season["settings"]["reg_season_periods"]
    done = {m["period"] for m in season["matchups"] if m["winner"] != "UNDECIDED"}
    return {sp for p, sps in season["settings"]["matchup_periods"].items()
            if int(p) <= reg and int(p) in done for sp in sps}


def season_draft(season: dict, refresh_adp: bool = False) -> dict | None:
    if not season.get("draft"):
        return None
    adp = adp_for(season, refresh_adp) or {"ranks": {}, "source": None, "detail": "No ADP source", "unmatched_drafted": []}
    ranks = {str(k): v for k, v in adp["ranks"].items()}
    # Older cached notes said "skewed"; QBs are now dropped from steals in those seasons instead.
    adp["detail"] = (adp.get("detail") or "").replace("superflex rankings missing, QB steals/reaches skewed",
        "no superflex rankings archived for this draft, so QBs are left out of steals/reaches").replace(
        "so QB steals/reaches are skewed", "so QBs are left out of steals/reaches")
    sps = _reg_periods(season)
    players = season["players"]
    pts = {pid: round(sum(v for sp, v in p["wk"].items() if int(sp) in sps), 1) for pid, p in players.items()}

    # Positional ranks: consensus order, actual finish, and the order our league took them.
    pos_of = {pid: p["pos"] for pid, p in players.items()}
    adp_pos_rank, finish_rank, pos_curve = {}, {}, {}
    for pos in set(pos_of.values()):
        ranked = sorted((r, pid) for pid, r in ranks.items() if pos_of.get(pid) == pos)
        adp_pos_rank.update({pid: i + 1 for i, (_, pid) in enumerate(ranked)})
        pos_curve[pos] = [pts.get(pid, 0.0) for _, pid in ranked]  # unknown scorers scored ~0
        scored = sorted(((p, pid) for pid, p in pts.items() if pos_of.get(pid) == pos), reverse=True)
        finish_rank.update({pid: i + 1 for i, (_, pid) in enumerate(scored)})
    taken = defaultdict(int); draft_pos_order = {}
    for d in sorted(season["draft"], key=lambda d: d["overall"]):
        pos = pos_of.get(str(d["pid"]), "")
        taken[pos] += 1
        draft_pos_order[str(d["pid"])] = taken[pos]

    def expected(pos: str, k: int | None) -> float | None:
        curve = pos_curve.get(pos) or []
        if not k or not curve:
            return None
        vals = curve[max(0, k - 1 - WINDOW): k + WINDOW]
        return round(sum(vals) / len(vals), 1) if vals else None

    cap = len(season["draft"]) + 12
    # 1-QB consensus in a superflex/2-QB season: QB overall ranks are meaningless, so no QB steals.
    skewed_qb = str(adp.get("format", "")).startswith("1-QB (") or (adp.get("source") == "ESPN" and "1-QB" in adp.get("detail", ""))
    teams = {t["team_id"]: t for t in season["teams"]}
    picks = []
    for d in season["draft"]:
        pid = str(d["pid"]); p = players.get(pid, {})
        a = ranks.get(pid)
        pos = p.get("pos", "")
        e_adp, e_pick = expected(pos, adp_pos_rank.get(pid)), expected(pos, draft_pos_order.get(pid))
        t = teams.get(d["team"], {})
        picks.append({
            "year": season["year"], "overall": d["overall"], "round": d["round"], "round_pick": d["round_pick"],
            "team_id": d["team"], "team": t.get("name", f"Team {d['team']}"),
            "franchise": t.get("franchise"), "owner_key": t.get("owner_key"),
            "player": p.get("name", f"Player {pid}"), "pos": p.get("pos", ""), "keeper": d["keeper"],
            "adp": round(a, 1) if a else None,
            "steal": round(d["overall"] - min(a, cap), 1) if a and not d["keeper"] and pos not in NO_STEAL and not (skewed_qb and pos == "QB") else None,
            "pos_taken": f"{pos}{draft_pos_order[pid]}" if pid in draft_pos_order else None,
            "pts": pts.get(pid, 0.0),
            "pos_adp": f'{p.get("pos", "")}{adp_pos_rank[pid]}' if pid in adp_pos_rank else None,
            "pos_finish": f'{p.get("pos", "")}{finish_rank[pid]}' if pid in finish_rank else None,
            "pos_delta": (adp_pos_rank[pid] - finish_rank[pid]) if pid in adp_pos_rank and pid in finish_rank else None,
            "value_vs_adp": round(pts.get(pid, 0.0) - e_adp, 1) if e_adp is not None else None,
            "pick_value": round(pts.get(pid, 0.0) - e_pick, 1) if e_pick is not None else None,
        })

    by_team = []
    for tid, t in teams.items():
        mine = [p for p in picks if p["team_id"] == tid]
        if not mine:
            continue
        st = [p["steal"] for p in mine if p["steal"] is not None]
        pv = [p["pick_value"] for p in mine if p["pick_value"] is not None]
        beat = [p for p in mine if p["value_vs_adp"] is not None]
        best = max(mine, key=lambda p: p["pick_value"] if p["pick_value"] is not None else -1e9)
        worst = min(mine, key=lambda p: p["pick_value"] if p["pick_value"] is not None else 1e9)
        by_team.append({
            "team_id": tid, "name": t["name"], "franchise": t.get("franchise"), "owner_key": t.get("owner_key"),
            "picks": len(mine), "keepers": sum(p["keeper"] for p in mine),
            "avg_steal": round(sum(st) / len(st), 1) if st else None,
            "draft_value": round(sum(pv), 1) if pv else None,
            "beat_adp_pct": round(sum(p["value_vs_adp"] > 0 for p in beat) / len(beat), 3) if beat else None,
            "draft_pts": round(sum(p["pts"] for p in mine), 1),
            "best": best["player"], "best_value": best["pick_value"],
            "worst": worst["player"], "worst_value": worst["pick_value"],
        })
    by_team.sort(key=lambda r: r["draft_value"] if r["draft_value"] is not None else -1e9, reverse=True)

    graded = [p for p in picks if p["pick_value"] is not None]
    nk = [p for p in picks if p["steal"] is not None]
    return {
        "year": season["year"], "complete": season["complete"],
        "adp_source": adp.get("source"), "adp_detail": adp.get("detail"), "adp_format": adp.get("format"),
        "unmatched": adp.get("unmatched_drafted", []), "keepers": sum(p["keeper"] for p in picks),
        "rec_points": season.get("rec_points"), "periods": len(sps),
        "picks": picks, "teams": by_team,
        "steals": sorted(nk, key=lambda p: p["steal"], reverse=True)[:12],
        "reaches": sorted(nk, key=lambda p: p["steal"])[:12],
        "best_picks": sorted(graded, key=lambda p: p["pick_value"], reverse=True)[:12],
        "worst_picks": sorted(graded, key=lambda p: p["pick_value"])[:12],
    }


def build(seasons: list[dict], refresh_adp: bool = False) -> dict:
    out = {s["year"]: d for s in seasons if (d := season_draft(s, refresh_adp))}
    agg = defaultdict(lambda: defaultdict(float)); names, years = {}, defaultdict(set)
    for y, d in out.items():
        if not d["complete"] or d["adp_source"] != "FantasyPros":
            continue  # all-time: finished seasons with FantasyPros consensus only (ESPN-ADP seasons aren't comparable)
        for t in d["teams"]:
            a = agg[t["owner_key"]]; names[t["owner_key"]] = t["franchise"]; years[t["owner_key"]].add(y)
            a["picks"] += t["picks"]; a["draft_value"] += t["draft_value"] or 0
            for p in d["picks"]:
                if p["owner_key"] != t["owner_key"] or p["team_id"] != t["team_id"]:
                    continue
                if p["steal"] is not None:
                    a["steal_sum"] += p["steal"]; a["steal_n"] += 1
                if p["value_vs_adp"] is not None:
                    a["beat"] += p["value_vs_adp"] > 0; a["graded"] += 1
    rows = [{
        "owner_key": k, "franchise": names[k], "seasons": len(years[k]), "picks": int(a["picks"]),
        "draft_value": round(a["draft_value"], 1),
        "value_per_draft": round(a["draft_value"] / len(years[k]), 1),
        "avg_steal": round(a["steal_sum"] / a["steal_n"], 1) if a["steal_n"] else None,
        "beat_adp_pct": round(a["beat"] / a["graded"], 3) if a["graded"] else None,
    } for k, a in agg.items()]
    rows.sort(key=lambda r: r["value_per_draft"], reverse=True)
    return {"seasons": out, "all_time": rows, "window": WINDOW,
            "keepers": keepers(out), "tendencies": tendencies(out)}


def keepers(out: dict) -> dict:
    """Every keeper: the round it cost vs where consensus had the player, and what he scored."""
    rows = []
    for y, d in out.items():
        n_teams = len(d["teams"]) or 1
        for p in d["picks"]:
            if not p["keeper"]:
                continue
            adp_round = math.ceil(p["adp"] / n_teams) if p["adp"] else None
            rows.append({**p, "adp_round": adp_round,
                         "rounds_saved": (p["round"] - adp_round) if adp_round else None})
    by_team = defaultdict(lambda: {"n": 0, "value": 0.0, "saved": 0})
    for r in rows:
        b = by_team[r["owner_key"]]; b["franchise"] = r["franchise"]; b["owner_key"] = r["owner_key"]
        b["n"] += 1; b["value"] += r["pick_value"] or 0; b["saved"] += r["rounds_saved"] or 0
    return {"picks": sorted(rows, key=lambda r: (-(r["year"]), r["overall"])),
            "years": sorted({r["year"] for r in rows}),
            "by_team": sorted(({**v, "value": round(v["value"], 1)} for v in by_team.values()), key=lambda r: -r["value"])}


def tendencies(out: dict) -> dict:
    """How this league drafts vs consensus (FantasyPros seasons, non-keepers, D/ST and K aside).
    lean = average (ADP - pick) by position: negative = league takes that position earlier than consensus."""
    fp = {y: d for y, d in out.items() if d["adp_source"] == "FantasyPros"}
    good = {y for y, d in fp.items() if d.get("adp_format") in ("superflex", "1-QB")}  # consensus matches lineup
    lean = defaultdict(lambda: defaultdict(list))
    firsts, mix = [], {}
    for y, d in fp.items():
        picks = sorted(d["picks"], key=lambda p: p["overall"])
        n_teams = len(d["teams"]) or 1
        seen = set()
        for p in picks:
            if p["steal"] is not None and p["round"] <= 10 and (y in good or p["pos"] != "QB"):
                lean[p["pos"]][y].append(p["steal"]); lean[p["pos"]]["all"].append(p["steal"])
            if p["pos"] not in seen and p["pos"] in ("QB", "TE", "D/ST", "K"):
                seen.add(p["pos"])
                firsts.append({"year": y, "pos": p["pos"], "overall": p["overall"], "round": p["round"],
                               "player": p["player"], "team": p["team"], "adp": p["adp"]})
        early = [p for p in picks if p["round"] <= 3]
        mix[y] = {pos: sum(p["pos"] == pos for p in early) for pos in ("RB", "WR", "QB", "TE")}
    by_pos = {pos: {str(y): round(sum(v) / len(v), 1) for y, v in ys.items() if v} for pos, ys in lean.items()}
    return {"lean": by_pos, "n": {pos: len(ys["all"]) for pos, ys in lean.items()},
            "firsts": sorted(firsts, key=lambda f: (f["pos"], -f["year"])), "early_mix": mix,
            "years": sorted(fp)}
