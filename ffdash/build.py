"""CLI: fetch ESPN data, run analyses, write the static site.

    python -m ffdash.build              # fetch (cached past seasons) + analyze + write site/
    python -m ffdash.build --refresh    # refetch every season
    python -m ffdash.build --offline    # analyze cached data/raw only
"""
from __future__ import annotations

import argparse
import json
import logging
import shutil
import time
from pathlib import Path

from . import config
from .analysis import phase1, phase2, phase3, phase4
from .config import ROOT

SITE = ROOT / "site"
WEB = ROOT / "web"


def _coverage(seasons: list[dict], missing: list[dict], add_gaps: dict | None = None,
              draft_notes: dict | None = None) -> list[dict]:
    from espn_api.football.constant import POSITION_MAP
    rows, prev = [], None
    for s in sorted(seasons, key=lambda s: s["year"]):
        c = {"year": s["year"], "available": True, **s["coverage"]}
        c["notes"] = list(c.get("notes", []))
        c["changes"] = []
        st = s["settings"]
        slots = ", ".join(f"{v} {POSITION_MAP.get(int(k), k)}" for k, v in sorted(st["slot_counts"].items(), key=lambda kv: int(kv[0])))
        if prev is None:
            c["changes"].append(f"Earliest season ESPN has for this league. {st['team_count']} teams; lineup: {slots}.")
        else:
            if st["team_count"] != prev["team_count"]:
                c["changes"].append(f"League size changed {prev['team_count']} to {st['team_count']} teams: compare all-play % and luck, not raw wins.")
            if st["slot_counts"] != prev["slot_counts"]:
                c["changes"].append(f"Lineup format changed: {slots}.")
            if st["reg_season_periods"] != prev["reg_season_periods"]:
                c["changes"].append(f"Regular season {prev['reg_season_periods']} to {st['reg_season_periods']} weeks.")
        if not st.get("faab"):
            c["notes"].append("No FAAB this season (waiver priority): per-dollar waiver stats unavailable.")
        gap, faab_gap = (add_gaps or {}).get(s["year"], (0, 0))
        if faab_gap:
            c["notes"].append(f"FAAB spent per team differs from ESPN's team totals by ${faab_gap} combined; waiver stats use the transaction log.")
        if gap:
            c["notes"].append(f"ESPN's add counter shows {abs(gap)} {'fewer' if gap > 0 else 'more'} adds than its transaction log; waiver stats use the log.")
        c["notes"] += (draft_notes or {}).get(s["year"], [])
        prev = st
        rows.append(c)
    rows += [{"year": m["year"], "available": False, "scores": False, "lineups": False, "owners": False,
              "notes": [f"Season not returned by ESPN: {m['reason']}"], "changes": []} for m in missing]
    return sorted(rows, key=lambda r: r["year"], reverse=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if args.offline:
        import tomllib
        from .fetch import RAW_DIR
        t = tomllib.loads((ROOT / "league.toml").read_text())
        my_team, current = int(t["my_team_id"]), int(t["current_season"])
        seasons = sorted((json.loads(p.read_text()) for p in RAW_DIR.glob("[0-9][0-9][0-9][0-9].json")), key=lambda d: d["year"])
        missing = []
    else:
        from .fetch import fetch_all
        cfg = config.load()
        my_team, current = cfg.my_team_id, cfg.current_season
        seasons, missing = fetch_all(cfg, refresh=args.refresh)

    if not seasons:
        raise SystemExit("No season data.")
    cur = next((s for s in seasons if s["year"] == current), seasons[-1])

    p1 = phase1.build(seasons)  # also sets hashed owner_key on every team
    p2 = phase2.build(seasons)
    p3 = phase3.build(seasons, refresh_adp=args.refresh)
    p4 = phase4.build(seasons)
    draft_notes = {}
    for y, d in p3["seasons"].items():
        n = []
        if d["adp_source"] == "ESPN":
            n.append("No FantasyPros snapshot before this draft: ADP is ESPN's average draft position. "
                     "Pick values this season run low and are left out of all-time draft totals.")
        if d["keepers"]:
            n.append(f"{d['keepers']} keepers: excluded from steals/reaches (their slot is a keeper cost, not a pick).")
        if d["unmatched"]:
            n.append(f"{len(d['unmatched'])} drafted players had no consensus rank: {', '.join(d['unmatched'][:5])}{'…' if len(d['unmatched']) > 5 else ''}.")
        draft_notes[y] = n
    gaps = {y: (w["add_count_gap"], w["faab_gap"]) for y, w in p2["seasons"].items()}
    league = {
        "name": cur["settings"]["name"],
        "current_season": current,
        "seasons": [s["year"] for s in seasons],
        "generated_at": int(time.time()),
        "coverage": _coverage(seasons, missing, gaps, draft_notes),
    }

    if SITE.exists():
        shutil.rmtree(SITE)
    shutil.copytree(WEB, SITE)
    (SITE / "data").mkdir(exist_ok=True)
    (SITE / "data" / "league.json").write_text(json.dumps(league))
    (SITE / "data" / "phase1.json").write_text(json.dumps(p1))
    (SITE / "data" / "phase2.json").write_text(json.dumps(p2))
    (SITE / "data" / "phase3.json").write_text(json.dumps(p3))
    (SITE / "data" / "phase4.json").write_text(json.dumps(p4))
    logging.info("wrote %s (%d seasons, %d missing)", SITE, len(seasons), len(missing))


if __name__ == "__main__":
    main()
