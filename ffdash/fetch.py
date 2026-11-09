"""Pull every available season from ESPN into normalized per-season JSON (data/raw/<year>.json).

Uses espn_api for auth, endpoint switching (leagueHistory for old seasons) and team parsing.
Weekly lineups are read from the raw mBoxscore view so pre-2019 seasons are attempted too
(espn_api's box_scores() refuses them); whatever ESPN does not return is recorded in `coverage`.
"""
from __future__ import annotations

import json
from collections import defaultdict
import logging
import time
from pathlib import Path

from espn_api.football import League
from espn_api.football.constant import POSITION_MAP

from .config import ROOT, Config

log = logging.getLogger(__name__)
RAW_DIR = ROOT / "data" / "raw"
CACHE_VERSION = 4  # bump when the normalized shape changes, to force a refetch
BENCH_SLOTS = {20, 21}  # BE, IR
DEFAULT_POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}  # player.defaultPositionId


def _league(cfg: Config, year: int) -> League:
    return League(league_id=cfg.league_id, year=year, espn_s2=cfg.espn_s2, swid=cfg.swid)


def _get(league: League, **kw):
    for attempt in range(4):
        try:
            return league.espn_request.league_get(**kw)
        except Exception as e:  # ESPN rate-limits / flakes now and then
            if attempt == 3:
                raise
            log.warning("retrying ESPN request (%s)", e)
            time.sleep(2 ** attempt)


def _owner_ids(league: League) -> set:
    """Member ids only. Names (first/last/display) are never read or stored."""
    return {m["id"] for m in (league.members or []) if m.get("id")}


def _teams(league: League) -> list[dict]:
    teams = []
    for t in league.teams:
        owner_ids = [o["id"] if isinstance(o, dict) else o for o in (t.owners or [])]
        teams.append({
            "team_id": t.team_id,
            "name": t.team_name,
            "abbrev": t.team_abbrev,
            "owner_ids": owner_ids,
            "division_id": t.division_id,
            "division": t.division_name,
            "final_rank": t.final_standing or None,
            "seed": t.standing or None,
            "espn_wins": t.wins, "espn_losses": t.losses, "espn_ties": t.ties,
            "espn_pf": t.points_for, "espn_pa": t.points_against,
            "acquisitions": t.acquisitions, "faab_spent": t.acquisition_budget_spent,
            "trades": t.trades,
        })
    return teams


def _matchups(league: League) -> list[dict]:
    data = _get(league, params={"view": "mMatchupScore"})
    out = []
    for m in data.get("schedule", []):
        home, away = m.get("home", {}), m.get("away")
        out.append({
            "period": m["matchupPeriodId"],
            "home": home.get("teamId"),
            "home_score": home.get("totalPoints"),
            "away": away.get("teamId") if away else None,  # None = bye
            "away_score": away.get("totalPoints") if away else None,
            "winner": m.get("winner", "UNDECIDED"),
            "tier": m.get("playoffTierType", "NONE"),
        })
    return out


def _lineups(league: League, scoring_periods: list[int]) -> dict:
    """{scoring_period: {team_id: [player rows]}}; empty dict for a period ESPN gave no rosters for."""
    out = {}
    for sp in scoring_periods:
        data = _get(league, params={"view": ["mMatchupScore", "mBoxscore"], "scoringPeriodId": sp})
        week = {}
        for m in data.get("schedule", []):
            for side in ("home", "away"):
                s = m.get(side)
                if not s:
                    continue
                roster = s.get("rosterForCurrentScoringPeriod") or s.get("rosterForMatchupPeriod")
                if not roster or not roster.get("entries"):
                    continue
                rows = []
                for e in roster["entries"]:
                    ppe = e.get("playerPoolEntry", {})
                    p = ppe.get("player", {})
                    pts = ppe.get("appliedStatTotal")
                    if pts is None:  # fall back to this period's actual stat line
                        pts = next((st.get("appliedTotal", 0) for st in p.get("stats", [])
                                    if st.get("scoringPeriodId") == sp and st.get("statSourceId") == 0), 0)
                    rows.append({
                        "pid": p.get("id", e.get("playerId")),
                        "name": p.get("fullName", ""),
                        "pos": DEFAULT_POS.get(p.get("defaultPositionId")) or _main_pos(p.get("eligibleSlots", [])),
                        "slot": e.get("lineupSlotId"),
                        "elig": [s for s in p.get("eligibleSlots", []) if s not in BENCH_SLOTS],
                        "pts": round(float(pts or 0), 2),
                    })
                week[s["teamId"]] = rows
        if week:
            out[sp] = week
    return out


def _transactions(league: League, last_period: int) -> list[dict]:
    """Waiver/free-agent claims (executed and failed, so losing bids are kept) for periods 0..last."""
    out, seen = [], set()
    for sp in range(0, last_period + 1):
        data = _get(league, params={"view": "mTransactions2", "scoringPeriodId": sp})
        for t in data.get("transactions", []):
            if t.get("type") not in ("WAIVER", "FREEAGENT") or t.get("id") in seen:
                continue
            seen.add(t.get("id"))
            items = t.get("items") or []
            adds = [i["playerId"] for i in items if i.get("type") == "ADD"]
            if not adds:
                continue
            out.append({
                "id": t.get("id"), "type": t["type"], "status": t.get("status"),
                "sp": t.get("scoringPeriodId"), "date": t.get("processDate") or t.get("proposedDate"),
                "team": t.get("teamId"), "bid": t.get("bidAmount") or 0,
                "adds": adds, "drops": [i["playerId"] for i in items if i.get("type") == "DROP"],
            })
    return out


def _player_rows(players: list, year: int) -> dict:
    out = {}
    for pl in players:
        p = pl.get("player", pl)
        wk = defaultdict(float)
        for st in p.get("stats", []):
            if st.get("seasonId") == year and st.get("statSourceId") == 0 and st.get("statSplitTypeId") == 1:
                wk[st["scoringPeriodId"]] += st.get("appliedTotal", 0) or 0
        out[p["id"]] = {
            "name": p.get("fullName", ""),
            "pos": DEFAULT_POS.get(p.get("defaultPositionId")) or _main_pos(p.get("eligibleSlots", [])),
            "pro_team": p.get("proTeamId"),
            "espn_adp": (p.get("ownership") or {}).get("averageDraftPosition"),
            "wk": {sp: round(v, 2) for sp, v in sorted(wk.items())},
        }
    return out


def _draft(league: League, year: int, final_period: int) -> tuple[list, dict]:
    """Draft picks plus weekly league-scoring points for the season's top 400 scorers and every drafted player."""
    d = _get(league, params={"view": "mDraftDetail"}).get("draftDetail", {})
    if not d.get("drafted"):
        return [], {}
    picks = [{
        "overall": p.get("overallPickNumber") or i + 1, "round": p.get("roundId"), "round_pick": p.get("roundPickNumber"),
        "team": p.get("teamId"), "pid": p.get("playerId"), "keeper": bool(p.get("keeper")),
    } for i, p in enumerate(d.get("picks", []))]
    stat_filter = {"value": final_period, "additionalValue": [f"00{year}", f"10{year}"]}
    top = _get(league, params={"view": "kona_player_info", "scoringPeriodId": 0}, headers={"x-fantasy-filter": json.dumps(
        {"players": {"limit": 400, "sortAppliedStatTotal": {"sortAsc": False, "sortPriority": 1, "value": f"00{year}"},
                     "filterStatsForTopScoringPeriodIds": stat_filter}})})
    players = _player_rows(top.get("players", []), year)
    missing = [p["pid"] for p in picks if p["pid"] not in players]
    for i in range(0, len(missing), 50):
        card = league.espn_request.get_player_card(missing[i:i + 50], final_period)
        players.update(_player_rows(card.get("players", []), year))
    return picks, players


def _main_pos(slots: list[int]) -> str:
    for s in slots:
        name = POSITION_MAP.get(s, "")
        if s != 25 and "/" not in name and name not in ("OP", "BE", "IR", ""):
            return name
    return POSITION_MAP.get(slots[0], "") if slots else ""


def _slot_counts(league: League) -> dict:
    data = _get(league, params={"view": "mSettings"})
    counts = data.get("settings", {}).get("rosterSettings", {}).get("lineupSlotCounts", {})
    return {int(k): v for k, v in counts.items() if v and int(k) not in BENCH_SLOTS}


def fetch_season(cfg: Config, year: int) -> dict:
    lg = _league(cfg, year)
    s = lg.settings
    matchup_periods = {int(k): v for k, v in (s.matchup_periods or {}).items()}
    matchups = _matchups(lg)
    done = [m for m in matchups if m["winner"] != "UNDECIDED"]
    last_done = max((m["period"] for m in done), default=0)
    scoring_periods = sorted({sp for p, sps in matchup_periods.items() if p <= last_done for sp in sps})
    lineups = _lineups(lg, scoring_periods) if scoring_periods else {}
    owners = _owner_ids(lg)
    tx_last = max(scoring_periods) if scoring_periods else 0
    transactions = _transactions(lg, tx_last + 1 if year == cfg.current_season else tx_last)
    picks, draft_players = _draft(lg, year, lg.finalScoringPeriod)
    tx_pids = {pid for t in transactions for pid in t["adds"] + t["drops"]}
    player_names = {pid: lg.player_map.get(pid) for pid in tx_pids if isinstance(lg.player_map.get(pid), str)}
    divisions = {}
    for t in lg.teams:
        divisions[t.division_id] = t.division_name

    coverage = {
        "scores": bool(done),
        "lineups": bool(lineups) and len(lineups) == len(scoring_periods),
        "lineup_periods": len(lineups),
        "lineup_periods_expected": len(scoring_periods),
        "owners": bool(owners),
        "transactions": bool(transactions),
        "draft": bool(picks),
        "faab": bool(s.faab),
        "notes": [],
    }
    if not transactions:
        coverage["notes"].append("ESPN returned no waiver/free-agent transactions: waiver stats unavailable.")
    if not done:
        coverage["notes"].append("No completed matchups returned.")
    if scoring_periods and not lineups:
        coverage["notes"].append("ESPN returned no weekly lineups: start/sit regret unavailable.")
    elif lineups and len(lineups) < len(scoring_periods):
        coverage["notes"].append(f"Lineups for only {len(lineups)} of {len(scoring_periods)} scoring periods.")
    if not owners:
        coverage["notes"].append("No manager ids: all-time franchise stats may merge or split teams incorrectly.")

    return {
        "cache_version": CACHE_VERSION,
        "year": year,
        "complete": year < cfg.current_season,
        "fetched_at": int(time.time()),
        "settings": {
            "name": s.name,
            "team_count": s.team_count,
            "reg_season_periods": s.reg_season_count,
            "playoff_team_count": s.playoff_team_count,
            "median_scoring": s.median_scoring,
            "faab": s.faab,
            "faab_budget": s.acquisition_budget,
            "slot_counts": _slot_counts(lg),
            "matchup_periods": matchup_periods,
            "divisions": divisions,
        },
        "teams": _teams(lg),
        "matchups": matchups,
        "lineups": lineups,
        "transactions": transactions,
        "player_names": player_names,
        "draft": picks,
        "players": draft_players,
        "draft_date": _get(lg, params={"view": "mDraftDetail"}).get("draftDetail", {}).get("completeDate"),
        "rec_points": next((i.get("points") for i in _get(lg, params={"view": "mSettings"}).get("settings", {})
                            .get("scoringSettings", {}).get("scoringItems", []) if i.get("statId") == 53), 0),
        "coverage": coverage,
        "_previous_seasons": lg.previousSeasons,
    }


def fetch_all(cfg: Config, refresh: bool = False) -> list[dict]:
    """Fetch current season fresh; reuse cached completed seasons unless refresh."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    seasons, missing = [], []
    current = fetch_season(cfg, cfg.current_season)
    _save(current)
    seasons.append(current)
    years = sorted({y for y in current["_previous_seasons"] if y >= cfg.first_season}, reverse=True)
    for y in years:
        path = RAW_DIR / f"{y}.json"
        if path.exists() and not refresh:
            cached = json.loads(path.read_text())
            if cached.get("cache_version") == CACHE_VERSION and cached.get("complete"):
                seasons.append(cached)
                continue
        try:
            log.info("fetching %s", y)
            d = fetch_season(cfg, y)
            _save(d)
            seasons.append(d)
        except Exception as e:
            log.warning("season %s unavailable: %s", y, e)
            missing.append({"year": y, "reason": str(e)})
    return sorted(seasons, key=lambda d: d["year"]), missing


def _save(d: dict) -> None:
    (RAW_DIR / f"{d['year']}.json").write_text(json.dumps(d))
