"""League config (league.toml) plus secrets from the environment (.env locally, GitHub secrets in CI)."""
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Config:
    league_id: int
    my_team_id: int
    current_season: int
    first_season: int
    espn_s2: str
    swid: str


def load() -> Config:
    load_dotenv(ROOT / ".env")
    with open(ROOT / "league.toml", "rb") as f:
        t = tomllib.load(f)
    s2, swid = os.environ.get("ESPN_S2", "").strip(), os.environ.get("SWID", "").strip()
    if not s2 or not swid:
        raise SystemExit("ESPN_S2 and SWID must be set (in .env locally or as GitHub secrets).")
    return Config(
        league_id=int(t["league_id"]),
        my_team_id=int(t["my_team_id"]),
        current_season=int(t["current_season"]),
        first_season=int(t.get("first_season", 2004)),
        espn_s2=s2,
        swid=swid,
    )
