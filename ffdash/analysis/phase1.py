"""Phase 1: standings, all-play, luck, median format, start/sit regret, champions."""
from __future__ import annotations

import hashlib
from collections import defaultdict


def public_id(owner_group: str) -> str:
    """ESPN owner ids are members' SWID cookies: never publish them. Short one-way hash instead."""
    return "o" + hashlib.sha256(("ffdash:" + owner_group).encode()).hexdigest()[:10]

from .. import lineup as lu


def owner_key(team: dict) -> str:
    if team.get("owner_key"):
        return team["owner_key"]
    ids = sorted(team.get("owner_ids") or [])
    return public_id("|".join(ids) if ids else f"team-{team['team_id']}")


def resolve_identities(seasons: list[dict]) -> list[str]:
    """Group teams into franchises: a franchise is the set of ESPN manager accounts linked by
    co-owning a team in any season. Each franchise is labelled by its most recent team name.
    Sets owner_key (hashed) and franchise on every team. No personal names are used. Returns notes."""
    parent: dict[str, str] = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for s in seasons:
        for t in s["teams"]:
            ids = t.get("owner_ids") or [f"team-{s['year']}-{t['team_id']}"]
            for o in ids:
                find(o)
            for o in ids[1:]:
                parent[find(o)] = find(ids[0])
    notes, label, names_seen = [], {}, {}
    ordered = sorted(seasons, key=lambda s: s["year"])
    for s in ordered:
        for t in s["teams"]:
            g = find((t.get("owner_ids") or [f"team-{s['year']}-{t['team_id']}"])[0])
            t["_g"] = g
            label[g] = t["name"]  # latest season wins
            names_seen.setdefault(g, [])
            if t["name"] not in names_seen[g]:
                names_seen[g].append(t["name"])
    for s in ordered:
        per = defaultdict(list)
        for t in s["teams"]:
            g = t.pop("_g")
            t["owner_key"], t["franchise"] = public_id(g), label[g]
            per[g].append(t["name"])
            if len(t.get("owner_ids") or []) > 1:
                notes.append(f"{s['year']}: '{t['name']}' had two manager accounts; their history is combined.")
        for g, names in per.items():
            if len(names) > 1:
                notes.append(f"{s['year']}: one manager ran {len(names)} teams ({', '.join(names)}); "
                             f"all-time totals count both under '{label[g]}'.")
    renamed = sum(len(v) > 1 for v in names_seen.values())
    if renamed:
        notes.insert(0, f"{renamed} franchises changed team names over the years; all-time tables use each "
                        f"franchise's most recent name.")
    return notes


def _int_keys(d: dict) -> dict:
    return {int(k): v for k, v in d.items()}


def regular_season_weeks(season: dict) -> dict[int, dict[int, float]]:
    """{period: {team_id: score}} for completed regular-season periods."""
    reg = season["settings"]["reg_season_periods"]
    weeks = defaultdict(dict)
    for m in season["matchups"]:
        if m["tier"] != "NONE" or m["period"] > reg or m["winner"] == "UNDECIDED":
            continue
        weeks[m["period"]][m["home"]] = m["home_score"] or 0
        if m["away"] is not None:
            weeks[m["period"]][m["away"]] = m["away_score"] or 0
    return dict(sorted(weeks.items()))


def _result(a: float, b: float) -> tuple[float, float, float]:
    return (1, 0, 0) if a > b else (0, 1, 0) if a < b else (0, 0, 1)


def season_stats(season: dict) -> dict:
    teams = {t["team_id"]: t for t in season["teams"]}
    weeks = regular_season_weeks(season)
    reg = season["settings"]["reg_season_periods"]
    n = len(teams)
    s = {tid: defaultdict(float) for tid in teams}

    # Head-to-head (pure H2H, no ESPN median bonus) from matchups.
    for m in season["matchups"]:
        if m["tier"] != "NONE" or m["period"] > reg or m["winner"] == "UNDECIDED" or m["away"] is None:
            continue
        for me, them, ms, ts in ((m["home"], m["away"], m["home_score"], m["away_score"]),
                                 (m["away"], m["home"], m["away_score"], m["home_score"])):
            w, l, t = _result(ms, ts)
            s[me]["w"] += w; s[me]["l"] += l; s[me]["t"] += t
            s[me]["pf"] += ms; s[me]["pa"] += ts; s[me]["games"] += 1

    weekly = []
    for period, scores in weeks.items():
        ordered = sorted(scores.values())
        k = len(ordered)
        median = (ordered[k // 2 - 1] + ordered[k // 2]) / 2 if k % 2 == 0 else ordered[k // 2]
        weekly.append({"period": period, "scores": scores, "median": round(median, 2)})
        for tid, sc in scores.items():
            others = [v for o, v in scores.items() if o != tid]
            aw = sum(sc > v for v in others); al = sum(sc < v for v in others); at = len(others) - aw - al
            s[tid]["ap_w"] += aw; s[tid]["ap_l"] += al; s[tid]["ap_t"] += at
            if others:
                s[tid]["xw"] += (aw + 0.5 * at) / len(others)
            mw, ml, mt = _result(sc, median)
            s[tid]["med_w"] += mw; s[tid]["med_l"] += ml; s[tid]["med_t"] += mt
            s[tid]["top_week"] += sc == ordered[-1]
            s[tid]["low_week"] += sc == ordered[0]

    regret = _regret(season, teams)

    rows = []
    for tid, t in teams.items():
        r = s[tid]
        g = r["games"] or 1
        ap_games = r["ap_w"] + r["ap_l"] + r["ap_t"] or 1
        wins = r["w"] + 0.5 * r["t"]
        rg = regret.get(tid, {})
        rows.append({
            "team_id": tid, "name": t["name"], "franchise": t["franchise"], "owner_key": owner_key(t),
            "division": t.get("division", ""),
            "w": r["w"], "l": r["l"], "t": r["t"], "pct": round(wins / g, 3),
            "pf": round(r["pf"], 2), "pa": round(r["pa"], 2),
            "ppg": round(r["pf"] / g, 2),
            "seed": t.get("seed"), "final_rank": t.get("final_rank"),
            "ap_w": r["ap_w"], "ap_l": r["ap_l"], "ap_t": r["ap_t"],
            "ap_pct": round((r["ap_w"] + 0.5 * r["ap_t"]) / ap_games, 3),
            "exp_w": round(r["xw"], 2), "luck": round(wins - r["xw"], 2),
            "med_w": r["w"] + r["med_w"], "med_l": r["l"] + r["med_l"], "med_t": r["t"] + r["med_t"],
            "top_weeks": int(r["top_week"]), "low_weeks": int(r["low_week"]),
            "regret_pts": rg.get("pts"), "regret_losses": rg.get("losses"), "bench_pts": rg.get("bench"),
            "optimal_pf": rg.get("optimal"), "lineup_pf": rg.get("actual"),
            "efficiency": round(rg["actual"] / rg["optimal"], 4) if rg.get("optimal") else None,
        })

    def rank(key):
        order = sorted(rows, key=key, reverse=True)
        return {r["team_id"]: i + 1 for i, r in enumerate(order)}

    h2h_rank = rank(lambda r: (r["w"] + 0.5 * r["t"], r["pf"]))
    ap_rank = rank(lambda r: (r["ap_pct"], r["pf"]))
    med_rank = rank(lambda r: (r["med_w"] + 0.5 * r["med_t"], r["pf"]))
    for r in rows:
        r["h2h_rank"], r["ap_rank"], r["med_rank"] = h2h_rank[r["team_id"]], ap_rank[r["team_id"]], med_rank[r["team_id"]]
    rows.sort(key=lambda r: r["h2h_rank"])

    blunders = sorted((b for rg in regret.values() for b in rg.get("weeks", [])),
                      key=lambda b: b["lost"], reverse=True)[:25]
    return {
        "year": season["year"], "complete": season["complete"],
        "median_scoring_enabled": season["settings"]["median_scoring"],
        "periods_played": len(weeks), "reg_season_periods": reg,
        "playoff_team_count": season["settings"]["playoff_team_count"],
        "standings": rows, "weekly": weekly, "blunders": blunders,
        "regret_weekly": {tid: rg.get("weeks", []) for tid, rg in regret.items()},
    }


def _regret(season: dict, teams: dict) -> dict:
    lineups = {int(sp): _int_keys(v) for sp, v in season.get("lineups", {}).items()}
    if not lineups:
        return {}
    slots = _int_keys(season["settings"]["slot_counts"])
    periods = {int(p): sps for p, sps in season["settings"]["matchup_periods"].items()}
    opp = {}
    for m in season["matchups"]:
        if m["away"] is None or m["winner"] == "UNDECIDED":
            continue
        opp[(m["period"], m["home"])] = (m["away"], m["away_score"], m["home_score"], m["tier"])
        opp[(m["period"], m["away"])] = (m["home"], m["home_score"], m["away_score"], m["tier"])

    reg = season["settings"]["reg_season_periods"]
    out = {tid: {"pts": 0.0, "losses": 0, "optimal": 0.0, "actual": 0.0, "bench": 0.0, "weeks": []} for tid in teams}
    for period, sps in periods.items():
        for tid in teams:
            if not all(sp in lineups and tid in lineups[sp] for sp in sps):
                continue
            act = optp = bench = 0.0
            benched, started = [], []
            for sp in sps:
                players = lineups[sp][tid]
                a, a_set = lu.actual(players)
                o, o_set = lu.optimal(players, slots)
                act += a; optp += o
                bench += sum(p["pts"] for p in players if p["slot"] == 20)
                a_ids = {p["pid"] for p in a_set}; o_ids = {p["pid"] for p in o_set}
                benched += [f'{p["name"]} ({p["pts"]})' for p in o_set if p["pid"] not in a_ids]
                started += [f'{p["name"]} ({p["pts"]})' for p in a_set if p["pid"] not in o_ids]
            lost = round(optp - act, 2)
            o = out[tid]
            match = opp.get((period, tid))
            regular = period <= reg
            if regular:
                o["pts"] += lost; o["optimal"] += optp; o["actual"] += act; o["bench"] += bench
            elif not match or match[3] != "WINNERS_BRACKET":
                continue  # consolation / eliminated weeks: lineups often abandoned
            cost_game = False
            if match and regular:
                _, opp_score, my_score, _ = match
                # Lost (or tied) with the lineup used; the optimal lineup would have won.
                cost_game = my_score <= opp_score and my_score + lost > opp_score
                o["losses"] += cost_game
            if lost > 0:
                o["weeks"].append({"team_id": tid, "team": teams[tid]["name"], "year": season["year"],
                                   "period": period, "lost": lost, "cost_game": cost_game,
                                   "playoff": bool(match and match[3] != "NONE"),
                                   "should_start": benched, "did_start": started})
    for o in out.values():
        o["bench"] = round(o["bench"], 2); o["pts"] = round(o["pts"], 2); o["optimal"] = round(o["optimal"], 2); o["actual"] = round(o["actual"], 2)
    return {tid: o for tid, o in out.items() if o["optimal"]}


def champions(seasons: list[dict], stats: dict) -> list[dict]:
    out = []
    for season in seasons:
        teams = season["teams"]
        st = stats[season["year"]]["standings"]
        by_rank = {t["final_rank"]: t for t in teams if t.get("final_rank")}
        champ = by_rank.get(1) if season["complete"] else None
        top_pf = max(st, key=lambda r: r["pf"]) if st else None
        last = by_rank.get(max(by_rank)) if by_rank and season["complete"] else None
        reg = next((r for r in st if r["h2h_rank"] == 1), None)
        out.append({
            "year": season["year"], "in_progress": not season["complete"],
            "champion": _who(champ), "runner_up": _who(by_rank.get(2)) if season["complete"] else None,
            "last_place": _who(last),
            "reg_season_best": reg and {"name": reg["name"], "franchise": reg["franchise"], "owner_key": reg["owner_key"],
                                        "record": f'{reg["w"]:.0f}-{reg["l"]:.0f}' + (f'-{reg["t"]:.0f}' if reg["t"] else "")},
            "top_pf": top_pf and {"name": top_pf["name"], "franchise": top_pf["franchise"], "owner_key": top_pf["owner_key"], "pf": top_pf["pf"]},
        })
    return out


def _who(t):
    return t and {"name": t["name"], "franchise": t["franchise"], "owner_key": owner_key(t)}


def all_time(stats: dict, champs: list[dict]) -> list[dict]:
    agg = defaultdict(lambda: defaultdict(float))
    names, years_by = {}, defaultdict(set)
    for year, st in sorted(stats.items()):
        for r in st["standings"]:
            a = agg[r["owner_key"]]
            names[r["owner_key"]] = r["franchise"]
            years_by[r["owner_key"]].add(year)
            for k in ("w", "l", "t", "pf", "pa", "ap_w", "ap_l", "ap_t", "exp_w", "luck", "med_w", "med_l", "med_t"):
                a[k] += r[k]
            if r["regret_pts"] is not None:
                a["regret_pts"] += r["regret_pts"]; a["regret_losses"] += r["regret_losses"]
                a["bench_pts"] += r["bench_pts"] or 0
                a["regret_seasons"] += 1
            if st["complete"] and r["seed"] and r["seed"] <= st["playoff_team_count"]:
                a["playoffs"] += 1
    for c in champs:
        for role, key in (("champion", "titles"), ("runner_up", "runner_ups"), ("last_place", "last_places")):
            if c.get(role):
                agg[c[role]["owner_key"]][key] += 1
    rows = []
    for k, a in agg.items():
        g = a["w"] + a["l"] + a["t"] or 1
        apg = a["ap_w"] + a["ap_l"] + a["ap_t"] or 1
        rows.append({
            "owner_key": k, "franchise": names[k], "seasons": len(years_by[k]),
            "w": int(a["w"]), "l": int(a["l"]), "t": int(a["t"]),
            "pct": round((a["w"] + 0.5 * a["t"]) / g, 3),
            "pf": round(a["pf"], 1), "pa": round(a["pa"], 1),
            "ap_pct": round((a["ap_w"] + 0.5 * a["ap_t"]) / apg, 3),
            "luck": round(a["luck"], 2),
            "med_w": int(a["med_w"]), "med_l": int(a["med_l"]),
            "titles": int(a["titles"]), "runner_ups": int(a["runner_ups"]), "last_places": int(a["last_places"]),
            "playoffs": int(a["playoffs"]),
            "regret_pts": round(a["regret_pts"], 1) if a["regret_seasons"] else None,
            "regret_losses": int(a["regret_losses"]) if a["regret_seasons"] else None,
            "bench_pts": round(a["bench_pts"], 1) if a["regret_seasons"] else None,
        })
    rows.sort(key=lambda r: (r["titles"], r["pct"]), reverse=True)
    return rows


def head_to_head(seasons: list[dict]) -> dict:
    """{franchise: {opponent franchise: {w, l, t, pf, pa}}}, regular season only."""
    h = defaultdict(lambda: defaultdict(lambda: {"w": 0, "l": 0, "t": 0, "pf": 0.0, "pa": 0.0}))
    for s in seasons:
        key = {t["team_id"]: t["owner_key"] for t in s["teams"]}
        reg = s["settings"]["reg_season_periods"]
        for m in s["matchups"]:
            if m["tier"] != "NONE" or m["period"] > reg or m["winner"] == "UNDECIDED" or m["away"] is None:
                continue
            for me, them, ms, ts in ((m["home"], m["away"], m["home_score"], m["away_score"]),
                                     (m["away"], m["home"], m["away_score"], m["home_score"])):
                a, b = key[me], key[them]
                if a == b:  # one manager's two teams met each other
                    continue
                r = h[a][b]
                r["w" if ms > ts else "l" if ms < ts else "t"] += 1
                r["pf"] += ms; r["pa"] += ts
    return {a: {b: {**r, "pf": round(r["pf"], 1), "pa": round(r["pa"], 1)} for b, r in opp.items()} for a, opp in h.items()}


def build(seasons: list[dict]) -> dict:
    notes = resolve_identities(seasons)
    stats = {s["year"]: season_stats(s) for s in seasons}
    champs = champions(seasons, stats)
    return {"seasons": stats, "champions": champs, "all_time": all_time(stats, champs),
            "head_to_head": head_to_head(seasons), "identity_notes": notes}
