# League analytics dashboard

Static dashboard for ESPN fantasy football league 53948101. A weekly GitHub Action pulls
every season from ESPN, runs the analysis and publishes the site to GitHub Pages.

Libraries (pip, not forks): [espn_api](https://github.com/cwendt94/espn-api) for ESPN data,
[nflreadpy](https://github.com/nflverse/nflreadpy) for FantasyPros consensus rankings (draft phase).

## Stats

1. **Standings and luck** (done): H2H record, all-play record, luck index (actual wins minus
   all-play expected wins), median-format record, start/sit regret (best hindsight lineup minus
   lineup used), champions by season, all-time owner table.
2. **Waivers** (done): started points per add, points per FAAB dollar, overpay vs next-highest bid, best pickups, busts, all-time waiver table.
3. **Draft vs ADP** (done): FantasyPros consensus (nflreadpy) vs our picks and regular-season points; steals, reaches, most/least valuable picks, draft boards, all-time draft record.
4. **Simulations** (done): ESPN seeding/bracket engine validated against every real season; weighted scoring, schedule swap, 10,000 random schedules and division setups (title odds, how often the title changes hands), live playoff/title odds for the current season.

## Local use

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # fill in ESPN_S2 and SWID
.venv/bin/python -m ffdash.build            # fetch + build site/
.venv/bin/python -m ffdash.build --offline  # rebuild from cached data/raw
.venv/bin/python -m http.server 8765 --directory site
```

Cookies: log in at fantasy.espn.com, open dev tools, Application > Cookies, copy `espn_s2` and `SWID`.
They expire about once a year; update `.env` and the repo secrets when the Action starts failing
with `ESPNAccessDenied`.

## Deploy (free)

1. Push to a **public** GitHub repo (free GitHub Pages needs a public repo on a free plan).
   The repo holds no secrets and no league data; data lives only in the published site.
2. Settings > Secrets and variables > Actions: add `ESPN_S2` and `SWID`.
3. Settings > Pages > Source: **GitHub Actions**.
4. Actions > Weekly dashboard > Run workflow. It then runs every Tuesday.

Config that is not secret lives in `league.toml`.

## Data notes

ESPN returns this league back to 2020. The dashboard's Data notes tab lists, per season, any
missing scores, lineups or owner info, plus league changes (size, lineup slots, season length)
and owner account merges.
