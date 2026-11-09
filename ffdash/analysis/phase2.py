"""Phase 2: waiver / free-agent value.

Value of an add = fantasy points the player scored *while in that team's starting lineup*, from the
add until he left that roster. Overpay = winning FAAB bid minus the next-highest bid on the same
player in the same waiver run (uncontested claims overpay by the whole bid).
"""
from __future__ import annotations

from collections import defaultdict

BENCH = {20, 21}


def _processed(t: dict) -> bool:
    return t["status"] == "EXECUTED" or str(t["status"]).startswith("FAILED")


def season_waivers(season: dict) -> dict | None:
    if not season.get("transactions"):
        return None
    teams = {t["team_id"]: t for t in season["teams"]}
    names = {int(k): v for k, v in season.get("player_names", {}).items()}
    faab = bool(season["settings"]["faab"])
    lineups = {int(sp): {int(tid): {r["pid"]: r for r in rows} for tid, rows in wk.items()}
               for sp, wk in season.get("lineups", {}).items()}
    periods = sorted(lineups)
    for wk in lineups.values():
        for roster in wk.values():
            for pid, r in roster.items():
                names.setdefault(pid, r["name"])

    # Bids grouped by (period, player) to find the runner-up bid.
    bids = defaultdict(list)
    for t in season["transactions"]:
        if t["type"] == "WAIVER" and _processed(t):
            for pid in t["adds"]:
                bids[(t["sp"], pid)].append((t["team"], t["bid"], t["status"] == "EXECUTED"))

    adds = []
    for t in season["transactions"]:
        if t["status"] != "EXECUTED":
            continue
        for pid in t["adds"]:
            tid = t["team"]
            started_pts = bench_pts = 0.0
            starts = rostered = 0
            seen = False
            start_sp = max(t["sp"] or 1, 1)
            for p in periods:
                if p < start_sp:
                    continue
                row = lineups[p].get(tid, {}).get(pid)
                if row is None:
                    if seen or p > start_sp:  # first period may be before the claim took effect
                        break
                    continue
                seen = True
                rostered += 1
                if row["slot"] in BENCH:
                    bench_pts += row["pts"]
                else:
                    started_pts += row["pts"]; starts += 1
            others = [b for (team, b, won) in bids.get((t["sp"], pid), []) if team != tid and not won]
            next_bid = max(others) if others else None
            bid = t["bid"] if faab else None
            adds.append({
                "year": season["year"], "team_id": tid, "team": teams.get(tid, {}).get("name", f"Team {tid}"),
                "owner": teams.get(tid, {}).get("owner"), "owner_key": teams.get(tid, {}).get("owner_key"),
                "pid": pid, "player": names.get(pid, f"Player {pid}"), "sp": t["sp"], "type": t["type"],
                "bid": bid, "next_bid": next_bid if faab else None, "bidders": 1 + len(others),
                "overpay": (bid - (next_bid or 0)) if faab and bid else None,
                "started_pts": round(started_pts, 2), "starts": starts, "rostered": rostered,
                "bench_pts": round(bench_pts, 2),
                "pts_per_dollar": round(started_pts / bid, 2) if faab and bid else None,
                "unplayed": not season["complete"] and (not periods or start_sp > periods[-1]),
            })

    by_team = []
    for tid, tm in teams.items():
        mine = [a for a in adds if a["team_id"] == tid]
        spent = sum(a["bid"] or 0 for a in mine)
        pts = sum(a["started_pts"] for a in mine)
        paid = [a for a in mine if a["bid"]]
        by_team.append({
            "team_id": tid, "name": tm["name"], "owner": tm.get("owner"), "owner_key": tm.get("owner_key"),
            "adds": len(mine), "faab_spent": spent if faab else None,
            "started_pts": round(pts, 1),
            "pts_per_add": round(pts / len(mine), 2) if mine else None,
            "faab_pts": round(sum(a["started_pts"] for a in paid), 1),
            "pts_per_dollar": round(sum(a["started_pts"] for a in paid) / spent, 2) if faab and spent else None,
            "overpaid": sum(a["overpay"] or 0 for a in mine) if faab else None,
            "hits": sum(a["started_pts"] >= 50 for a in mine),
            "best": max(mine, key=lambda a: a["started_pts"])["player"] if mine else None,
            "espn_adds": tm.get("acquisitions"), "espn_faab": tm.get("faab_spent"),
        })
    by_team.sort(key=lambda r: r["started_pts"], reverse=True)

    paid = [a for a in adds if a["bid"]]
    return {
        "year": season["year"], "faab": faab, "budget": season["settings"].get("faab_budget"),
        "teams": by_team,
        "best_adds": sorted(adds, key=lambda a: a["started_pts"], reverse=True)[:20],
        "best_value": sorted([a for a in paid if a["started_pts"] > 0], key=lambda a: a["pts_per_dollar"], reverse=True)[:15],
        "overpays": sorted([a for a in paid if a["overpay"]], key=lambda a: (a["overpay"], -a["started_pts"]), reverse=True)[:20],
        "busts": sorted([a for a in paid if a["bid"] >= 10 and not a["unplayed"]], key=lambda a: a["started_pts"] / a["bid"])[:15],
        "faab_gap": sum(abs((t["faab_spent"] or 0) - (t["espn_faab"] or 0)) for t in by_team) if faab else 0,
        "add_count_gap": sum((t["adds"] - (t["espn_adds"] or 0)) for t in by_team),
    }


def build(seasons: list[dict]) -> dict:
    """Expects phase1.resolve_identities() to have set owner_key/owner on teams."""
    out = {s["year"]: w for s in seasons if (w := season_waivers(s))}
    agg = defaultdict(lambda: defaultdict(float))
    names, years = {}, defaultdict(set)
    for w in out.values():
        for t in w["teams"]:
            a = agg[t["owner_key"]]; names[t["owner_key"]] = t["owner"]
            years[t["owner_key"]].add(w["year"]); a["adds"] += t["adds"]; a["started_pts"] += t["started_pts"]; a["hits"] += t["hits"]
            if w["faab"]:
                a["faab_spent"] += t["faab_spent"] or 0
                a["faab_pts"] += t["faab_pts"]
                a["overpaid"] += t["overpaid"] or 0
    rows = [{
        "owner_key": k, "owner": names[k], "seasons": len(years[k]), "adds": int(a["adds"]),
        "started_pts": round(a["started_pts"], 1),
        "pts_per_add": round(a["started_pts"] / a["adds"], 2) if a["adds"] else None,
        "faab_spent": int(a["faab_spent"]),
        "pts_per_dollar": round(a["faab_pts"] / a["faab_spent"], 2) if a["faab_spent"] else None,
        "overpaid": int(a["overpaid"]), "hits": int(a["hits"]),
    } for k, a in agg.items()]
    rows.sort(key=lambda r: r["started_pts"], reverse=True)
    return {"seasons": out, "all_time": rows}
