"""Phase 5: league history extras.

  records     record book (single games, streaks, seasons) and rivalries between franchises.
  elo         Elo power rating carried across seasons, biggest upsets, next-week predictions.
  clutch      playoff scores vs each team's own regular-season average.
  styles      manager style cards: percentile traits from waivers, FAAB, trades, lineups, drafts.
  curse       last place each season and the high-ADP bust that doomed it.

Games used: regular season plus the winners' bracket (consolation games are skipped). 2020-21
playoff rounds were two weeks long, so they are left out of single-week records.
"""
from __future__ import annotations

import math
from collections import defaultdict

ELO_K = 12
ELO_BASE = 1500
ELO_CARRY = 0.5       # share of distance from 1500 kept into the next season
POINTS_SD = 100       # spread for the points model, calibrated on league history (Brier score)
# Backtests (2020-2026): no Elo setting beat a coin flip at picking weekly winners here, and a
# season-to-date points average picks ~55%. Ratings are descriptive; predictions are for fun.


def _games(seasons: list[dict]) -> list[dict]:
    out = []
    for s in sorted(seasons, key=lambda s: s["year"]):
        reg = s["settings"]["reg_season_periods"]
        two_week = (s["settings"].get("schedule") or {}).get("playoffMatchupPeriodLength", 1) or 1
        teams = {t["team_id"]: t for t in s["teams"]}
        for m in sorted(s["matchups"], key=lambda m: m["period"]):
            if m["away"] is None or m["winner"] == "UNDECIDED" or m["tier"] not in ("NONE", "WINNERS_BRACKET"):
                continue
            playoff = m["period"] > reg
            h, a = teams[m["home"]], teams[m["away"]]
            out.append({
                "year": s["year"], "week": m["period"], "playoff": playoff, "tier": m["tier"],
                "weeks": two_week if playoff else 1,
                "a": h["team_id"], "a_name": h["name"], "a_key": h["owner_key"], "a_score": m["home_score"] or 0,
                "b": a["team_id"], "b_name": a["name"], "b_key": a["owner_key"], "b_score": m["away_score"] or 0,
            })
    return out


def _side(g: dict, me: str) -> dict:
    """View a game from one side: me in ("a", "b")."""
    o = "b" if me == "a" else "a"
    return {"year": g["year"], "week": g["week"], "playoff": g["playoff"], "weeks": g["weeks"],
            "team": g[f"{me}_name"], "owner_key": g[f"{me}_key"], "score": g[f"{me}_score"],
            "opp": g[f"{o}_name"], "opp_key": g[f"{o}_key"], "opp_score": g[f"{o}_score"],
            "margin": round(g[f"{me}_score"] - g[f"{o}_score"], 2)}


# ------------------------------------------------------------------ records + rivalries
def records(seasons: list[dict], games: list[dict], fr: dict, p1: dict) -> dict:
    sides = [_side(g, x) for g in games for x in ("a", "b")]
    one_week = [x for x in sides if x["weeks"] == 1]
    wins = [x for x in one_week if x["margin"] > 0]
    top = lambda rows, key, rev=True, n=5: sorted(rows, key=key, reverse=rev)[:n]
    singles = {
        "high_score": top(one_week, lambda x: x["score"]),
        "low_score": top([x for x in one_week if not x["playoff"]], lambda x: x["score"], rev=False),
        "blowout": top(wins, lambda x: x["margin"]),
        "closest": top(wins, lambda x: x["margin"], rev=False),
        "most_in_loss": top([x for x in one_week if x["margin"] < 0], lambda x: x["score"]),
        "fewest_in_win": top(wins, lambda x: x["score"], rev=False),
    }
    # streaks within a regular season
    streaks = []
    for s in seasons:
        reg = s["settings"]["reg_season_periods"]
        by_team = defaultdict(list)
        for x in sides:
            if x["year"] == s["year"] and not x["playoff"]:
                by_team[(x["owner_key"], x["team"])].append(x)
        for (key, name), rows in by_team.items():
            rows.sort(key=lambda r: r["week"])
            for want in ("W", "L"):
                best = cur = 0; start = end = None; cs = None
                for r in rows:
                    ok = (r["margin"] > 0) if want == "W" else (r["margin"] < 0)
                    cur = cur + 1 if ok else 0
                    if cur == 1:
                        cs = r["week"]
                    if cur > best:
                        best, start, end = cur, cs, r["week"]
                if best:
                    streaks.append({"type": want, "len": best, "year": s["year"], "from": start, "to": end,
                                    "team": name, "owner_key": key})
    seasons_rows = [dict(r, year=int(y)) for y, st in p1["seasons"].items() if st["complete"] for r in st["standings"]]
    season_recs = {
        "best_record": top(seasons_rows, lambda r: (r["pct"], r["pf"])),
        "worst_record": top(seasons_rows, lambda r: (r["pct"], r["pf"]), rev=False),
        "most_ppg": top(seasons_rows, lambda r: r["ppg"]),
        "fewest_ppg": top(seasons_rows, lambda r: r["ppg"], rev=False),
    }
    slim = lambda r: {"year": r["year"], "team": r["name"], "owner_key": r["owner_key"],
                      "record": f'{r["w"]:.0f}-{r["l"]:.0f}' + (f'-{r["t"]:.0f}' if r["t"] else ""), "ppg": r["ppg"], "pf": r["pf"]}
    season_recs = {k: [slim(r) for r in v] for k, v in season_recs.items()}

    # rivalries: every franchise pair
    pairs = {}
    for g in games:
        a, b = sorted([g["a_key"], g["b_key"]])
        if a == b:
            continue
        p = pairs.setdefault(f"{a}|{b}", {"a": a, "b": b, "a_w": 0, "b_w": 0, "t": 0, "games": [], "playoff_games": 0})
        sa = g["a_score"] if g["a_key"] == a else g["b_score"]
        sb = g["b_score"] if g["a_key"] == a else g["a_score"]
        p["a_w" if sa > sb else "b_w" if sb > sa else "t"] += 1
        p["playoff_games"] += g["playoff"]
        p["games"].append({"year": g["year"], "week": g["week"], "playoff": g["playoff"],
                           "a_team": g["a_name"] if g["a_key"] == a else g["b_name"],
                           "b_team": g["b_name"] if g["a_key"] == a else g["a_name"],
                           "a_score": round(sa, 2), "b_score": round(sb, 2)})
    rows = []
    for p in pairs.values():
        n = len(p["games"])
        margins = [abs(x["a_score"] - x["b_score"]) for x in p["games"]]
        streak_side, streak = None, 0
        for x in sorted(p["games"], key=lambda x: (x["year"], x["week"]), reverse=True):
            w = "a" if x["a_score"] > x["b_score"] else "b" if x["b_score"] > x["a_score"] else None
            if streak_side is None:
                streak_side, streak = w, 1 if w else 0
            elif w == streak_side:
                streak += 1
            else:
                break
        rows.append({**p, "a_name": fr.get(p["a"]), "b_name": fr.get(p["b"]), "n": n,
                     "avg_margin": round(sum(margins) / n, 1),
                     "balance": round(1 - abs(p["a_w"] - p["b_w"]) / n, 3),
                     "streak": {"side": streak_side, "len": streak},
                     "games": sorted(p["games"], key=lambda x: (x["year"], x["week"]), reverse=True)})
    return {"singles": singles, "streaks": {
                "win": sorted([s for s in streaks if s["type"] == "W"], key=lambda s: -s["len"])[:5],
                "loss": sorted([s for s in streaks if s["type"] == "L"], key=lambda s: -s["len"])[:5]},
            "seasons": season_recs, "rivalries": sorted(rows, key=lambda r: (-r["n"], -r["balance"]))}


# ------------------------------------------------------------------ Elo
def _p(ra: float, rb: float) -> float:
    return 1 / (1 + 10 ** ((rb - ra) / 400))


def elo(games: list[dict], fr: dict, seasons: list[dict]) -> dict:
    r: dict[str, float] = {}
    timeline = defaultdict(list)
    upsets, hits, n_pred, brier = [], 0, 0, 0.0
    year = None
    for g in games:
        if g["year"] != year:
            year = g["year"]
            r = {k: ELO_BASE + (v - ELO_BASE) * ELO_CARRY for k, v in r.items()}
            for k, v in r.items():
                timeline[k].append({"year": year, "week": 0, "elo": round(v, 1)})
        a, b = g["a_key"], g["b_key"]
        if a == b:
            continue
        ra, rb = r.setdefault(a, ELO_BASE), r.setdefault(b, ELO_BASE)
        pa = _p(ra, rb)
        sa = 1.0 if g["a_score"] > g["b_score"] else 0.0 if g["a_score"] < g["b_score"] else 0.5
        margin = abs(g["a_score"] - g["b_score"]) / g["weeks"]
        # Margin-of-victory multiplier, damped when the favorite wins big (538-style).
        diff = (ra - rb) if sa == 1 else (rb - ra) if sa == 0 else 0
        mult = math.log(margin / 10 + 1) * 2.2 / (diff * 0.001 + 2.2) if sa != 0.5 else 1.0
        delta = ELO_K * max(mult, 0.25) * (sa - pa)
        r[a], r[b] = ra + delta, rb - delta
        if sa != 0.5:
            n_pred += 1; hits += (pa > 0.5) == (sa == 1); brier += (pa - sa) ** 2
            win_p = pa if sa == 1 else 1 - pa
            w, l = (g["a_name"], g["b_name"]) if sa == 1 else (g["b_name"], g["a_name"])
            wk, lk = (a, b) if sa == 1 else (b, a)
            upsets.append({"year": g["year"], "week": g["week"], "playoff": g["playoff"], "winner": w, "loser": l,
                           "owner_key": wk, "loser_key": lk, "win_p": round(win_p, 3),
                           "score": f'{max(g["a_score"], g["b_score"]):.1f}–{min(g["a_score"], g["b_score"]):.1f}'})
        for k in (a, b):
            timeline[k].append({"year": g["year"], "week": g["week"], "elo": round(r[k], 1)})
    cur_year = max(s["year"] for s in seasons)
    active = {t["owner_key"] for s in seasons if s["year"] == cur_year for t in s["teams"]}
    table = []
    for k, tl in timeline.items():
        peak = max(tl, key=lambda x: x["elo"]); low = min(tl, key=lambda x: x["elo"])
        prev = tl[-2]["elo"] if len(tl) > 1 else tl[-1]["elo"]
        table.append({"owner_key": k, "franchise": fr.get(k), "elo": round(r[k], 1), "change": round(r[k] - prev, 1),
                      "peak": peak, "low": low, "active": k in active})
    table.sort(key=lambda x: -x["elo"])
    return {"ratings": table, "timeline": dict(timeline), "current": {k: v for k, v in r.items()},
            "upsets": sorted(upsets, key=lambda u: u["win_p"])[:10],
            "accuracy": {"games": n_pred, "hit_rate": round(hits / n_pred, 3) if n_pred else None,
                         "brier": round(brier / n_pred, 3) if n_pred else None},
            "k": ELO_K, "carry": ELO_CARRY}


def _points_p(diff: float) -> float:
    return 0.5 * (1 + math.erf(diff / POINTS_SD / 2 ** 0.5))


def points_backtest(games: list[dict]) -> dict:
    """How well a season-to-date scoring average picked winners (needs 2+ games for both teams)."""
    hist = defaultdict(list); n = hits = 0; brier = 0.0
    for g in games:
        y = g["year"]
        xa = [s for yy, s in hist[g["a_key"]] if yy == y]; xb = [s for yy, s in hist[g["b_key"]] if yy == y]
        if len(xa) >= 2 and len(xb) >= 2 and g["a_score"] != g["b_score"]:
            pa = _points_p(sum(xa) / len(xa) - sum(xb) / len(xb)); sa = g["a_score"] > g["b_score"]
            n += 1; hits += (pa > 0.5) == sa; brier += (pa - sa) ** 2
        hist[g["a_key"]].append((y, g["a_score"] / g["weeks"])); hist[g["b_key"]].append((y, g["b_score"] / g["weeks"]))
    return {"games": n, "hit_rate": round(hits / n, 3) if n else None, "brier": round(brier / n, 3) if n else None}


def predictions(seasons: list[dict], ratings: dict) -> dict | None:
    """Next scheduled, unplayed matchup period of the current season."""
    s = max(seasons, key=lambda s: s["year"])
    if s["complete"]:
        return None
    pending = [m for m in s["matchups"] if m["winner"] == "UNDECIDED" and m["away"] is not None]
    if not pending:
        return None
    week = min(m["period"] for m in pending)
    teams = {t["team_id"]: t for t in s["teams"]}
    reg = s["settings"]["reg_season_periods"]
    scores = defaultdict(list)
    for m in s["matchups"]:
        if m["winner"] != "UNDECIDED" and m["period"] <= reg and m["away"] is not None:
            scores[m["home"]].append(m["home_score"] or 0); scores[m["away"]].append(m["away_score"] or 0)
    def avg(t):
        xs = scores[t]
        return sum(xs) / len(xs) if xs else 0.0
    out = []
    for m in pending:
        if m["period"] != week:
            continue
        a, b = teams[m["home"]], teams[m["away"]]
        pe = _p(ratings.get(a["owner_key"], ELO_BASE), ratings.get(b["owner_key"], ELO_BASE))
        ma, mb = avg(a["team_id"]), avg(b["team_id"])
        ps = _points_p(ma - mb)
        out.append({"a": a["name"], "a_key": a["owner_key"], "b": b["name"], "b_key": b["owner_key"],
                    "elo_p": round(pe, 3), "score_p": round(ps, 3), "p": round((pe + ps) / 2, 3),
                    "a_avg": round(ma, 1), "b_avg": round(mb, 1), "playoff": m["period"] > reg})
    return {"year": s["year"], "week": week, "games": sorted(out, key=lambda g: -abs(g["p"] - 0.5))}


# ------------------------------------------------------------------ playoff clutch
def clutch(seasons: list[dict], games: list[dict], p1: dict, fr: dict) -> dict:
    avg = {}
    for y, st in p1["seasons"].items():
        for r in st["standings"]:
            avg[(int(y), r["owner_key"])] = r["ppg"]
    rows = defaultdict(lambda: {"games": [], "w": 0, "l": 0, "titles": 0, "finals": 0})
    finals = {}
    for s in seasons:
        reg = s["settings"]["reg_season_periods"]
        last = max((m["period"] for m in s["matchups"] if m["tier"] == "WINNERS_BRACKET"), default=None)
        finals[s["year"]] = last
    for g in games:
        if not g["playoff"]:
            continue
        for me in ("a", "b"):
            x = _side(g, me)
            base = avg.get((g["year"], x["owner_key"]))
            if base is None:
                continue
            per_wk = x["score"] / g["weeks"]
            r = rows[x["owner_key"]]
            final = g["week"] == finals.get(g["year"])
            r["games"].append({**x, "per_week": round(per_wk, 1), "season_avg": base, "diff": round(per_wk - base, 1), "final": final})
            r["w" if x["margin"] > 0 else "l"] += 1
            r["finals"] += final; r["titles"] += final and x["margin"] > 0
    out = []
    for k, r in rows.items():
        d = [g["diff"] for g in r["games"]]
        out.append({"owner_key": k, "franchise": fr.get(k), "n": len(d), "w": r["w"], "l": r["l"],
                    "finals": r["finals"], "titles": r["titles"],
                    "clutch": round(sum(d) / len(d), 1), "best": max(r["games"], key=lambda g: g["diff"]),
                    "worst": min(r["games"], key=lambda g: g["diff"]),
                    "games": sorted(r["games"], key=lambda g: (g["year"], g["week"]), reverse=True)})
    out.sort(key=lambda r: -r["clutch"])
    return {"teams": out, "no_playoffs": sorted(fr[k] for k in fr if k not in rows)}


# ------------------------------------------------------------------ style cards
TRAITS = [
    # metric, high label, low label, high blurb, low blurb
    ("adds", "Waiver Hawk", "Set and Forget", "lives on the waiver wire", "rarely touches the wire"),
    ("avg_bid", "Big Spender", "Bargain Hunter", "pays up for the hot name", "wins claims on the cheap"),  # FAAB $ per add
    ("efficiency", "Lineup Sniper", "Bench Regret", "starts the right guys", "leaves points on the bench"),
    ("avg_steal", "Value Shopper", "Reach Artist", "lets players fall to them", "grabs players before consensus"),
    ("trades", "Wheeler-Dealer", "Trade Hermit", "always working the phones", "keeps the roster they drafted"),
    ("early_rb", "RB Truther", "WR Lover", "loads up on early RBs", "goes receivers early"),
    ("qb_round", "Late-Round QB", "QB Early Bird", "waits on quarterback", "takes a QB early"),
    ("clutch", "Playoff Riser", "Playoff Shrinker", "scores more in the playoffs", "cools off in the playoffs"),
]


def styles(seasons: list[dict], p1: dict, p2: dict | None, p3: dict | None, cl: dict, fr: dict) -> list[dict]:
    m = defaultdict(dict)
    yrs = defaultdict(set)
    for s in seasons:
        for t in s["teams"]:
            yrs[t["owner_key"]].add(s["year"])
            m[t["owner_key"]]["trades_total"] = m[t["owner_key"]].get("trades_total", 0) + (t.get("trades") or 0)
    for k in m:
        m[k]["trades"] = m[k]["trades_total"] / len(yrs[k])
    at = {r["owner_key"]: r for r in p1["all_time"]}
    for k, r in at.items():
        m[k]["efficiency"] = None
    eff = defaultdict(lambda: [0.0, 0.0])
    for st in p1["seasons"].values():
        for r in st["standings"]:
            if r.get("optimal_pf"):
                eff[r["owner_key"]][0] += r["lineup_pf"]; eff[r["owner_key"]][1] += r["optimal_pf"]
    for k, (a, o) in eff.items():
        m[k]["efficiency"] = a / o if o else None
    if p2:
        adds = defaultdict(lambda: [0, 0]); bids = defaultdict(list)
        for y, w in p2["seasons"].items():
            for t in w["teams"]:
                adds[t["owner_key"]][0] += t["adds"]; adds[t["owner_key"]][1] += 1
            if w["faab"]:
                for t in w["teams"]:
                    if t["faab_spent"]:
                        bids[t["owner_key"]].append(t["faab_spent"] / max(1, t["adds"]))
        for k, (n, s) in adds.items():
            m[k]["adds"] = n / s
        for k, v in bids.items():
            m[k]["avg_bid"] = sum(v) / len(v)
    if p3:
        st = defaultdict(list); rb = defaultdict(lambda: [0, 0]); qb = defaultdict(list)
        for y, d in p3["seasons"].items():
            firstqb = {}
            for p in sorted(d["picks"], key=lambda p: p["overall"]):
                k = p["owner_key"]
                if d["adp_source"] == "FantasyPros" and p["steal"] is not None:
                    st[k].append(p["steal"])
                if p["round"] <= 3 and p["pos"] in ("RB", "WR"):
                    rb[k][0] += p["pos"] == "RB"; rb[k][1] += 1
                if p["pos"] == "QB" and (k, y) not in firstqb:
                    firstqb[(k, y)] = p["round"]; qb[k].append(p["round"])
        for k, v in st.items():
            m[k]["avg_steal"] = sum(v) / len(v)
        for k, (r, n) in rb.items():
            m[k]["early_rb"] = r / n if n else None
        for k, v in qb.items():
            m[k]["qb_round"] = sum(v) / len(v)
    for r in cl["teams"]:
        if r["n"] >= 3:
            m[r["owner_key"]]["clutch"] = r["clutch"]

    keys = [k for k in m if len(yrs[k]) >= 2]   # one-season franchises are too new to profile
    def pct(metric, v):
        vals = [m[k].get(metric) for k in keys if m[k].get(metric) is not None]
        if v is None or not vals:
            return None
        return round(100 * (sum(x < v for x in vals) + 0.5 * sum(x == v for x in vals)) / len(vals))
    cards = []
    for k in m:
        bars, traits = [], []
        for metric, hi, lo, hib, lob in TRAITS:
            v = m[k].get(metric)
            p = pct(metric, v) if k in keys else None
            bars.append({"metric": metric, "value": round(v, 3) if v is not None else None, "pct": p, "hi": hi, "lo": lo})
            if p is not None and (p >= 75 or p <= 25):
                traits.append({"label": hi if p >= 75 else lo, "blurb": hib if p >= 75 else lob, "strength": abs(p - 50)})
        traits.sort(key=lambda t: -t["strength"])
        cards.append({"owner_key": k, "franchise": fr.get(k), "seasons": len(yrs[k]), "traits": traits[:3],
                      "bars": bars, "new": k not in keys})
    return sorted(cards, key=lambda c: (c["new"], (c["franchise"] or "").lower()))


# ------------------------------------------------------------------ last-place curse
CURSE_LINES = {
    "injury": [
        "{player} spent more time in the trainer's room than in {team}'s lineup: {gp} of {weeks} weeks played.",
        "The {slot} pick bought {team} {gp} weeks of {player} and a season of injury reports.",
        "{player} answered the bell {gp} times in {weeks} weeks. {team} heard it ring the rest of the year.",
    ],
    "bust": [
        "Drafted as {pos_adp}, played like {pos_finish}. {player} gave {team} {pts} points from the {slot} pick.",
        "{team} spent the {slot} pick on {player} (ADP {adp}). The return: {pts} points and a {pos_finish} finish.",
        "Consensus said {pos_adp}. {player} said {pos_finish}. {team} said goodbye to the season.",
    ],
}


def curse(seasons: list[dict], p3: dict | None) -> list[dict]:
    if not p3:
        return []
    out = []
    for s in sorted(seasons, key=lambda s: s["year"]):
        d = p3["seasons"].get(s["year"])
        if not s["complete"] or not d:
            continue
        ranked = [t for t in s["teams"] if t.get("final_rank")]
        if not ranked:
            continue
        last = max(ranked, key=lambda t: t["final_rank"])
        picks = [p for p in d["picks"] if p["team_id"] == last["team_id"] and p["round"] <= 6 and p["pick_value"] is not None]
        if not picks:
            continue
        p = min(picks, key=lambda p: p["pick_value"])
        reg = s["settings"]["reg_season_periods"]
        sps = {sp for per, xs in s["settings"]["matchup_periods"].items() if int(per) <= reg for sp in xs}
        pl = next((v for k, v in s["players"].items() if v["name"] == p["player"]), {"wk": {}})
        gp = sum(1 for sp, v in pl["wk"].items() if int(sp) in sps and v != 0)
        kind = "injury" if gp <= len(sps) * 0.6 else "bust"
        lines = CURSE_LINES[kind]
        text = lines[s["year"] % len(lines)].format(
            player=p["player"], team=last["name"], gp=gp, weeks=len(sps), pts=round(p["pts"]),
            slot=f'{p["round"]}.{p["round_pick"]:02d}', adp=round(p["adp"]) if p["adp"] else "–",
            pos_adp=p["pos_adp"] or p["pos"], pos_finish=p["pos_finish"] or "off the charts")
        out.append({"year": s["year"], "team": last["name"], "franchise": last.get("franchise"), "owner_key": last["owner_key"],
                    "player": p["player"], "pos": p["pos"], "slot": f'{p["round"]}.{p["round_pick"]:02d}',
                    "adp": p["adp"], "pts": p["pts"], "pos_adp": p["pos_adp"], "pos_finish": p["pos_finish"],
                    "games": gp, "weeks": len(sps), "kind": kind, "pick_value": p["pick_value"],
                    "title": f'The Curse of {p["player"]}', "text": text})
    return list(reversed(out))


def build(seasons: list[dict], p1: dict, p2: dict | None, p3: dict | None) -> dict:
    fr = {r["owner_key"]: r["franchise"] for r in p1["all_time"]}
    games = _games(seasons)
    e = elo(games, fr, seasons)
    cl = clutch(seasons, games, p1, fr)
    return {
        "records": records(seasons, games, fr, p1),
        "elo": {k: v for k, v in e.items() if k != "current"},
        "predictions": predictions(seasons, e["current"]),
        "points_backtest": points_backtest(games),
        "clutch": cl,
        "styles": styles(seasons, p1, p2, p3, cl, fr),
        "curse": curse(seasons, p3),
    }
