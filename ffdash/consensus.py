"""Pre-draft consensus ADP per season.

Source: FantasyPros expert consensus rankings (ECR) archived by nflverse / DynastyProcess, read with
nflreadpy. We take the PPR overall cheatsheet snapshot closest before the league's draft. (The
archive has PPR, not half-PPR, rankings; the order is nearly identical.) Seasons with no
snapshot (2020: archive starts Oct 2020) fall back to ESPN's own ADP and are flagged.

Each season's result is cached in data/raw/adp_<year>.json: a draft's consensus never changes,
and the weekly build should not depend on a large download succeeding.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re

from espn_api.football.constant import PRO_TEAM_MAP

from .fetch import RAW_DIR

log = logging.getLogger(__name__)
ADP_VERSION = 1
TEAM_ALIASES = {"WAS": "WSH", "JAC": "JAX", "LA": "LAR", "OAK": "LV", "SD": "LAC", "STL": "LAR"}


def _norm(name: str) -> str:
    n = re.sub(r"[^a-z ]", "", (name or "").lower())
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    return re.sub(r"\s+", "", n)


_cache: dict = {}


def _fp_tables():
    if "fp" not in _cache:
        import nflreadpy as nfl
        import polars as pl
        r = (nfl.load_ff_rankings("all")
             .with_columns(pl.col("scrape_date").cast(pl.Utf8))
             .filter((pl.col("page_type") == "redraft-overall") & pl.col("fp_page").str.contains("ppr-cheatsheets")))
        ids = nfl.load_ff_playerids().select("espn_id", "fantasypros_id").drop_nulls()
        _cache["fp"] = (r, {int(e): str(f) for e, f in ids.iter_rows()})
    return _cache["fp"]


def _from_fantasypros(season: dict) -> dict | None:
    import polars as pl
    year = season["year"]
    if not season.get("draft_date"):
        return None
    draft_day = dt.datetime.fromtimestamp(season["draft_date"] / 1000, dt.timezone.utc).strftime("%Y-%m-%d")
    r, e2f = _fp_tables()
    snap = r.filter((pl.col("scrape_date") <= draft_day) & (pl.col("scrape_date") >= f"{year}-06-01"))
    if snap.height == 0:
        return None
    date = snap["scrape_date"].max()
    snap = snap.filter(pl.col("scrape_date") == date)
    by_fp = {str(i): (ecr, pos) for i, ecr, pos in snap.select("id", "ecr", "pos").iter_rows()}
    by_dst = {TEAM_ALIASES.get(t, t): ecr for t, ecr in snap.filter(pl.col("pos") == "DST").select("team", "ecr").iter_rows()}
    by_name = {}
    for name, ecr, pos in snap.select("player", "ecr", "pos").iter_rows():
        by_name.setdefault((_norm(name), pos), ecr)
    ranks, unmatched = {}, []
    for pid, p in season["players"].items():
        hit = None
        if p["pos"] == "D/ST":
            hit = by_dst.get(TEAM_ALIASES.get(PRO_TEAM_MAP.get(p.get("pro_team"), ""), PRO_TEAM_MAP.get(p.get("pro_team"), "")))
        else:
            fp = e2f.get(int(pid))
            hit = by_fp.get(fp, (None,))[0] if fp else None
            if hit is None:
                hit = by_name.get((_norm(p["name"]), p["pos"]))
        if hit is not None:
            ranks[pid] = float(hit)
    drafted = {str(d["pid"]) for d in season["draft"]}
    unmatched = sorted(season["players"][pid]["name"] for pid in drafted if pid not in ranks)
    return {"source": "FantasyPros", "detail": f"FantasyPros PPR consensus, {date} (draft {draft_day})",
            "snapshot": date, "ranks": ranks, "unmatched_drafted": unmatched}


def _from_espn(season: dict) -> dict:
    ranks = {pid: float(p["espn_adp"]) for pid, p in season["players"].items() if p.get("espn_adp")}
    drafted = {str(d["pid"]) for d in season["draft"]}
    return {"source": "ESPN", "detail": "ESPN average draft position (no FantasyPros snapshot before this draft)",
            "snapshot": None, "ranks": ranks,
            "unmatched_drafted": sorted(season["players"][pid]["name"] for pid in drafted if pid not in ranks)}


def adp_for(season: dict, refresh: bool = False) -> dict | None:
    if not season.get("draft"):
        return None
    path = RAW_DIR / f"adp_{season['year']}.json"
    if path.exists() and not refresh:
        cached = json.loads(path.read_text())
        if cached.get("version") == ADP_VERSION and cached.get("draft_date") == season.get("draft_date"):
            return cached
    try:
        out = _from_fantasypros(season)
    except Exception as e:  # download hiccup: use cache if any, else ESPN fallback for this run only
        log.warning("FantasyPros rankings unavailable for %s (%s)", season["year"], e)
        if path.exists():
            return json.loads(path.read_text())
        out = _from_espn(season)
        out["detail"] += "; FantasyPros download failed this run"
        return out
    out = out or _from_espn(season)
    out.update(version=ADP_VERSION, draft_date=season.get("draft_date"))
    path.write_text(json.dumps(out))
    return out
