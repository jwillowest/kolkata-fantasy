"use strict";
(async function () {
  const get = f => fetch("data/" + f).then(r => r.json());
  const [league, p1, p2, p3, p4, p5] = await Promise.all([
    get("league.json"), get("phase1.json"), get("phase2.json").catch(() => null), get("phase3.json").catch(() => null),
    get("phase4.json").catch(() => null), get("phase5.json").catch(() => null),
  ]);
  const ALL = "all";
  const years = Object.keys(p1.seasons).map(Number).sort((a, b) => b - a);
  const cov = Object.fromEntries(league.coverage.map(c => [c.year, c]));
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const NA = '<span class="na">–</span>';
  const num = (v, d = 1) => v == null || Number.isNaN(v) ? NA : Number(v).toFixed(d);
  const int = v => v == null ? NA : Math.round(v).toLocaleString();
  const signed = (v, d = 2) => v == null ? NA : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
  const rec = (w, l, t) => `${w | 0}-${l | 0}${t ? "-" + (t | 0) : ""}`;
  const pct = v => v == null ? "–" : v.toFixed(3).replace(/^0/, "");
  const money = v => v == null ? NA : "$" + v;
  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

  document.title = league.name + " Analytics";
  $("#logo").textContent = league.name;
  $("#updated").textContent = `Seasons ${Math.min(...years)}–${Math.max(...years)} · updated ${new Date(league.generated_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  // ---------- viewer state: highlighted team + percentile mode (per viewer, nothing by default) ----------
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
                  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} } };
  const franchises = p1.all_time.map(r => ({ key: r.owner_key, name: r.franchise }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const validKey = k => franchises.some(f => f.key === k) ? k : null;
  let SEL = validKey(new URLSearchParams(location.search).get("team")) || validKey(store.get("ffdash.team"));
  let PCT = store.get("ffdash.pct") === "1";
  const fname = Object.fromEntries(franchises.map(f => [f.key, f.name]));

  const charts = [];
  // ---------- tabs ----------
  const tabs = [...document.querySelectorAll("#tabs button")];
  function show(name) {
    tabs.forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach(s => (s.hidden = s.id !== "tab-" + name));
    charts.forEach(([el, items, o]) => el.offsetParent && (o.redrawFn ? o.redrawFn() : hbar(el, items, o, true)));
    try { history.replaceState(null, "", location.search + "#" + name); } catch (e) {}
  }
  tabs.forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));
  const initial = location.hash.slice(1);
  if (tabs.some(b => b.dataset.tab === initial)) show(initial);
  addEventListener("hashchange", () => { const h = location.hash.slice(1); if (tabs.some(b => b.dataset.tab === h)) show(h); });

  // ---------- tooltip ----------
  const tip = $("#tip");
  function tipOn(e, html) {
    tip.innerHTML = html; tip.hidden = false;
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = e.clientY + 14 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 14;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  const tipOff = () => (tip.hidden = true);

  // ---------- percentiles ----------
  // Column option `pv: row => number` (a rate, so seasons of different lengths compare) and `low: true`
  // when lower is better. Percentile = share of the comparison pool this value beats (ties count half).
  function percentile(pool, v, low) {
    const vals = pool.filter(x => x != null && !Number.isNaN(x));
    if (v == null || Number.isNaN(v) || !vals.length) return null;
    let below = 0, eq = 0;
    for (const x of vals) { if (x < v) below++; else if (x === v) eq++; }
    const p = (below + eq / 2) / vals.length;
    return Math.round(100 * (low ? 1 - p : p));
  }
  const pcCell = p => p == null ? NA : `<span class="pc ${p >= 75 ? "hi" : p <= 25 ? "lo" : ""}">P${p}</span>`;

  // ---------- table ----------
  function table(el, cols, rows, opts = {}) {
    let sortKey = opts.sort, dir = opts.dir || -1;
    const pool = opts.pool || rows;
    const pools = {};
    if (PCT) cols.forEach(c => { if (c.pv) pools[c.key] = pool.map(c.pv); });
    function cell(c, r) {
      const raw = c.fmt ? c.fmt(r) : esc(r[c.key]);
      if (!PCT || !c.pv) return raw;
      const p = percentile(pools[c.key], c.pv(r), c.low);
      return `<span title="${esc(String(raw).replace(/<[^>]+>/g, ""))}">${pcCell(p)}</span>`;
    }
    function draw() {
      const data = rows.slice();
      if (sortKey) {
        const c = cols.find(c => c.key === sortKey);
        const v = c.sort || (r => r[c.key]);
        data.sort((a, b) => {
          const x = v(a), y = v(b);
          if (x == null) return 1; if (y == null) return -1;
          return (x > y ? 1 : x < y ? -1 : 0) * dir;
        });
      }
      const rk = opts.rowKey || (r => r.owner_key);
      el.innerHTML =
        "<thead><tr>" + cols.map(c => `<th class="${c.l ? "l" : ""}" data-k="${c.key}" ${opts.sortable !== false && sortKey === c.key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}</th>`).join("") + "</tr></thead>" +
        "<tbody>" + data.map(r => `<tr class="${SEL && rk(r) === SEL ? "me" : ""}">` + cols.map(c => `<td class="${c.cls || (c.l ? "l" : "")}">${cell(c, r)}</td>`).join("") + "</tr>").join("") + "</tbody>";
      if (el.classList.contains("sortable")) {
        el.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
          const k = th.dataset.k, c = cols.find(c => c.key === k);
          dir = sortKey === k ? -dir : (c.asc ? 1 : -1);
          sortKey = k; draw();
        }));
      }
    }
    draw();
  }
  // Season team name, plus the franchise's current name when it has changed since.
  const now = r => r.franchise && r.franchise !== r.name ? `<div class="owner">now ${esc(r.franchise)}</div>` : "";
  const teamCell = r => `${esc(r.name)}${now(r)}`;
  const yearTag = r => r.year ? ` <span class="tag">${r.year}</span>` : "";

  // ---------- horizontal bar chart (diverging when values can be negative) ----------
  addEventListener("resize", () => charts.forEach(([el, items, o]) => el.offsetParent && (o.redrawFn ? o.redrawFn() : hbar(el, items, o, true))));
  function hbar(el, items, opts = {}, redraw) {
    const { fmt = v => v.toFixed(1), tipFn } = opts;
    if (!redraw) { const i = charts.findIndex(c => c[0] === el); if (i >= 0) charts.splice(i, 1); charts.push([el, items, opts]); }
    if (!items.length) { el.innerHTML = '<p class="hint">No data.</p>'; return; }
    const W = Math.max(300, el.clientWidth || el.parentElement.clientWidth - 32), rowH = 26, labelW = Math.min(170, W * 0.36), valW = 44, pad = 6;
    const H = items.length * rowH + 22;
    const min = Math.min(0, ...items.map(i => i.value)), max = Math.max(0, ...items.map(i => i.value));
    const span = (max - min) || 1;
    const plotW = W - labelW - valW * (min < 0 ? 2 : 1);
    const x0 = labelW + (min < 0 ? valW : 0);
    const sx = v => x0 + ((v - min) / span) * plotW;
    const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
    const tstep = [1, 2, 5, 10].map(m => m * step).find(s => span / s <= 5) || step * 10;
    const ticks = [];
    for (let t = Math.ceil(min / tstep) * tstep; t <= max + 1e-9; t += tstep) ticks.push(+t.toFixed(6));
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    ticks.forEach(t => {
      svg += `<line class="${t === 0 ? "base" : "grid"}" x1="${sx(t)}" x2="${sx(t)}" y1="0" y2="${H - 20}"/>`;
      svg += `<text x="${sx(t)}" y="${H - 6}" text-anchor="middle" class="val">${t}</text>`;
    });
    items.forEach((it, i) => {
      const y = i * rowH, bh = rowH - 2 * pad - 4, by = y + pad + 2;
      const a = sx(Math.min(0, it.value)), b = sx(Math.max(0, it.value));
      const w = Math.max(b - a, 1), r = Math.min(4, w / 2);
      const neg = it.value < 0;
      const path = neg
        ? `M${b},${by} H${a + r} Q${a},${by} ${a},${by + r} V${by + bh - r} Q${a},${by + bh} ${a + r},${by + bh} H${b} Z`
        : `M${a},${by} H${b - r} Q${b},${by} ${b},${by + r} V${by + bh - r} Q${b},${by + bh} ${b - r},${by + bh} H${a} Z`;
      const cls = min < 0 ? (neg ? "bar-neg" : "bar-pos") : "bar";
      const me = SEL && it.owner_key === SEL;
      svg += `<g class="row" data-i="${i}"><rect class="hl" x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"/>`;
      const maxCh = Math.floor(labelW / 7);
      svg += `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" class="${me ? "me" : ""}">${esc(it.label.length > maxCh ? it.label.slice(0, maxCh - 1) + "…" : it.label)}</text>`;
      svg += `<path class="${cls}" d="${path}"/>`;
      svg += `<text class="val" x="${neg ? a - 4 : b + 4}" y="${y + rowH / 2 + 4}" text-anchor="${neg ? "end" : "start"}">${fmt(it.value)}</text></g>`;
    });
    el.innerHTML = svg + "</svg>";
    el.querySelectorAll("g.row").forEach(g => {
      const it = items[+g.dataset.i];
      g.addEventListener("mousemove", e => tipOn(e, tipFn ? tipFn(it) : `<b>${esc(it.label)}</b><br>${fmt(it.value)}`));
      g.addEventListener("mouseleave", tipOff);
    });
  }

  // ---------- season selectors: every one gets "All seasons" ----------
  function seasonSelect(sel, yrs, onChange) {
    sel.innerHTML = `<option value="${ALL}">All seasons</option>` + yrs.map(y => `<option value="${y}">${y}</option>`).join("");
    sel.value = String(yrs[0]);
    sel.addEventListener("change", () => onChange(sel.value));
  }
  const selVal = id => $(id).value;
  // Sum per-season team rows into one row per franchise.
  function byFranchise(rows, fields, extra = () => ({})) {
    const m = new Map();
    for (const r of rows) {
      let a = m.get(r.owner_key);
      if (!a) { a = { owner_key: r.owner_key, name: r.franchise, franchise: r.franchise, seasons: new Set(), _rows: [] }; fields.forEach(f => (a[f] = 0)); m.set(r.owner_key, a); }
      a.seasons.add(r.year); a._rows.push(r);
      fields.forEach(f => (a[f] += r[f] || 0));
    }
    return [...m.values()].map(a => ({ ...a, nseasons: a.seasons.size, ...extra(a) }));
  }
  const withYear = (rows, y) => rows.map(r => ({ ...r, year: +y }));
  const top = (lists, key, n, asc) => lists.flat().sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]).slice(0, n);
  function setFlag(id, msgs) { const f = $(id); f.hidden = !msgs.length; f.textContent = msgs.join(" · "); }

  // ---------- overview ----------
  const curYear = league.current_season;
  // Text values (team names) use a smaller face than numbers.
  const tile = ([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v${/^[\d+−\-.,%<> W$]+$/.test(String(v).replace(/<[^>]+>/g, "")) ? "" : " txt"}">${v}</div><div class="d">${d}</div></div>`;
  const allStandings = years.flatMap(y => withYear(p1.seasons[y].standings, y).map(r => ({ ...r, games: r.w + r.l + r.t, weeks: p1.seasons[y].periods_played })));
  p1.all_time.forEach(r => (r.ppg_x = r.pf / Math.max(1, r.w + r.l + r.t)));
  function renderOverview() {
    const f = SEL && p1.all_time.find(r => r.owner_key === SEL);
    let tiles, h2hRows = null;
    if (f) {
      const cur = p1.seasons[curYear]?.standings.find(r => r.owner_key === SEL);
      const won = p1.champions.filter(c => c.champion && c.champion.owner_key === SEL).map(c => c.year);
      const h2h = Object.entries(p1.head_to_head?.[SEL] || {}).map(([k, r]) => {
        const g = r.w + r.l + r.t;
        return { opp: fname[k] || "Unknown", owner_key: k, g, pct: g ? (r.w + 0.5 * r.t) / g : 0, ...r };
      });
      const ranked = h2h.filter(r => r.g >= 3).sort((a, b) => b.pct - a.pct || b.g - a.g);
      const bestM = ranked[0], worstM = ranked[ranked.length - 1];
      const mtile = (label, m) => [label, m ? rec(m.w, m.l, m.t) : "–", m ? `vs ${esc(m.opp)}` : "needs 3+ games vs one team"];
      // With percentiles on, tiles also say where this franchise sits among all franchises.
      const fp = (v, key, low) => PCT ? ` · P${percentile(p1.all_time.map(r => r[key]), v, low) ?? "–"} of teams` : "";
      tiles = [
        ["Titles", f.titles, won.length ? won.join(", ") : `${f.runner_ups} runner-up finish${f.runner_ups === 1 ? "" : "es"}`],
        ["Total wins", f.w, `${f.seasons} season${f.seasons === 1 ? "" : "s"}, regular season${fp(f.pct, "pct")}`],
        ["Total losses", f.l, (f.t ? `${f.t} tie${f.t === 1 ? "" : "s"} · ` : "") + `${pct(f.pct)} win %`],
        ["Total points scored", int(f.pf), "regular season" + fp(f.ppg_x, "ppg_x")],
        ["Total bench points", f.bench_pts == null ? "–" : int(f.bench_pts), f.regret_pts == null ? "" : `${int(f.regret_pts)} should have started`],
        mtile("Best matchup", bestM),
        mtile("Worst matchup", worstM),
        ["Career luck", signed(f.luck, 1), "wins vs all-play expectation" + fp(f.luck, "luck")],
      ];
      if (cur) tiles.unshift([`${curYear} so far`, rec(cur.w, cur.l, cur.t), `#${cur.h2h_rank} H2H · #${cur.ap_rank} all-play · luck ${signed(cur.luck, 1)}`]);
      h2hRows = h2h;
    } else {
      const at = p1.all_time;
      const most = at.slice().sort((a, b) => b.titles - a.titles || b.pct - a.pct)[0];
      const best = at.filter(r => r.seasons >= 3).sort((a, b) => b.pct - a.pct)[0];
      const lucky = at.slice().sort((a, b) => b.luck - a.luck)[0];
      tiles = [
        ["Seasons", years.length, `${p1.champions.filter(c => c.champion).length} champions crowned`],
        ["Most titles", most.titles, esc(most.franchise)],
        ["Best all-time record", best ? pct(best.pct) : "–", best ? esc(best.franchise) : ""],
        ["Luckiest franchise", signed(lucky.luck, 1), esc(lucky.franchise)],
      ];
    }
    $("#me-card").innerHTML = tiles.map(tile).join("");
    $("#h2h-wrap").hidden = !h2hRows;
    if (h2hRows) {
      $("#h2h-title").textContent = "Head-to-head: " + f.franchise;
      table($("#h2h"), [
        { key: "opp", label: "Opponent", l: true, fmt: r => esc(r.opp), sort: r => r.opp.toLowerCase(), asc: true },
        { key: "pct", label: "Record", fmt: r => `${rec(r.w, r.l, r.t)} <span class="owner">${pct(r.pct)}</span>` },
        { key: "g", label: "Games" },
        { key: "pf", label: "Pts for", fmt: r => num(r.pf, 0) },
        { key: "pa", label: "Pts against", fmt: r => num(r.pa, 0) },
      ], h2hRows, { sort: "pct", rowKey: () => null });
    }
  }
  const who = x => x ? `${esc(x.name)}${x.franchise && x.franchise !== x.name ? `<div class="owner">now ${esc(x.franchise)}</div>` : ""}` : NA;
  function renderChamps() {
    table($("#champs"), [
      { key: "year", label: "Season", l: true, fmt: r => r.year + (r.in_progress ? ' <span class="flag">in progress</span>' : "") },
      { key: "champion", label: "Champion", l: true, fmt: r => who(r.champion) },
      { key: "runner_up", label: "Runner-up", l: true, fmt: r => who(r.runner_up) },
      { key: "reg", label: "Best regular season", l: true, fmt: r => who(r.reg_season_best) },
      { key: "pf", label: "Most points", l: true, fmt: r => who(r.top_pf) },
      { key: "last", label: "Last place", l: true, fmt: r => who(r.last_place) },
    ], p1.champions.slice().sort((a, b) => b.year - a.year),
    { sortable: false, rowKey: c => c.champion && c.champion.owner_key }); // only the picked team's title years light up
  }

  // Banner only for genuinely missing data; smaller discrepancies stay on the Data notes tab and per-tab flags.
  const flagged = league.coverage.filter(c => !c.available || !c.scores || !c.lineups || c.transactions === false);
  if (flagged.length) {
    const b = $("#coverage-banner");
    b.hidden = false;
    b.innerHTML = `Missing or partial ESPN data for ${flagged.map(c => c.year).join(", ")}. <a href="#data">See data notes</a>.`;
  }

  // ---------- season ----------
  const perGame = (v, r) => v / Math.max(1, r.games ?? (r.w + r.l + r.t));
  function renderSeason(y) {
    const all = y === ALL;
    let rows, pool;
    if (all) {
      rows = byFranchise(allStandings, ["w", "l", "t", "pf", "pa", "ap_w", "ap_l", "ap_t", "exp_w", "luck", "med_w", "med_l", "med_t", "top_weeks", "games"], a => ({
        titles: p1.champions.filter(c => c.champion && c.champion.owner_key === a.owner_key).length,
      })).map(a => ({ ...a, pct: (a.w + 0.5 * a.t) / Math.max(1, a.games), ap_pct: (a.ap_w + 0.5 * a.ap_t) / Math.max(1, a.ap_w + a.ap_l + a.ap_t) }));
      const rank = cmp => { const o = rows.slice().sort(cmp); return Object.fromEntries(o.map((r, i) => [r.owner_key, i + 1])); };
      const medW = r => r.med_w + 0.5 * r.med_t, apW = r => r.ap_w + 0.5 * r.ap_t;
      const h = rank((a, b) => (b.w + .5 * b.t) - (a.w + .5 * a.t) || b.pct - a.pct), ap = rank((a, b) => apW(b) / (b.ap_w + b.ap_l + b.ap_t) * b.games - apW(a) / (a.ap_w + a.ap_l + a.ap_t) * a.games), md = rank((a, b) => medW(b) - medW(a));
      rows.forEach(r => { r.h2h_rank = h[r.owner_key]; r.ap_rank = ap[r.owner_key]; r.med_rank = md[r.owner_key]; });
      pool = rows;
      setFlag("#season-flag", ["All seasons combined: one row per franchise under its current team name, ranked by total wins. Franchises played different numbers of seasons, so turn on Percentiles for a per-game comparison."]);
    } else {
      const s = p1.seasons[y], c = cov[y] || {};
      rows = allStandings.filter(r => r.year === +y);
      pool = allStandings; // percentiles vs every team-season in history
      const msgs = [];
      if (!s.complete) msgs.push(`In progress: ${s.periods_played} of ${s.reg_season_periods} regular-season weeks played`);
      (c.notes || []).forEach(n => msgs.push(n));
      setFlag("#season-flag", msgs);
    }
    const label = r => all ? r.franchise : r.name;
    const nameCol = { key: "name", label: all ? "Franchise" : "Team", l: true, fmt: all ? r => esc(r.franchise) : teamCell, sort: r => r.name.toLowerCase(), asc: true };
    table($("#standings"), [
      { key: "h2h_rank", label: "#", asc: true },
      nameCol,
      ...(all ? [{ key: "nseasons", label: "Seasons" }, { key: "titles", label: "Titles" }] : []),
      { key: "w", label: "H2H", fmt: r => rec(r.w, r.l, r.t), sort: r => r.pct, pv: r => r.pct },
      { key: "pf", label: "PF", fmt: r => num(r.pf), pv: r => perGame(r.pf, r) },
      { key: "pa", label: "PA", fmt: r => num(r.pa), pv: r => perGame(r.pa, r), low: true },
      { key: "ap_pct", label: "All-play", fmt: r => `${rec(r.ap_w, r.ap_l, r.ap_t)} <span class="owner">${pct(r.ap_pct)}</span>`, pv: r => r.ap_pct },
      { key: "exp_w", label: "Exp W", fmt: r => num(r.exp_w, 1), pv: r => perGame(r.exp_w, r) },
      { key: "luck", label: "Luck", fmt: r => signed(r.luck, 1), pv: r => perGame(r.luck, r) },
      { key: "med_w", label: "Median fmt", fmt: r => rec(r.med_w, r.med_l, r.med_t), sort: r => r.med_w + 0.5 * r.med_t, pv: r => perGame(r.med_w + 0.5 * r.med_t, r) },
      { key: "top_weeks", label: "Top score wks", pv: r => perGame(r.top_weeks, r) },
      ...(all ? [] : [{ key: "final_rank", label: "Final", asc: true, fmt: r => r.final_rank ?? NA }]),
    ], rows, { sort: "h2h_rank", dir: 1, pool });
    hbar($("#luck-chart"), rows.slice().sort((a, b) => b.luck - a.luck).map(r => ({ label: label(r), value: r.luck, owner_key: r.owner_key, r })), {
      fmt: v => signed(v, 1),
      tipFn: it => `<b>${esc(label(it.r))}</b><br>Actual ${rec(it.r.w, it.r.l, it.r.t)} · expected ${it.r.exp_w.toFixed(1)} wins<br>Luck ${signed(it.value, 2)}`,
    });
    const arrow = (a, b) => a === b ? "" : `<span class="owner"> (${a > b ? "▲" : "▼"}${Math.abs(a - b)})</span>`;
    table($("#formats"), [
      nameCol,
      { key: "h2h_rank", label: "H2H", asc: true },
      { key: "ap_rank", label: "All-play", fmt: r => r.ap_rank + arrow(r.h2h_rank, r.ap_rank) },
      { key: "med_rank", label: "Median", fmt: r => r.med_rank + arrow(r.h2h_rank, r.med_rank) },
    ], rows, { sort: "h2h_rank", dir: 1, sortable: false });
  }
  seasonSelect($("#season-select"), years, renderSeason);

  // ---------- all-time ----------
  function renderAlltime() {
    table($("#alltime"), [
      { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise), sort: r => r.franchise.toLowerCase(), asc: true },
      { key: "seasons", label: "Seasons" },
      { key: "titles", label: "Titles", pv: r => r.titles / r.seasons },
      { key: "runner_ups", label: "2nd" },
      { key: "playoffs", label: "Playoffs", pv: r => r.playoffs / r.seasons },
      { key: "pct", label: "H2H", fmt: r => `${rec(r.w, r.l, r.t)} <span class="owner">${pct(r.pct)}</span>`, pv: r => r.pct },
      { key: "ap_pct", label: "All-play %", fmt: r => pct(r.ap_pct), pv: r => r.ap_pct },
      { key: "luck", label: "Luck", fmt: r => signed(r.luck, 1), pv: r => r.luck / r.seasons },
      { key: "med_w", label: "Median fmt", fmt: r => rec(r.med_w, r.med_l) },
      { key: "pf", label: "PF", fmt: r => int(r.pf), pv: r => r.ppg_x },
      { key: "bench_pts", label: "Bench pts", fmt: r => int(r.bench_pts) },
      { key: "regret_pts", label: "Should have started", fmt: r => int(r.regret_pts), pv: r => r.regret_pts / r.seasons, low: true },
      { key: "last_places", label: "Last" },
    ], p1.all_time, { sort: "titles" });
    hbar($("#career-luck"), p1.all_time.slice().sort((a, b) => b.luck - a.luck).map(r => ({ label: r.franchise, value: r.luck, owner_key: r.owner_key, r })), {
      fmt: v => signed(v, 1),
      tipFn: it => `<b>${esc(it.r.franchise)}</b><br>${it.r.seasons} seasons · ${rec(it.r.w, it.r.l, it.r.t)}<br>Luck ${signed(it.value, 2)} wins`,
    });
  }

  // ---------- start/sit ----------
  const regretRows = allStandings.filter(r => r.regret_pts != null);
  function renderRegret(y) {
    const all = y === ALL;
    const rows = all
      ? byFranchise(regretRows, ["regret_pts", "regret_losses", "lineup_pf", "optimal_pf", "bench_pts", "weeks"]).map(a => ({ ...a, efficiency: a.lineup_pf / a.optimal_pf }))
      : regretRows.filter(r => r.year === +y);
    if (!rows.length) { ["#regret-chart", "#regret-table", "#blunders"].forEach(s => ($(s).innerHTML = '<p class="hint">No lineup data for this season.</p>')); return; }
    const label = r => all ? r.franchise : r.name;
    hbar($("#regret-chart"), rows.slice().sort((a, b) => b.regret_pts - a.regret_pts).map(r => ({ label: label(r), value: r.regret_pts, owner_key: r.owner_key, r })), {
      fmt: v => v.toFixed(0),
      tipFn: it => `<b>${esc(label(it.r))}</b><br>${it.r.regret_pts.toFixed(1)} pts left on bench<br>${it.r.regret_losses} games cost · ${(it.r.efficiency * 100).toFixed(1)}% efficient`,
    });
    const perWeek = (v, r) => v / Math.max(1, r.weeks);
    table($("#regret-table"), [
      { key: "name", label: all ? "Franchise" : "Team", l: true, fmt: all ? r => esc(r.franchise) : teamCell },
      { key: "efficiency", label: "Efficiency", fmt: r => (r.efficiency * 100).toFixed(1) + "%", pv: r => r.efficiency },
      { key: "regret_losses", label: "Games cost", pv: r => perWeek(r.regret_losses, r), low: true },
      { key: "bench_pts", label: "Bench pts", fmt: r => num(r.bench_pts, 0) },
      { key: "lineup_pf", label: "Used", fmt: r => num(r.lineup_pf, 0), pv: r => perWeek(r.lineup_pf, r) },
      { key: "optimal_pf", label: "Best", fmt: r => num(r.optimal_pf, 0), pv: r => perWeek(r.optimal_pf, r) },
    ], rows, { sort: "efficiency", pool: all ? rows : regretRows });
    const blunders = all ? top(years.map(yy => withYear(p1.seasons[yy].blunders, yy)), "lost", 15) : p1.seasons[y].blunders.slice(0, 15).map(b => ({ ...b, year: null }));
    const tm = yy => Object.fromEntries(p1.seasons[yy || y].standings.map(r => [r.team_id, r]));
    table($("#blunders"), [
      { key: "period", label: "Wk", fmt: b => b.period + yearTag(b) },
      { key: "team", label: "Team", l: true, fmt: b => teamCell(tm(b.year)[b.team_id] || { name: b.team }) },
      { key: "lost", label: "Pts lost", fmt: b => b.lost.toFixed(1) },
      { key: "cost", label: "Result", l: true, fmt: b => b.playoff ? "playoff" : b.cost_game ? "<b>cost the game</b>" : "" },
      { key: "should_start", label: "Should have started", cls: "wrapcell", fmt: b => esc(b.should_start.join(", ")) },
      { key: "did_start", label: "Instead of", cls: "wrapcell", fmt: b => esc(b.did_start.join(", ")) },
    ], blunders.map(b => ({ ...b, owner_key: tm(b.year)[b.team_id]?.owner_key })), { sortable: false });
  }
  seasonSelect($("#regret-select"), years, renderRegret);

  // ---------- waivers ----------
  let renderWaivers = () => {};
  if (p2) {
    const playerCell = a => `${esc(a.player)}<div class="owner">${esc(a.team)}</div>`;
    const wk = a => (a.sp ? `wk ${a.sp}` : "preseason") + yearTag(a);
    const wYears = Object.keys(p2.seasons).map(Number).sort((a, b) => b - a);
    const wTeams = wYears.flatMap(y => withYear(p2.seasons[y].teams, y).map(t => ({ ...t, weeks: p1.seasons[y]?.periods_played || 1, faab: p2.seasons[y].faab })));
    renderWaivers = y => {
      const all = y === ALL;
      const faabYears = wYears.filter(yy => p2.seasons[yy].faab);
      let rows, w, lists;
      if (all) {
        rows = byFranchise(wTeams, ["adds", "started_pts", "hits", "weeks"]).map(a => {
          const f = a._rows.filter(r => r.faab);
          const spent = sum(f, r => r.faab_spent), fpts = sum(f, r => r.faab_pts);
          return { ...a, pts_per_add: a.adds ? a.started_pts / a.adds : null, faab_spent: spent, overpaid: sum(f, r => r.overpaid), pts_per_dollar: spent ? fpts / spent : null };
        });
        w = { faab: faabYears.length > 0 };
        const L = k => wYears.map(yy => withYear(p2.seasons[yy][k], yy));
        lists = { best_adds: top(L("best_adds"), "started_pts", 12), best_value: top(L("best_value"), "pts_per_dollar", 10),
                  busts: top(L("busts"), "started_pts", 10, true), overpays: top(L("overpays"), "overpay", 12) };
        setFlag("#waiver-flag", [`All seasons combined. FAAB columns cover ${faabYears.slice().reverse().join(", ")} only.`]);
      } else {
        w = p2.seasons[y];
        rows = wTeams.filter(t => t.year === +y);
        lists = { best_adds: w.best_adds, best_value: w.best_value, busts: w.busts, overpays: w.overpays };
        const msgs = (cov[y]?.notes || []).filter(n => /FAAB|add/.test(n));
        if (!p1.seasons[y]?.complete) msgs.unshift("In progress: values grow as the season goes on");
        setFlag("#waiver-flag", msgs);
      }
      const label = r => all ? r.franchise : r.name;
      hbar($("#waiver-chart"), rows.slice().sort((a, b) => b.started_pts - a.started_pts).map(t => ({ label: label(t), value: t.started_pts, owner_key: t.owner_key, t })), {
        fmt: v => Math.round(v),
        tipFn: it => `<b>${esc(label(it.t))}</b><br>${it.t.adds} adds · ${it.t.started_pts.toFixed(0)} started pts`,
      });
      const perWeek = (v, r) => v / Math.max(1, r.weeks);
      const cols = [
        { key: "name", label: all ? "Franchise" : "Team", l: true, fmt: all ? r => esc(r.franchise) : teamCell, sort: r => r.name.toLowerCase(), asc: true },
        { key: "adds", label: "Adds" },
        { key: "started_pts", label: "Started pts", fmt: r => num(r.started_pts, 0), pv: r => perWeek(r.started_pts, r) },
        { key: "pts_per_add", label: "Pts/add", fmt: r => num(r.pts_per_add, 1), pv: r => r.pts_per_add },
        { key: "hits", label: "Hits", pv: r => perWeek(r.hits, r) },
      ];
      if (w.faab) cols.push(
        { key: "faab_spent", label: "FAAB", fmt: r => money(r.faab_spent) },
        { key: "pts_per_dollar", label: "Pts/$", fmt: r => num(r.pts_per_dollar, 2), pv: r => r.pts_per_dollar },
        { key: "overpaid", label: "Overpaid", fmt: r => money(r.overpaid) },
      );
      table($("#waiver-teams"), cols, rows, { sort: "pts_per_add", pool: all ? rows : wTeams });
      table($("#best-adds"), [
        { key: "player", label: "Player", l: true, fmt: playerCell },
        { key: "sp", label: "Added", fmt: wk },
        { key: "bid", label: "Cost", fmt: a => a.bid != null ? money(a.bid) : (a.type === "FREEAGENT" ? "FA" : "waiver") },
        { key: "starts", label: "Starts" },
        { key: "started_pts", label: "Started pts", fmt: a => a.started_pts.toFixed(1) },
        { key: "bench_pts", label: "Bench pts", fmt: a => a.bench_pts.toFixed(1) },
      ], lists.best_adds.slice(0, 12), { sortable: false });
      $("#faab-sections").hidden = !w.faab;
      if (w.faab) {
        table($("#best-value"), [
          { key: "player", label: "Player", l: true, fmt: playerCell },
          { key: "bid", label: "Bid", fmt: a => money(a.bid) + yearTag(a) },
          { key: "started_pts", label: "Pts", fmt: a => a.started_pts.toFixed(0) },
          { key: "pts_per_dollar", label: "Pts/$", fmt: a => a.pts_per_dollar.toFixed(1) },
        ], lists.best_value.slice(0, 10), { sortable: false });
        table($("#busts"), [
          { key: "player", label: "Player", l: true, fmt: playerCell },
          { key: "bid", label: "Bid", fmt: a => money(a.bid) + yearTag(a) },
          { key: "starts", label: "Starts" },
          { key: "started_pts", label: "Pts", fmt: a => a.started_pts.toFixed(0) },
        ], lists.busts.slice(0, 10), { sortable: false });
        table($("#overpays"), [
          { key: "player", label: "Player", l: true, fmt: playerCell },
          { key: "sp", label: "Run", fmt: wk },
          { key: "bid", label: "Winning bid", fmt: a => money(a.bid) },
          { key: "next_bid", label: "Next bid", fmt: a => a.next_bid == null ? '<span class="na">none</span>' : money(a.next_bid) },
          { key: "bidders", label: "Bidders" },
          { key: "overpay", label: "Overpaid by", fmt: a => `<b>${money(a.overpay)}</b>` },
          { key: "started_pts", label: "Started pts", fmt: a => a.started_pts.toFixed(0) },
        ], lists.overpays.slice(0, 12), { sortable: false });
      }
      table($("#waiver-alltime"), [
        { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise), sort: r => r.franchise.toLowerCase(), asc: true },
        { key: "seasons", label: "Seasons" },
        { key: "adds", label: "Adds" },
        { key: "started_pts", label: "Started pts", fmt: r => int(r.started_pts), pv: r => r.started_pts / r.seasons },
        { key: "pts_per_add", label: "Pts/add", fmt: r => num(r.pts_per_add, 1), pv: r => r.pts_per_add },
        { key: "hits", label: "Hits", pv: r => r.hits / r.seasons },
        { key: "faab_spent", label: "FAAB", fmt: r => money(r.faab_spent) },
        { key: "pts_per_dollar", label: "Pts/$", fmt: r => num(r.pts_per_dollar, 2), pv: r => r.pts_per_dollar },
        { key: "overpaid", label: "Overpaid", fmt: r => money(r.overpaid) },
      ], p2.all_time, { sort: "started_pts" });
    };
    seasonSelect($("#waiver-select"), wYears, v => renderWaivers(v));
  } else {
    document.querySelector('[data-tab="waivers"]').hidden = true;
  }

  // ---------- draft vs ADP ----------
  let renderDraft = () => {};
  if (p3 && Object.keys(p3.seasons).length) {
    const dYears = Object.keys(p3.seasons).map(Number).sort((a, b) => b - a);
    const isFP = y => p3.seasons[y].adp_source === "FantasyPros";
    const dTeams = dYears.flatMap(y => withYear(p3.seasons[y].teams, y).map(t => ({ ...t, fp: isFP(y) })));
    const allPicks = dYears.flatMap(y => p3.seasons[y].picks.map(p => ({ ...p, fp: isFP(y) })));
    const pickCell = p => `${esc(p.player)} <span class="owner">${esc(p.pos)}</span><div class="owner">${esc(p.team)}</div>`;
    const slot = p => `${p.round}.${String(p.round_pick).padStart(2, "0")}` + yearTag(p);
    const pickCols = extra => [
      { key: "player", label: "Player", l: true, fmt: pickCell },
      { key: "overall", label: "Pick", fmt: slot },
      { key: "adp", label: "ADP", fmt: p => num(p.adp, 0) },
      ...extra,
    ];
    renderDraft = y => {
      const all = y === ALL;
      let rows, lists, d = null;
      if (all) {
        const fpYears = dYears.filter(isFP);
        rows = byFranchise(dTeams.filter(t => t.fp), ["picks", "draft_value", "draft_pts"]).map(a => {
          const mine = allPicks.filter(p => p.fp && p.owner_key === a.owner_key);
          const st = mine.filter(p => p.steal != null), gr = mine.filter(p => p.value_vs_adp != null);
          return { ...a, avg_steal: st.length ? sum(st, p => p.steal) / st.length : null,
                   beat_adp_pct: gr.length ? gr.filter(p => p.value_vs_adp > 0).length / gr.length : null,
                   per_draft: a.draft_value / a.nseasons };
        });
        const fpPicks = allPicks.filter(p => p.fp);
        const L = (key, asc) => fpPicks.filter(p => p[key] != null).sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]).slice(0, 12);
        lists = { best_picks: L("pick_value"), worst_picks: L("pick_value", true), steals: L("steal"), reaches: L("steal", true) };
        const left = dYears.filter(yy => !isFP(yy));
        setFlag("#draft-flag", [`All seasons combined: ${fpYears.slice().reverse().join(", ")} (FantasyPros consensus)` + (left.length ? `. ${left.join(", ")} used ESPN ADP and is left out.` : ".")]);
      } else {
        d = p3.seasons[y];
        rows = dTeams.filter(t => t.year === +y);
        const noYear = l => l.map(p => ({ ...p, year: null }));  // single season: no year tags
        lists = { best_picks: noYear(d.best_picks), worst_picks: noYear(d.worst_picks), steals: noYear(d.steals), reaches: noYear(d.reaches) };
        const msgs = [d.adp_detail];
        if (!d.complete) msgs.push(`In progress: points through ${d.periods} weeks`);
        (cov[y]?.notes || []).filter(n => /ADP|keeper|consensus/i.test(n)).forEach(n => msgs.push(n));
        setFlag("#draft-flag", msgs);
      }
      const label = r => all ? r.franchise : r.name;
      hbar($("#draft-chart"), rows.slice().sort((a, b) => b.draft_value - a.draft_value).map(t => ({ label: label(t), value: t.draft_value, owner_key: t.owner_key, t })), {
        fmt: v => signed(v, 0),
        tipFn: it => `<b>${esc(label(it.t))}</b><br>Draft value ${signed(it.t.draft_value, 0)} pts vs slot<br>Avg steal ${signed(it.t.avg_steal, 1)} picks · beat ADP ${it.t.beat_adp_pct == null ? "–" : Math.round(it.t.beat_adp_pct * 100) + "%"}`,
      });
      table($("#draft-teams"), [
        { key: "name", label: all ? "Franchise" : "Team", l: true, fmt: all ? r => esc(r.franchise) : teamCell },
        ...(all ? [{ key: "nseasons", label: "Drafts" }] : []),
        { key: "draft_value", label: "Draft value", fmt: r => signed(r.draft_value, 0), pv: r => all ? r.per_draft : r.draft_value },
        { key: "avg_steal", label: "Avg steal", fmt: r => signed(r.avg_steal, 1), pv: r => r.avg_steal },
        { key: "beat_adp_pct", label: "Beat ADP", fmt: r => r.beat_adp_pct == null ? NA : Math.round(r.beat_adp_pct * 100) + "%", pv: r => r.beat_adp_pct },
        ...(all ? [] : [
          { key: "best", label: "Best pick", l: true, fmt: r => `${esc(r.best)} <span class="owner">${signed(r.best_value, 0)}</span>` },
          { key: "worst", label: "Worst pick", l: true, fmt: r => `${esc(r.worst)} <span class="owner">${signed(r.worst_value, 0)}</span>` },
        ]),
      ], rows, { sort: "draft_value", pool: all ? rows : dTeams.filter(t => t.fp) });
      const vcols = pickCols([
        { key: "pts", label: "Pts", fmt: p => num(p.pts, 0) },
        { key: "pos_finish", label: "Finish", fmt: p => `${esc(p.pos_finish || "–")} <span class="owner">ADP ${esc(p.pos_adp || "–")}</span>` },
        { key: "pick_value", label: "Value", fmt: p => `<b>${signed(p.pick_value, 0)}</b>` },
      ]);
      table($("#best-picks"), vcols, lists.best_picks.slice(0, 10), { sortable: false });
      table($("#worst-picks"), vcols, lists.worst_picks.slice(0, 10), { sortable: false });
      const scols = pickCols([
        { key: "steal", label: "Steal", fmt: p => `<b>${signed(p.steal, 0)}</b>` },
        { key: "pts", label: "Pts", fmt: p => num(p.pts, 0) },
        { key: "pick_value", label: "Value", fmt: p => signed(p.pick_value, 0) },
      ]);
      table($("#steals"), scols, lists.steals.slice(0, 10), { sortable: false });
      table($("#reaches"), scols, lists.reaches.slice(0, 10), { sortable: false });

      // Draft board: a season's full draft, or the picked team's picks across all seasons.
      const board = all ? (SEL ? allPicks.filter(p => p.owner_key === SEL).sort((a, b) => b.year - a.year || a.overall - b.overall) : []) : d.picks;
      $("#board-title").textContent = all ? (SEL ? `Draft history: ${fname[SEL]}` : "Draft history") : `${y} draft board`;
      $("#board-hint").textContent = all && !SEL ? "Select your team at the top to see its picks from every draft." :
        "Click a header to sort. Taken = order our league took that position; ADP pos = consensus positional rank; Finish = positional finish in our scoring.";
      const posNum = k => p => +String(p[k] || "").replace(/\D/g, "") || 999;
      table($("#board"), [
        { key: "overall", label: "Pick", fmt: p => slot(all ? p : { ...p, year: null }), asc: true },
        { key: "team", label: "Team", l: true, fmt: p => teamCell({ name: p.team, franchise: p.franchise }), sort: p => p.team.toLowerCase(), asc: true },
        { key: "player", label: "Player", l: true, fmt: p => esc(p.player) + (p.keeper ? ' <span class="tag">keeper</span>' : ""), sort: p => p.player.toLowerCase(), asc: true },
        { key: "pos", label: "Pos", l: true },
        { key: "adp", label: "ADP", fmt: p => num(p.adp, 0), asc: true },
        { key: "steal", label: "Steal", fmt: p => signed(p.steal, 0) },
        { key: "pos_taken", label: "Taken", fmt: p => esc(p.pos_taken || "–"), sort: posNum("pos_taken"), asc: true },
        { key: "pos_adp", label: "ADP pos", fmt: p => esc(p.pos_adp || "–"), sort: posNum("pos_adp"), asc: true },
        { key: "pos_finish", label: "Finish", fmt: p => esc(p.pos_finish || "–"), sort: posNum("pos_finish"), asc: true },
        { key: "pts", label: "Pts", fmt: p => num(p.pts, 0) },
        { key: "pick_value", label: "Value", fmt: p => signed(p.pick_value, 0) },
      ], board, { sort: all ? null : "overall", dir: 1 });
      table($("#draft-alltime"), [
        { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise), sort: r => r.franchise.toLowerCase(), asc: true },
        { key: "seasons", label: "Drafts" },
        { key: "picks", label: "Picks" },
        { key: "value_per_draft", label: "Value per draft", fmt: r => signed(r.value_per_draft, 1), pv: r => r.value_per_draft },
        { key: "draft_value", label: "Total value", fmt: r => signed(r.draft_value, 0) },
        { key: "avg_steal", label: "Avg steal", fmt: r => signed(r.avg_steal, 1), pv: r => r.avg_steal },
        { key: "beat_adp_pct", label: "Beat ADP", fmt: r => r.beat_adp_pct == null ? NA : Math.round(r.beat_adp_pct * 100) + "%", pv: r => r.beat_adp_pct },
      ], p3.all_time, { sort: "value_per_draft" });
    };
    seasonSelect($("#draft-select"), dYears, v => renderDraft(v));
  } else {
    document.querySelector('[data-tab="draft"]').hidden = true;
  }

  // ---------- simulations ----------
  let renderSims = () => {};
  if (p4 && Object.keys(p4.seasons).length) {
    const sYears = Object.keys(p4.seasons).map(Number).sort((a, b) => b - a);
    const P = v => v == null ? NA : (v >= 0.995 && v < 1 ? ">99%" : v > 0 && v < 0.005 ? "<1%" : Math.round(v * 100) + "%");
    const allSimTeams = sYears.flatMap(y => withYear(p4.seasons[y].teams, y).map(t => ({ ...t, weeks: p4.seasons[y].weeks, complete: p4.seasons[y].complete })));
    const doneTeams = allSimTeams.filter(t => t.complete);
    const nm = id => (allSimTeams.find(t => t.team_id === id) || {}).name;
    renderSims = y => {
      const all = y === ALL;
      const s = all ? null : p4.seasons[y];
      const N = p4.n_sims.toLocaleString();
      $("#swap-wrap").hidden = all;
      $("#sims-hist-card").hidden = true;
      if (all) {
        $("#sims-title").textContent = "Simulations: all seasons";
        $("#sims-hint").innerHTML = `Expected titles = sum of each season's title odds across ${N} random schedules (same divisions). <b>Titles vs expected</b> above zero = won more than the schedules gave you; below = unlucky. <b>Schedule luck</b> = real wins minus average wins across every other team's schedule.`;
        setFlag("#sims-flag", ["Finished seasons only."]);
        const at = p4.all_time;
        const mostLucky = at[0], leastLucky = at[at.length - 1];
        const sched = at.slice().sort((a, b) => b.schedule_luck - a.schedule_luck);
        $("#sims-tiles").innerHTML = [
          ["Most titles over expected", signed(mostLucky.titles_vs_x, 2), `${esc(mostLucky.franchise)} · ${mostLucky.titles} won, ${mostLucky.xtitles.toFixed(2)} expected`],
          ["Most titles under expected", signed(leastLucky.titles_vs_x, 2), `${esc(leastLucky.franchise)} · ${leastLucky.titles} won, ${leastLucky.xtitles.toFixed(2)} expected`],
          ["Kindest schedules", signed(sched[0].schedule_luck, 1) + " W", esc(sched[0].franchise)],
          ["Toughest schedules", signed(sched[sched.length - 1].schedule_luck, 1) + " W", esc(sched[sched.length - 1].franchise)],
        ].map(tile).join("");
        $("#sims-chart-title").textContent = "Titles vs expected";
        hbar($("#sims-chart"), at.map(r => ({ label: r.franchise, value: r.titles_vs_x, owner_key: r.owner_key, r })), {
          fmt: v => signed(v, 2),
          tipFn: it => `<b>${esc(it.r.franchise)}</b><br>${it.r.titles} titles · ${it.r.xtitles.toFixed(2)} expected<br>Playoffs ${it.r.playoffs} · ${it.r.xplayoffs.toFixed(1)} expected`,
        });
        table($("#sims-table"), [
          { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise), sort: r => r.franchise.toLowerCase(), asc: true },
          { key: "seasons", label: "Seasons" },
          { key: "titles", label: "Titles" },
          { key: "xtitles", label: "Expected titles", fmt: r => r.xtitles.toFixed(2), pv: r => r.xtitles / r.seasons },
          { key: "titles_vs_x", label: "Titles vs expected", fmt: r => `<b>${signed(r.titles_vs_x, 2)}</b>`, pv: r => r.titles_vs_x / r.seasons },
          { key: "xtitles_div", label: "Exp. titles (random divisions)", fmt: r => r.xtitles_div.toFixed(2) },
          { key: "playoffs", label: "Playoffs" },
          { key: "xplayoffs", label: "Expected playoffs", fmt: r => r.xplayoffs.toFixed(1) },
          { key: "playoffs_vs_x", label: "Playoffs vs expected", fmt: r => signed(r.playoffs_vs_x, 1), pv: r => r.playoffs_vs_x / r.seasons },
          { key: "schedule_luck", label: "Schedule luck (W)", fmt: r => signed(r.schedule_luck, 1), pv: r => r.schedule_luck / r.seasons },
        ], at, { sort: "titles_vs_x" });
        return;
      }
      const v = s.validation;
      const check = v.seeds && (v.champion !== false) ? "Engine check: the real schedule reproduces ESPN's actual seeds" + (s.complete ? " and champion" : "") + " ✓" : "Engine check failed for this season: treat odds with caution";
      const champ = s.teams.find(t => t.champion);
      if (s.complete) {
        const sm = s.summary.schedules, dv = s.summary.divisions;
        $("#sims-title").textContent = `${y}: how often does the title change hands?`;
        $("#sims-hint").innerHTML = `Same weekly scores, different schedules. <b>Random schedules</b>: ${N} schedules with the real divisions (teams shuffled within their division). <b>Random divisions</b>: ${N} runs where teams are also dealt into new divisions. Playoffs are seeded with ESPN's rules for ${y} and played out with each team's real playoff-week scores. <b>Weighted</b> = average weekly score as a share of that week's league average (100 = average).`;
        setFlag("#sims-flag", [check]);
        const fav = s.teams.find(t => t.team_id === sm.favorite), favD = s.teams.find(t => t.team_id === dv.favorite);
        $("#sims-tiles").innerHTML = [
          ["Real champion", esc(champ ? champ.name : "–"), champ ? `wins the title in ${P(sm.champion_kept)} of random schedules` : ""],
          ["Title changes hands", P(sm.changes_hands), "of random schedules (same divisions)"],
          ["With random divisions", P(dv.changes_hands), `title changes hands · favorite ${esc(favD.name)} ${P(dv.favorite_title)}`],
          ["Most likely champion", esc(fav.name), `${P(sm.favorite_title)} of random schedules`],
        ].map(tile).join("");
      } else {
        $("#sims-title").textContent = `${y}: live playoff and title odds`;
        $("#sims-hint").innerHTML = `${N} simulations of the rest of the season on the real remaining schedule (${s.weeks_left} regular-season weeks plus playoffs), drawing each team's future scores from its own weekly scores so far. Seeded with ESPN's rules: division winners first, then record and tiebreakers; top ${s.n_playoff} make the playoffs.`;
        setFlag("#sims-flag", [check, `After ${s.weeks} weeks. Simple model: past scores only, no injuries or roster moves.`]);
        const byT = s.teams.slice().sort((a, b) => b.projection.title - a.projection.title);
        const byP = s.teams.slice().sort((a, b) => b.projection.playoff - a.projection.playoff);
        const bubble = byP.filter(t => t.projection.playoff > 0.2 && t.projection.playoff < 0.8).length;
        $("#sims-tiles").innerHTML = [
          ["Title favorite", esc(byT[0].name), `${P(byT[0].projection.title)} to win it all`],
          ["Best #1 seed odds", esc(s.teams.slice().sort((a, b) => b.projection.seed1 - a.projection.seed1)[0].name), P(Math.max(...s.teams.map(t => t.projection.seed1))) + " to finish #1 seed"],
          ["Teams on the bubble", bubble, "20–80% playoff odds"],
          ["Weeks left", s.weeks_left, "regular season"],
        ].map(tile).join("");
      }
      const key = s.complete ? "schedules" : "projection";
      $("#sims-chart-title").textContent = s.complete ? "Title odds across random schedules" : "Title odds";
      hbar($("#sims-chart"), s.teams.slice().sort((a, b) => b[key].title - a[key].title).map(t => ({ label: t.name, value: 100 * t[key].title, owner_key: t.owner_key, t })), {
        fmt: v => v < 0.5 && v > 0 ? "<1%" : Math.round(v) + "%",
        tipFn: it => `<b>${esc(it.t.name)}</b><br>Title ${P(it.t[key].title)} · final ${P(it.t[key].final)}<br>Playoffs ${P(it.t[key].playoff)} · #1 seed ${P(it.t[key].seed1)}`,
      });
      // Win distribution for the picked team (finished seasons).
      const me = SEL && s.teams.find(t => t.owner_key === SEL);
      if (me && s.complete) {
        $("#sims-hist-card").hidden = false;
        $("#sims-hist-title").textContent = `${me.name}: wins across random schedules`;
        $("#sims-hist-hint").textContent = `Real: ${me.wins} wins. Average across schedules: ${me.schedules.wins.toFixed(1)}.`;
        const h = me.schedules.hist.map((p, w) => ({ w, p })).filter(x => x.p > 0.001);
        hbar($("#sims-hist"), h.map(x => ({ label: `${x.w} wins${x.w === Math.round(me.wins) ? " (real)" : ""}`, value: 100 * x.p, owner_key: null })), { fmt: v => v.toFixed(v < 1 ? 1 : 0) + "%" });
      }
      const pool = s.complete ? doneTeams : allSimTeams;
      const cols = [
        { key: "seed", label: "Seed", asc: true },
        { key: "name", label: "Team", l: true, fmt: t => teamCell(t) + (t.champion ? ' <span class="tag">champion</span>' : ""), sort: t => t.name.toLowerCase(), asc: true },
        { key: "wins", label: "Wins", fmt: t => num(t.wins, 0), pv: t => t.wins / t.weeks },
        { key: "weighted", label: "Weighted", fmt: t => num(t.weighted, 1), pv: t => t.weighted },
        { key: "above_avg_wk", label: "Pts vs avg/wk", fmt: t => signed(t.above_avg_wk, 1), pv: t => t.above_avg_wk },
        { key: "swap_mean", label: "Avg W, others' schedules", fmt: t => `${num(t.swap_mean, 1)} <span class="owner">${num(t.swap_worst, 0)}–${num(t.swap_best, 0)}</span>` },
        { key: "schedule_luck", label: "Schedule luck", fmt: t => signed(t.schedule_luck, 1), pv: t => t.schedule_luck / t.weeks },
      ];
      if (s.complete) cols.push(
        { key: "sp", label: "Playoffs", fmt: t => P(t.schedules.playoff), sort: t => t.schedules.playoff, pv: t => t.schedules.playoff },
        { key: "s1", label: "#1 seed", fmt: t => P(t.schedules.seed1), sort: t => t.schedules.seed1 },
        { key: "st", label: "Title", fmt: t => `<b>${P(t.schedules.title)}</b>`, sort: t => t.schedules.title, pv: t => t.schedules.title },
        { key: "dp", label: "Playoffs (rand. div.)", fmt: t => P(t.divisions.playoff), sort: t => t.divisions.playoff },
        { key: "dt", label: "Title (rand. div.)", fmt: t => P(t.divisions.title), sort: t => t.divisions.title },
      );
      else cols.push(
        { key: "pw", label: "Proj. wins", fmt: t => num(t.projection.wins, 1), sort: t => t.projection.wins },
        { key: "pp", label: "Playoffs", fmt: t => `<b>${P(t.projection.playoff)}</b>`, sort: t => t.projection.playoff },
        { key: "p1", label: "#1 seed", fmt: t => P(t.projection.seed1), sort: t => t.projection.seed1 },
        { key: "pf2", label: "Final", fmt: t => P(t.projection.final), sort: t => t.projection.final },
        { key: "pt", label: "Title", fmt: t => `<b>${P(t.projection.title)}</b>`, sort: t => t.projection.title },
      );
      table($("#sims-table"), cols, s.teams, { sort: s.complete ? "st" : "pt", pool });
      // swap matrix
      const order = s.teams.map(t => t.team_id);
      const ix = Object.fromEntries(s.swap.order.map((t, i) => [t, i]));
      const W = s.swap.wins, mx = Math.max(...W.flat()), mn = Math.min(...W.flat());
      const shade = v => `background: rgba(42,120,214,${(0.06 + 0.55 * (v - mn) / Math.max(1, mx - mn)).toFixed(2)})`;
      $("#swap").innerHTML = `<thead><tr><th class="l">Team ↓ / schedule of →</th>${order.map(c => `<th class="rot">${esc(nm(c))}</th>`).join("")}</tr></thead><tbody>` +
        order.map(r => `<tr class="${SEL && s.teams.find(t => t.team_id === r).owner_key === SEL ? "me" : ""}"><td class="l">${esc(nm(r))}</td>` +
          order.map(c => { const v = W[ix[r]][ix[c]]; return `<td class="${r === c ? "diag" : ""}" style="${shade(v)}" title="${esc(nm(r))} with ${esc(nm(c))}'s schedule: ${v} wins">${v % 1 ? v.toFixed(1) : v}</td>`; }).join("") + "</tr>").join("") + "</tbody>";
    };
    seasonSelect($("#sims-select"), sYears, v => renderSims(v));
  } else {
    document.querySelector('[data-tab="sims"]').hidden = true;
  }
  if (!p5) ["power", "records", "styles"].forEach(t => (document.querySelector(`[data-tab="${t}"]`).hidden = true));

  // ---------- keepers + league tendencies (Draft tab) ----------
  function renderDraftHistory() {
    if (!p3 || !p3.keepers) return;
    const K = p3.keepers;
    const kcell = p => `${esc(p.player)} <span class="owner">${esc(p.pos)}</span><div class="owner">${esc(p.team)}</div>`;
    table($("#keeper-teams"), [
      { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise) },
      { key: "n", label: "Keepers" },
      { key: "saved", label: "Rounds saved", fmt: r => signed(r.saved, 0) },
      { key: "value", label: "Value", fmt: r => `<b>${signed(r.value, 0)}</b>` },
    ], K.by_team, { sort: "value" });
    const graded = K.picks.filter(p => p.pick_value != null).sort((a, b) => b.pick_value - a.pick_value);
    const bw = [...graded.slice(0, 3).map(p => ({ ...p, tag: "best" })), ...graded.slice(-3).reverse().map(p => ({ ...p, tag: "worst" }))];
    table($("#keeper-best"), [
      { key: "player", label: "Keeper", l: true, fmt: p => kcell(p) + yearTag(p) },
      { key: "round", label: "Cost", fmt: p => "Rd " + p.round },
      { key: "pts", label: "Pts", fmt: p => num(p.pts, 0) },
      { key: "pick_value", label: "Value", fmt: p => `<b>${signed(p.pick_value, 0)}</b> <span class="tag">${p.tag}</span>` },
    ], bw, { sortable: false });
    table($("#keepers"), [
      { key: "year", label: "Season", l: true },
      { key: "team", label: "Team", l: true, fmt: p => teamCell({ name: p.team, franchise: p.franchise }), sort: p => p.team.toLowerCase(), asc: true },
      { key: "player", label: "Keeper", l: true, fmt: p => `${esc(p.player)} <span class="owner">${esc(p.pos)}</span>`, sort: p => p.player.toLowerCase(), asc: true },
      { key: "round", label: "Cost", fmt: p => "Rd " + p.round, asc: true },
      { key: "adp_round", label: "ADP round", fmt: p => p.adp_round ? "Rd " + p.adp_round : NA, asc: true },
      { key: "rounds_saved", label: "Rounds saved", fmt: p => signed(p.rounds_saved, 0) },
      { key: "pts", label: "Pts", fmt: p => num(p.pts, 0) },
      { key: "pos_finish", label: "Finish", fmt: p => esc(p.pos_finish || "–"), sort: p => +String(p.pos_finish || "").replace(/\D/g, "") || 999, asc: true },
      { key: "pick_value", label: "Value", fmt: p => signed(p.pick_value, 0) },
    ], K.picks, { sort: "year" });

    const T = p3.tendencies;
    const yrs = T.years.map(String);
    const lean = Object.entries(T.lean).filter(([pos]) => ["QB", "RB", "WR", "TE"].includes(pos))
      .map(([pos, v]) => ({ pos, ...v, n: T.n[pos] }));
    const leanCell = v => v == null ? NA : `${signed(v, 1)}`;
    table($("#lean"), [
      { key: "pos", label: "Pos", l: true },
      ...yrs.map(y => ({ key: y, label: y, fmt: r => leanCell(r[y]) })),
      { key: "all", label: "All", fmt: r => `<b>${leanCell(r.all)}</b>` },
    ], lean, { sortable: false, rowKey: () => null });
    table($("#early-mix"), [
      { key: "y", label: "Season", l: true },
      ...["RB", "WR", "QB", "TE"].map(pos => ({ key: pos, label: pos })),
    ], yrs.map(y => ({ y, ...T.early_mix[y] })).reverse(), { sortable: false, rowKey: () => null });
    table($("#firsts"), [
      { key: "pos", label: "Position", l: true },
      { key: "year", label: "Season", l: true },
      { key: "overall", label: "Pick", fmt: f => `#${f.overall} <span class="owner">round ${f.round}</span>` },
      { key: "adp", label: "Consensus", fmt: f => f.adp ? "#" + Math.round(f.adp) : NA },
      { key: "player", label: "Player", l: true, fmt: f => `${esc(f.player)}<div class="owner">${esc(f.team)}</div>` },
    ], T.firsts.filter(f => f.pos !== "K"), { sortable: false, rowKey: () => null });
  }

  // ---------- power (Elo) ----------
  function lineChart(el, series, { highlight, yLabel = "" } = {}) {
    const W = Math.max(320, el.clientWidth || el.parentElement.clientWidth - 32), H = 320;
    const padL = 44, padR = 12, padT = 12, padB = 26;
    const keys = []; const seen = new Set();
    series.forEach(s => s.points.forEach(p => { const k = p.year * 100 + p.week; if (!seen.has(k)) { seen.add(k); keys.push(k); } }));
    keys.sort((a, b) => a - b);
    const xi = Object.fromEntries(keys.map((k, i) => [k, i]));
    const ys = series.flatMap(s => s.points.map(p => p.elo));
    const y0 = Math.floor((Math.min(...ys) - 10) / 25) * 25, y1 = Math.ceil((Math.max(...ys) + 10) / 25) * 25;
    const sx = i => padL + (i / Math.max(1, keys.length - 1)) * (W - padL - padR);
    const sy = v => padT + (1 - (v - y0) / (y1 - y0)) * (H - padT - padB);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
    for (let v = y0; v <= y1; v += 25) {
      svg += `<line class="${v === 1500 ? "base" : "grid"}" x1="${padL}" x2="${W - padR}" y1="${sy(v)}" y2="${sy(v)}"/><text class="val" x="${padL - 6}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`;
    }
    keys.forEach((k, i) => { if (k % 100 === 0) svg += `<line class="grid" x1="${sx(i)}" x2="${sx(i)}" y1="${padT}" y2="${H - padB}"/><text class="yr" x="${sx(i) + 3}" y="${H - 8}">${Math.floor(k / 100)}</text>`; });
    const ordered = series.slice().sort((a, b) => (a.key === highlight) - (b.key === highlight));
    ordered.forEach(s => {
      const d = s.points.map((p, j) => `${j ? "L" : "M"}${sx(xi[p.year * 100 + p.week]).toFixed(1)},${sy(p.elo).toFixed(1)}`).join("");
      svg += `<path class="line${s.key === highlight ? " hl" : ""}" data-k="${esc(s.key)}" d="${d}"/>`;
      if (s.key === highlight) { const last = s.points[s.points.length - 1]; svg += `<text class="me" x="${Math.min(W - padR - 4, sx(xi[last.year * 100 + last.week]) + 4)}" y="${sy(last.elo) - 6}" text-anchor="end">${esc(s.label)} ${Math.round(last.elo)}</text>`; }
    });
    el.innerHTML = svg + "</svg>";
    el.querySelectorAll("path.line").forEach(path => {
      const s = series.find(x => x.key === path.dataset.k);
      path.addEventListener("mousemove", e => { path.classList.add("hover"); const last = s.points[s.points.length - 1]; tipOn(e, `<b>${esc(s.label)}</b><br>Now ${Math.round(last.elo)} · peak ${Math.round(Math.max(...s.points.map(p => p.elo)))}`); });
      path.addEventListener("mouseleave", () => { path.classList.remove("hover"); tipOff(); });
    });
  }
  function renderPower() {
    if (!p5) return;
    const E = p5.elo, acc = E.accuracy, pb = p5.points_backtest;
    $("#elo-hint").innerHTML = `Elo rating for each franchise, carried across seasons (everyone starts at 1500; ratings move halfway back toward 1500 each offseason; bigger wins move ratings more). Regular season and winners' bracket. <b>Heads up:</b> in this league's history the pre-game Elo favorite won only ${Math.round(acc.hit_rate * 100)}% of ${acc.games} games, and a season-to-date points average picked ${Math.round(pb.hit_rate * 100)}%. Weekly results here are close to a coin flip, so read this as who has been winning, not a forecast.`;
    $("#elo-chart-title").textContent = SEL ? `Elo over time: ${fname[SEL]}` : "Elo over time (select your team to highlight it)";
    const series = Object.entries(E.timeline).map(([k, pts]) => ({ key: k, label: fname[k] || "Unknown", points: pts }));
    const draw = () => lineChart($("#elo-chart"), series, { highlight: SEL });
    draw();
    const ci = charts.findIndex(c => c[0] === $("#elo-chart")); if (ci >= 0) charts.splice(ci, 1);
    charts.push([$("#elo-chart"), [], { redrawFn: draw }]);
    const wk = p => p.week ? `${p.year} wk ${p.week}` : `${p.year} start`;
    table($("#elo-table"), [
      { key: "rank", label: "#", fmt: (r) => r.rank, asc: true },
      { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise) + (r.active ? "" : ' <span class="tag">former</span>'), sort: r => r.franchise.toLowerCase(), asc: true },
      { key: "elo", label: "Elo", fmt: r => `<b>${Math.round(r.elo)}</b>` },
      { key: "change", label: "Last game", fmt: r => signed(r.change, 1) },
      { key: "peak", label: "Peak", fmt: r => `${Math.round(r.peak.elo)} <span class="owner">${wk(r.peak)}</span>`, sort: r => r.peak.elo },
      { key: "low", label: "Low", fmt: r => `${Math.round(r.low.elo)} <span class="owner">${wk(r.low)}</span>`, sort: r => r.low.elo },
    ], E.ratings.map((r, i) => ({ ...r, rank: i + 1 })), { sort: "rank", dir: 1 });
    const P = p5.predictions;
    if (P && P.games.length) {
      $("#pred-title").textContent = `${P.year} week ${P.week}${P.games[0].playoff ? " (playoffs)" : ""}: win chances`;
      $("#pred-hint").textContent = `Average of Elo and a points model (each team's scoring average this season). For fun: the better of the two has picked ${Math.round(pb.hit_rate * 100)}% of winners here.`;
      table($("#preds"), [
        { key: "a", label: "Matchup", l: true, fmt: g => `${esc(g.a)}<div class="owner">vs ${esc(g.b)}</div>` },
        { key: "p", label: "Win %", fmt: g => `<b>${Math.round(g.p * 100)}%</b> <span class="owner">${Math.round((1 - g.p) * 100)}%</span>` },
        { key: "elo_p", label: "Elo", fmt: g => Math.round(g.elo_p * 100) + "%" },
        { key: "score_p", label: "Points", fmt: g => `${Math.round(g.score_p * 100)}% <span class="owner">${g.a_avg}–${g.b_avg}</span>` },
      ], P.games, { sortable: false, rowKey: g => (SEL && (g.a_key === SEL || g.b_key === SEL)) ? SEL : null });
    } else {
      $("#pred-title").textContent = "This week";
      $("#pred-hint").textContent = "No upcoming matchups (season over).";
      $("#preds").innerHTML = "";
    }
    table($("#upsets"), [
      { key: "year", label: "When", l: true, fmt: u => `${u.year} wk ${u.week}${u.playoff ? ' <span class="tag">playoff</span>' : ""}` },
      { key: "winner", label: "Underdog won", l: true, fmt: u => `${esc(u.winner)}<div class="owner">beat ${esc(u.loser)}</div>` },
      { key: "score", label: "Score" },
      { key: "win_p", label: "Win chance", fmt: u => `<b>${Math.round(u.win_p * 100)}%</b>` },
    ], E.upsets, { sortable: false, rowKey: u => SEL && (u.owner_key === SEL || u.loser_key === SEL) ? SEL : null });
  }

  // ---------- records ----------
  function renderRecords() {
    if (!p5) return;
    const R = p5.records;
    const li = (me, main, sub) => `<li class="${SEL && me === SEL ? "me" : ""}"><span class="recval">${main}</span> ${sub}</li>`;
    const game = (x, val) => li(x.owner_key, val, `${esc(x.team)} <span class="owner">${x.year} wk ${x.week}${x.playoff ? " · playoff" : ""} · ${x.score.toFixed(1)}–${x.opp_score.toFixed(1)} vs ${esc(x.opp)}</span>`);
    const card = (title, items) => `<div class="card"><h3>${title}</h3><ol>${items.join("")}</ol></div>`;
    const S = R.singles;
    const blocks = [
      card("Highest score", S.high_score.map(x => game(x, x.score.toFixed(1)))),
      card("Lowest score", S.low_score.map(x => game(x, x.score.toFixed(1)))),
      card("Biggest blowout", S.blowout.map(x => game(x, "+" + x.margin.toFixed(1)))),
      card("Closest game", S.closest.map(x => game(x, "+" + x.margin.toFixed(2)))),
      card("Most points in a loss", S.most_in_loss.map(x => game(x, x.score.toFixed(1)))),
      card("Fewest points in a win", S.fewest_in_win.map(x => game(x, x.score.toFixed(1)))),
      card("Longest winning streak", R.streaks.win.map(s => li(s.owner_key, `${s.len} W`, `${esc(s.team)} <span class="owner">${s.year} wk ${s.from}–${s.to}</span>`))),
      card("Longest losing streak", R.streaks.loss.map(s => li(s.owner_key, `${s.len} L`, `${esc(s.team)} <span class="owner">${s.year} wk ${s.from}–${s.to}</span>`))),
      card("Best regular season", R.seasons.best_record.map(r => li(r.owner_key, r.record, `${esc(r.team)} <span class="owner">${r.year} · ${r.ppg} ppg</span>`))),
      card("Worst regular season", R.seasons.worst_record.map(r => li(r.owner_key, r.record, `${esc(r.team)} <span class="owner">${r.year} · ${r.ppg} ppg</span>`))),
      card("Most points per game (season)", R.seasons.most_ppg.map(r => li(r.owner_key, r.ppg.toFixed(1), `${esc(r.team)} <span class="owner">${r.year} · ${r.record}</span>`))),
      card("Fewest points per game (season)", R.seasons.fewest_ppg.map(r => li(r.owner_key, r.ppg.toFixed(1), `${esc(r.team)} <span class="owner">${r.year} · ${r.record}</span>`))),
    ];
    $("#record-book").innerHTML = blocks.join("");

    // rivalries
    const selA = $("#riv-a"), selB = $("#riv-b");
    if (!selA.options.length) {
      const opts = franchises.map(f => `<option value="${esc(f.key)}">${esc(f.name)}</option>`).join("");
      selA.innerHTML = opts; selB.innerHTML = opts;
      const top = R.rivalries[0];
      selA.value = top.a; selB.value = top.b;
      selA.addEventListener("change", renderRivalry); selB.addEventListener("change", renderRivalry);
    }
    if (SEL && selA.dataset.sel !== SEL) {   // follow the picked team once per pick
      selA.dataset.sel = SEL; selA.value = SEL;
      if (selB.value === SEL) { const best = R.rivalries.find(r => r.a === SEL || r.b === SEL); if (best) selB.value = best.a === SEL ? best.b : best.a; }
    }
    renderRivalry();
    table($("#rivalries"), [
      { key: "pair", label: "Rivalry", l: true, fmt: r => `${esc(r.a_name)}<div class="owner">vs ${esc(r.b_name)}</div>`, sort: r => r.a_name.toLowerCase(), asc: true },
      { key: "n", label: "Games" },
      { key: "rec", label: "Series", fmt: r => `${r.a_w}-${r.b_w}${r.t ? "-" + r.t : ""}`, sort: r => r.a_w - r.b_w },
      { key: "balance", label: "Balance", fmt: r => Math.round(r.balance * 100) + "%" },
      { key: "avg_margin", label: "Avg margin", fmt: r => num(r.avg_margin, 1) },
      { key: "playoff_games", label: "Playoff games" },
      { key: "streak", label: "Streak", fmt: r => r.streak.side ? `${esc(r.streak.side === "a" ? r.a_name : r.b_name)} ${r.streak.len}` : NA, sort: r => r.streak.len },
    ], R.rivalries, { sort: "n", rowKey: r => SEL && (r.a === SEL || r.b === SEL) ? SEL : null });

    // curse
    $("#curse").innerHTML = (p5.curse || []).map(c => `<div class="curse-card ${SEL && c.owner_key === SEL ? "me" : ""}">
      <div class="yr">${c.year} · last place: ${esc(c.team)}</div>
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.text)}</p>
      <div class="facts">${esc(c.pos)} · pick ${c.slot} · ADP ${c.adp ? Math.round(c.adp) : "–"} · ${Math.round(c.pts)} pts · ${esc(c.pos_finish || "–")} (expected ${esc(c.pos_adp || "–")}) · played ${c.games} of ${c.weeks} weeks</div>
    </div>`).join("") || '<p class="hint">No finished seasons yet.</p>';
  }
  function renderRivalry() {
    const R = p5.records, a = $("#riv-a").value, b = $("#riv-b").value, el = $("#riv-detail");
    if (a === b) { el.innerHTML = '<p class="hint">Pick two different teams.</p>'; return; }
    const r = R.rivalries.find(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
    if (!r) { el.innerHTML = '<p class="hint">These two have never played.</p>'; return; }
    const flip = r.a !== a;
    const A = flip ? { name: r.b_name, w: r.b_w } : { name: r.a_name, w: r.a_w }, B = flip ? { name: r.a_name, w: r.a_w } : { name: r.b_name, w: r.b_w };
    const games = r.games.map(g => flip ? { ...g, a_team: g.b_team, b_team: g.a_team, a_score: g.b_score, b_score: g.a_score } : g);
    const margins = games.map(g => g.a_score - g.b_score);
    const big = (sign) => { const i = margins.reduce((bi, m, j) => (sign * m > sign * margins[bi] ? j : bi), 0); return games[i]; };
    const bigA = big(1), bigB = big(-1);
    const st = r.streak.side ? `${(r.streak.side === "a") !== flip ? A.name : B.name} has won ${r.streak.len} straight` : "";
    el.innerHTML = `<div class="series">${[
      ["Series", `${A.w}-${B.w}${r.t ? "-" + r.t : ""}`, `${esc(A.name)} vs ${esc(B.name)}`],
      ["Games", r.n, `${r.playoff_games} in the playoffs`],
      ["Avg margin", num(r.avg_margin, 1), esc(st)],
      [`Biggest ${esc(A.name)} win`, bigA.a_score > bigA.b_score ? "+" + (bigA.a_score - bigA.b_score).toFixed(1) : "–", bigA.a_score > bigA.b_score ? `${bigA.year} wk ${bigA.week}` : "never won"],
      [`Biggest ${esc(B.name)} win`, bigB.b_score > bigB.a_score ? "+" + (bigB.b_score - bigB.a_score).toFixed(1) : "–", bigB.b_score > bigB.a_score ? `${bigB.year} wk ${bigB.week}` : "never won"],
    ].map(tile).join("")}</div><div class="table-wrap" style="margin-top:12px"><table id="riv-games"></table></div>`;
    table($("#riv-games"), [
      { key: "year", label: "When", l: true, fmt: g => `${g.year} wk ${g.week}${g.playoff ? ' <span class="tag">playoff</span>' : ""}` },
      { key: "a_team", label: esc(A.name), l: true, fmt: g => `${g.a_score > g.b_score ? "<b>" : ""}${esc(g.a_team)} ${g.a_score.toFixed(1)}${g.a_score > g.b_score ? "</b>" : ""}` },
      { key: "b_team", label: esc(B.name), l: true, fmt: g => `${g.b_score > g.a_score ? "<b>" : ""}${esc(g.b_team)} ${g.b_score.toFixed(1)}${g.b_score > g.a_score ? "</b>" : ""}` },
      { key: "m", label: "Margin", fmt: g => signed(g.a_score - g.b_score, 1) },
    ], games, { sortable: false, rowKey: () => null });
    // Aggregate points under the game log: totals and per-game averages for each side.
    const ta = sum(games, g => g.a_score), tb = sum(games, g => g.b_score), n = games.length;
    const lead = (x, y) => x > y ? "<b>" : "", end = (x, y) => x > y ? "</b>" : "";
    $("#riv-games").insertAdjacentHTML("beforeend", `<tfoot>
      <tr><td class="l">Total points <span class="owner">${n} games</span></td>
        <td class="l">${lead(ta, tb)}${ta.toFixed(1)}${end(ta, tb)}</td><td class="l">${lead(tb, ta)}${tb.toFixed(1)}${end(tb, ta)}</td><td>${signed(ta - tb, 1)}</td></tr>
      <tr><td class="l">Per game</td>
        <td class="l">${(ta / n).toFixed(1)}</td><td class="l">${(tb / n).toFixed(1)}</td><td>${signed((ta - tb) / n, 1)}</td></tr>
    </tfoot>`);
  }

  // ---------- styles ----------
  function renderStyles() {
    if (!p5) return;
    const C = p5.clutch;
    hbar($("#clutch-chart"), C.teams.map(t => ({ label: t.franchise, value: t.clutch, owner_key: t.owner_key, t })), {
      fmt: v => signed(v, 1),
      tipFn: it => `<b>${esc(it.t.franchise)}</b><br>${it.t.n} playoff games · ${it.t.w}-${it.t.l}<br>${signed(it.t.clutch, 1)} pts/wk vs own season average`,
    });
    table($("#clutch-table"), [
      { key: "franchise", label: "Franchise", l: true, fmt: t => esc(t.franchise) },
      { key: "w", label: "W-L", fmt: t => `${t.w}-${t.l}`, sort: t => t.w / Math.max(1, t.n) },
      { key: "finals", label: "Finals", fmt: t => `${t.finals} <span class="owner">${t.titles} won</span>` },
      { key: "clutch", label: "Clutch", fmt: t => `<b>${signed(t.clutch, 1)}</b>` },
      { key: "best", label: "Best playoff game", l: true, fmt: t => `${t.best.score.toFixed(1)} <span class="owner">${t.best.year} wk ${t.best.week} · ${signed(t.best.diff, 1)} vs avg</span>`, sort: t => t.best.diff },
    ], C.teams, { sort: "clutch" });
    const label = { adds: ["Few adds", "Many adds"], avg_bid: ["Cheap", "Spends big"], efficiency: ["Bench regret", "Sharp lineups"],
                    avg_steal: ["Reaches", "Lets value fall"], trades: ["No trades", "Trades a lot"], early_rb: ["WR early", "RB early"],
                    qb_round: ["QB early", "QB late"], clutch: ["Cools off", "Rises"] };
    $("#style-cards").innerHTML = p5.styles.map(c => `<div class="style-card ${SEL && c.owner_key === SEL ? "me" : ""}">
      <h3>${esc(c.franchise)}</h3><div class="owner">${c.seasons} season${c.seasons === 1 ? "" : "s"}</div>
      ${c.new ? '<p class="hint">Too new to profile: needs two seasons.</p>' : `
      <div class="badges">${c.traits.map(t => `<span class="badge">${esc(t.label)} <small>${esc(t.blurb)}</small></span>`).join("") || '<span class="hint">Middle of the pack on everything.</span>'}</div>
      ${c.bars.filter(b => b.pct != null).map(b => `<div class="meter" title="P${b.pct}"><span>${label[b.metric][0]}</span><span class="track"><span class="mid"></span><span class="dot" style="left:${b.pct}%"></span></span><span class="r">${label[b.metric][1]}</span></div>`).join("")}`}
    </div>`).join("");
  }

  // ---------- picker + percentile toggle ----------
  const picker = $("#team-picker");
  picker.innerHTML = '<option value="">All teams (no highlight)</option>' +
    franchises.map(f => `<option value="${esc(f.key)}">${esc(f.name)}</option>`).join("");
  picker.value = SEL || "";
  const toggle = $("#pct-toggle");
  toggle.checked = PCT;
  function renderAll() {
    $("#pct-hint").hidden = !PCT;
    renderOverview(); renderChamps(); renderAlltime();
    renderSeason(selVal("#season-select")); renderRegret(selVal("#regret-select"));
    if (p2) renderWaivers(selVal("#waiver-select"));
    if (p3) renderDraft(selVal("#draft-select"));
    if (p4) renderSims(selVal("#sims-select"));
    renderDraftHistory(); renderPower(); renderRecords(); renderStyles();
  }
  picker.addEventListener("change", () => {
    SEL = picker.value || null;
    store.set("ffdash.team", SEL);
    try {
      const u = new URL(location.href);
      SEL ? u.searchParams.set("team", SEL) : u.searchParams.delete("team");
      history.replaceState(null, "", u);
    } catch (e) {}
    renderAll();
  });
  toggle.addEventListener("change", () => { PCT = toggle.checked; store.set("ffdash.pct", PCT ? "1" : null); renderAll(); });
  renderAll();

  // ---------- data notes ----------
  const yn = v => v ? '<span class="yes">yes</span>' : '<span class="no">missing</span>';
  table($("#coverage"), [
    { key: "year", label: "Season", l: true },
    { key: "available", label: "Season", fmt: c => yn(c.available) },
    { key: "scores", label: "Scores", fmt: c => yn(c.scores) },
    { key: "lineups", label: "Lineups", fmt: c => c.lineup_periods_expected ? `${yn(c.lineups)} <span class="owner">${c.lineup_periods}/${c.lineup_periods_expected} wks</span>` : yn(c.lineups) },
    { key: "owners", label: "Managers", fmt: c => yn(c.owners) },
    { key: "transactions", label: "Waivers", fmt: c => c.transactions == null ? "–" : `${yn(c.transactions)}${c.transactions && !c.faab ? ' <span class="owner">no FAAB</span>' : ""}` },
    { key: "draft", label: "Draft", fmt: c => c.draft == null ? "–" : yn(c.draft) },
    { key: "notes", label: "Missing / caveats", cls: "wrapcell", fmt: c => esc((c.notes || []).join(" ")) || '<span class="na">none</span>' },
    { key: "changes", label: "League changes", cls: "wrapcell", fmt: c => esc((c.changes || []).join(" ")) },
  ], league.coverage, { sortable: false, rowKey: () => null });
  $("#identity-notes").innerHTML = (p1.identity_notes || []).map(n => `<li>${esc(n)}</li>`).join("") || "<li>None.</li>";
})();
