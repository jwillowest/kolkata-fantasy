"use strict";
(async function () {
  const [league, p1, p2] = await Promise.all([
    fetch("data/league.json").then(r => r.json()),
    fetch("data/phase1.json").then(r => r.json()),
    fetch("data/phase2.json").then(r => r.json()).catch(() => null),
  ]);
  // Highlighted franchise: chosen by each viewer (?team=<id> or the picker); none by default.
  const franchises = p1.all_time.map(r => ({ key: r.owner_key, name: r.franchise }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const validKey = k => franchises.some(f => f.key === k) ? k : null;
  let SEL = validKey(new URLSearchParams(location.search).get("team"));
  if (!SEL) { try { SEL = validKey(localStorage.getItem("ffdash.team")); } catch (e) {} }
  const years = Object.keys(p1.seasons).map(Number).sort((a, b) => b - a);
  const cov = Object.fromEntries(league.coverage.map(c => [c.year, c]));
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (v, d = 1) => v == null ? '<span class="na">–</span>' : Number(v).toFixed(d);
  const signed = (v, d = 2) => v == null ? '<span class="na">–</span>' : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
  const rec = (w, l, t) => `${w | 0}-${l | 0}${t ? "-" + (t | 0) : ""}`;
  const pct = v => v == null ? "–" : v.toFixed(3).replace(/^0/, "");

  document.title = league.name + " Analytics";
  $("#logo").textContent = league.name;
  $("#updated").textContent = `Seasons ${Math.min(...years)}–${Math.max(...years)} · updated ${new Date(league.generated_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  const charts = [];
  // ---------- tabs ----------
  const tabs = [...document.querySelectorAll("#tabs button")];
  function show(name) {
    tabs.forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach(s => (s.hidden = s.id !== "tab-" + name));
    charts.forEach(([el, items, o]) => el.offsetParent && hbar(el, items, o, true));
    try { history.replaceState(null, "", "#" + name); } catch (e) {}
  }
  tabs.forEach(b => b.addEventListener("click", () => show(b.dataset.tab)));
  const initial = location.hash.slice(1);
  if (tabs.some(b => b.dataset.tab === initial)) show(initial);
  addEventListener("hashchange", () => {
    const h = location.hash.slice(1);
    if (tabs.some(b => b.dataset.tab === h)) show(h);
  });

  // ---------- tooltip ----------
  const tip = $("#tip");
  function tipOn(e, html) {
    tip.innerHTML = html; tip.hidden = false;
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = e.clientY + 14 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 14;
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  const tipOff = () => (tip.hidden = true);

  // ---------- table ----------
  function table(el, cols, rows, opts = {}) {
    let sortKey = opts.sort, dir = opts.dir || -1;
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
      el.innerHTML =
        "<thead><tr>" + cols.map(c => `<th class="${c.l ? "l" : ""}" data-k="${c.key}" ${opts.sortable !== false && sortKey === c.key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}</th>`).join("") + "</tr></thead>" +
        "<tbody>" + data.map(r => `<tr class="${SEL && (opts.rowKey ? opts.rowKey(r) : r.owner_key) === SEL ? "me" : ""}">` + cols.map(c => `<td class="${c.cls || (c.l ? "l" : "")}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join("") + "</tr>").join("") + "</tbody>";
      if (el.classList.contains("sortable")) {
        el.querySelectorAll("th").forEach(th => th.addEventListener("click", () => {
          const k = th.dataset.k;
          dir = sortKey === k ? -dir : (cols.find(c => c.key === k).asc ? 1 : -1);
          sortKey = k; draw();
        }));
      }
    }
    draw();
  }
  // Season team name, plus the franchise's current name when it has changed since.
  const now = r => r.franchise && r.franchise !== r.name ? `<div class="owner">now ${esc(r.franchise)}</div>` : "";
  const teamCell = r => `${esc(r.name)}${now(r)}`;

  // ---------- horizontal bar chart (diverging when values can be negative) ----------
  addEventListener("resize", () => charts.forEach(([el, items, o]) => el.offsetParent && hbar(el, items, o, true)));
  function hbar(el, items, opts = {}, redraw) {
    const { fmt = v => v.toFixed(1), tipFn } = opts;
    if (!redraw) { const i = charts.findIndex(c => c[0] === el); if (i >= 0) charts.splice(i, 1); charts.push([el, items, opts]); }
    const W = Math.max(300, el.clientWidth || el.parentElement.clientWidth - 32), rowH = 26, labelW = Math.min(170, W * 0.36), valW = 44, pad = 6;
    const H = items.length * rowH + 22;
    const min = Math.min(0, ...items.map(i => i.value)), max = Math.max(0, ...items.map(i => i.value));
    const span = (max - min) || 1;
    const plotW = W - labelW - valW * (min < 0 ? 2 : 1);
    const x0 = labelW + (min < 0 ? valW : 0);
    const sx = v => x0 + ((v - min) / span) * plotW;
    const zero = sx(0);
    // nice ticks
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
      // round only the data end, square on the baseline
      const path = neg
        ? `M${b},${by} H${a + r} Q${a},${by} ${a},${by + r} V${by + bh - r} Q${a},${by + bh} ${a + r},${by + bh} H${b} Z`
        : `M${a},${by} H${b - r} Q${b},${by} ${b},${by + r} V${by + bh - r} Q${b},${by + bh} ${b - r},${by + bh} H${a} Z`;
      const cls = min < 0 ? (neg ? "bar-neg" : "bar-pos") : "bar";
      const me = SEL && it.owner_key === SEL;
      svg += `<g class="row" data-i="${i}"><rect class="hl" x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"/>`;
      const maxCh = Math.floor(labelW / 7);
      svg += `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" class="${me ? "me" : ""}">${esc(it.label.length > maxCh ? it.label.slice(0, maxCh - 1) + "…" : it.label)}</text>`;
      svg += `<path class="${cls}" d="${path}"/>`;
      const tx = neg ? a - 4 : b + 4;
      svg += `<text class="val" x="${tx}" y="${y + rowH / 2 + 4}" text-anchor="${neg ? "end" : "start"}">${fmt(it.value)}</text></g>`;
    });
    svg += "</svg>";
    el.innerHTML = svg;
    el.querySelectorAll("g.row").forEach(g => {
      const it = items[+g.dataset.i];
      g.addEventListener("mousemove", e => tipOn(e, tipFn ? tipFn(it) : `<b>${esc(it.label)}</b><br>${fmt(it.value)}`));
      g.addEventListener("mouseleave", tipOff);
    });
  }

  // ---------- overview ----------
  const curYear = league.current_season;
  const tile = ([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
  function renderOverview() {
    const f = SEL && p1.all_time.find(r => r.owner_key === SEL);
    let tiles, h2hRows = null;
    if (f) {
      const cur = p1.seasons[curYear]?.standings.find(r => r.owner_key === SEL);
      const won = p1.champions.filter(c => c.champion && c.champion.owner_key === SEL).map(c => c.year);
      const fname = Object.fromEntries(p1.all_time.map(r => [r.owner_key, r.franchise]));
      const h2h = Object.entries(p1.head_to_head?.[SEL] || {}).map(([k, r]) => {
        const g = r.w + r.l + r.t;
        return { opp: fname[k] || "Unknown", owner_key: k, g, pct: g ? (r.w + 0.5 * r.t) / g : 0, ...r };
      });
      const ranked = h2h.filter(r => r.g >= 3).sort((a, b) => b.pct - a.pct || b.g - a.g);
      const bestM = ranked[0], worstM = ranked[ranked.length - 1];
      const mtile = (label, m) => [label, m ? rec(m.w, m.l, m.t) : "–", m ? `vs ${esc(m.opp)}` : "needs 3+ games vs one team"];
      tiles = [
        ["Titles", f.titles, won.length ? won.join(", ") : `${f.runner_ups} runner-up finish${f.runner_ups === 1 ? "" : "es"}`],
        ["Total wins", f.w, `${f.seasons} season${f.seasons === 1 ? "" : "s"}, regular season`],
        ["Total losses", f.l, f.t ? `${f.t} tie${f.t === 1 ? "" : "s"} · ${pct(f.pct)} win %` : `${pct(f.pct)} win %`],
        ["Total points scored", Math.round(f.pf).toLocaleString(), "regular season"],
        ["Total bench points", f.bench_pts == null ? "–" : Math.round(f.bench_pts).toLocaleString(), f.regret_pts == null ? "" : `${Math.round(f.regret_pts).toLocaleString()} should have started`],
        mtile("Best matchup", bestM),
        mtile("Worst matchup", worstM),
        ["Career luck", signed(f.luck, 1), "wins vs all-play expectation"],
      ];
      h2hRows = h2h;
      if (cur) tiles.unshift([`${curYear} so far`, rec(cur.w, cur.l, cur.t), `#${cur.h2h_rank} H2H · #${cur.ap_rank} all-play · luck ${signed(cur.luck, 1)}`]);
    } else {
      const at = p1.all_time;
      const most = at.slice().sort((a, b) => b.titles - a.titles || b.pct - a.pct)[0];
      const best = at.filter(r => r.seasons >= 3).sort((a, b) => b.pct - a.pct)[0];
      const lucky = at.slice().sort((a, b) => b.luck - a.luck)[0];
      const champs = p1.champions.filter(c => c.champion).length;
      tiles = [
        ["Seasons", years.length, `${champs} champions crowned`],
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
  const who = x => x ? `${esc(x.name)}${now(x)}` : '<span class="na">–</span>';
  function renderChamps() {
    table($("#champs"), [
      { key: "year", label: "Season", l: true, fmt: r => r.year + (r.in_progress ? ' <span class="flag">in progress</span>' : "") },
      { key: "champion", label: "Champion", l: true, fmt: r => who(r.champion) },
      { key: "runner_up", label: "Runner-up", l: true, fmt: r => who(r.runner_up) },
      { key: "reg", label: "Best regular season", l: true, fmt: r => who(r.reg_season_best) },
      { key: "pf", label: "Most points", l: true, fmt: r => who(r.top_pf) },
      { key: "last", label: "Last place", l: true, fmt: r => who(r.last_place) },
    ], p1.champions.slice().sort((a, b) => b.year - a.year),
    // Only the picked franchise's title-winning seasons are highlighted.
    { sortable: false, rowKey: c => c.champion && c.champion.owner_key });
  }

  // Banner only for genuinely missing data; smaller discrepancies stay on the Data notes tab and per-tab flags.
  const flagged = league.coverage.filter(c => !c.available || !c.scores || !c.lineups || c.transactions === false);
  if (flagged.length) {
    const b = $("#coverage-banner");
    b.hidden = false;
    b.innerHTML = `Missing or partial ESPN data for ${flagged.map(c => c.year).join(", ")}. <a href="#data" data-go="data">See data notes</a>.`;
    b.querySelector("a").addEventListener("click", e => { e.preventDefault(); show("data"); });
  }

  // ---------- season ----------
  function fillSelect(sel, onChange) {
    sel.innerHTML = years.map(y => `<option>${y}</option>`).join("");
    sel.addEventListener("change", () => onChange(+sel.value));
  }
  function renderSeason(y) {
    const s = p1.seasons[y], c = cov[y] || {};
    const flag = $("#season-flag");
    const msgs = [];
    if (!s.complete) msgs.push(`In progress: ${s.periods_played} of ${s.reg_season_periods} regular-season weeks played`);
    (c.notes || []).forEach(n => msgs.push(n));
    flag.hidden = !msgs.length; flag.textContent = msgs.join(" · ");
    table($("#standings"), [
      { key: "h2h_rank", label: "#", asc: true },
      { key: "name", label: "Team", l: true, fmt: teamCell, sort: r => r.name.toLowerCase(), asc: true },
      { key: "w", label: "H2H", fmt: r => rec(r.w, r.l, r.t), sort: r => r.pct },
      { key: "pf", label: "PF", fmt: r => num(r.pf) },
      { key: "pa", label: "PA", fmt: r => num(r.pa) },
      { key: "ap_pct", label: "All-play", fmt: r => `${rec(r.ap_w, r.ap_l, r.ap_t)} <span class="owner">${pct(r.ap_pct)}</span>` },
      { key: "exp_w", label: "Exp W", fmt: r => num(r.exp_w, 1) },
      { key: "luck", label: "Luck", fmt: r => signed(r.luck, 1) },
      { key: "med_w", label: "Median fmt", fmt: r => rec(r.med_w, r.med_l, r.med_t), sort: r => r.med_w + 0.5 * r.med_t },
      { key: "top_weeks", label: "Top score wks" },
      { key: "final_rank", label: "Final", asc: true, fmt: r => r.final_rank ?? '<span class="na">–</span>' },
    ], s.standings, { sort: "h2h_rank", dir: 1 });
    const luck = s.standings.slice().sort((a, b) => b.luck - a.luck)
      .map(r => ({ label: r.name, value: r.luck, owner_key: r.owner_key, r }));
    hbar($("#luck-chart"), luck, {
      fmt: v => signed(v, 1),
      tipFn: it => `<b>${esc(it.r.name)}</b><br>Actual ${rec(it.r.w, it.r.l, it.r.t)} · expected ${it.r.exp_w.toFixed(1)} wins<br>Luck ${signed(it.value, 2)}`,
    });
    const arrow = (a, b) => a === b ? "" : `<span class="owner"> (${a > b ? "▲" : "▼"}${Math.abs(a - b)})</span>`;
    table($("#formats"), [
      { key: "name", label: "Team", l: true, fmt: teamCell },
      { key: "h2h_rank", label: "H2H", asc: true },
      { key: "ap_rank", label: "All-play", fmt: r => r.ap_rank + arrow(r.h2h_rank, r.ap_rank) },
      { key: "med_rank", label: "Median", fmt: r => r.med_rank + arrow(r.h2h_rank, r.med_rank) },
    ], s.standings, { sort: "h2h_rank", dir: 1, sortable: false });
  }
  fillSelect($("#season-select"), renderSeason);

  // ---------- all-time ----------
  function renderAlltime() {
  table($("#alltime"), [
    { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise), sort: r => r.franchise.toLowerCase(), asc: true },
    { key: "seasons", label: "Seasons" },
    { key: "titles", label: "Titles" },
    { key: "runner_ups", label: "2nd" },
    { key: "playoffs", label: "Playoffs" },
    { key: "pct", label: "H2H", fmt: r => `${rec(r.w, r.l, r.t)} <span class="owner">${pct(r.pct)}</span>` },
    { key: "ap_pct", label: "All-play %", fmt: r => pct(r.ap_pct) },
    { key: "luck", label: "Luck", fmt: r => signed(r.luck, 1) },
    { key: "med_w", label: "Median fmt", fmt: r => rec(r.med_w, r.med_l) },
    { key: "pf", label: "PF", fmt: r => Math.round(r.pf).toLocaleString() },
    { key: "regret_pts", label: "Bench pts", fmt: r => r.regret_pts == null ? "–" : Math.round(r.regret_pts).toLocaleString() },
    { key: "last_places", label: "Last" },
  ], p1.all_time, { sort: "titles" });
  hbar($("#career-luck"), p1.all_time.slice().sort((a, b) => b.luck - a.luck).map(r => ({ label: r.franchise, value: r.luck, owner_key: r.owner_key, r })), {
    fmt: v => signed(v, 1),
    tipFn: it => `<b>${esc(it.r.franchise)}</b><br>${it.r.seasons} seasons · ${rec(it.r.w, it.r.l, it.r.t)}<br>Luck ${signed(it.value, 2)} wins`,
  });
  }

  // ---------- regret ----------
  function renderRegret(y) {
    const s = p1.seasons[y];
    const rows = s.standings.filter(r => r.regret_pts != null);
    const empty = '<p class="hint">No lineup data for this season.</p>';
    if (!rows.length) { $("#regret-chart").innerHTML = empty; $("#regret-table").innerHTML = ""; $("#blunders").innerHTML = ""; return; }
    hbar($("#regret-chart"), rows.slice().sort((a, b) => b.regret_pts - a.regret_pts).map(r => ({ label: r.name, value: r.regret_pts, owner_key: r.owner_key, r })), {
      fmt: v => v.toFixed(0),
      tipFn: it => `<b>${esc(it.r.name)}</b><br>${it.r.regret_pts.toFixed(1)} pts left on bench<br>${it.r.regret_losses} games cost · ${(it.r.efficiency * 100).toFixed(1)}% efficient`,
    });
    table($("#regret-table"), [
      { key: "name", label: "Team", l: true, fmt: teamCell },
      { key: "efficiency", label: "Efficiency", fmt: r => (r.efficiency * 100).toFixed(1) + "%" },
      { key: "regret_losses", label: "Games cost" },
      { key: "lineup_pf", label: "Used", fmt: r => num(r.lineup_pf, 0) },
      { key: "optimal_pf", label: "Best", fmt: r => num(r.optimal_pf, 0) },
    ], rows, { sort: "efficiency" });
    const owners = Object.fromEntries(s.standings.map(r => [r.team_id, r]));
    table($("#blunders"), [
      { key: "period", label: "Wk" },
      { key: "team", label: "Team", l: true, fmt: b => teamCell(owners[b.team_id] || { name: b.team }) },
      { key: "lost", label: "Pts lost", fmt: b => b.lost.toFixed(1) },
      { key: "cost", label: "Result", l: true, fmt: b => b.playoff ? "playoff" : b.cost_game ? "<b>cost the game</b>" : "" },
      { key: "should_start", label: "Should have started", cls: "wrapcell", fmt: b => esc(b.should_start.join(", ")) },
      { key: "did_start", label: "Instead of", cls: "wrapcell", fmt: b => esc(b.did_start.join(", ")) },
    ], s.blunders.slice(0, 15).map(b => ({ ...b, owner_key: owners[b.team_id]?.owner_key })), { sortable: false });
  }
  fillSelect($("#regret-select"), renderRegret);

  // ---------- waivers ----------
  if (p2) {
    const money = v => v == null ? '<span class="na">–</span>' : "$" + v;
    const playerCell = a => `${esc(a.player)}<div class="owner">${esc(a.team)}</div>`;
    const wk = a => a.sp ? `wk ${a.sp}` : "preseason";
    const wYears = Object.keys(p2.seasons).map(Number).sort((a, b) => b - a);
    function renderWaivers(y) {
      const w = p2.seasons[y];
      const flag = $("#waiver-flag");
      const msgs = (cov[y]?.notes || []).filter(n => /FAAB|add/.test(n));
      if (!p1.seasons[y]?.complete) msgs.unshift("In progress: values grow as the season goes on");
      flag.hidden = !msgs.length; flag.textContent = msgs.join(" · ");
      hbar($("#waiver-chart"), w.teams.map(t => ({ label: t.name, value: t.started_pts, owner_key: t.owner_key, t })), {
        fmt: v => Math.round(v),
        tipFn: it => `<b>${esc(it.t.name)}</b><br>${it.t.adds} adds · ${it.t.started_pts.toFixed(0)} started pts<br>Best: ${esc(it.t.best || "–")}`,
      });
      const cols = [
        { key: "name", label: "Team", l: true, fmt: teamCell, sort: r => r.name.toLowerCase(), asc: true },
        { key: "adds", label: "Adds" },
        { key: "pts_per_add", label: "Pts/add", fmt: r => num(r.pts_per_add, 1) },
        { key: "hits", label: "Hits" },
      ];
      if (w.faab) cols.push(
        { key: "faab_spent", label: "FAAB", fmt: r => money(r.faab_spent) },
        { key: "pts_per_dollar", label: "Pts/$", fmt: r => num(r.pts_per_dollar, 2) },
        { key: "overpaid", label: "Overpaid", fmt: r => money(r.overpaid) },
      );
      table($("#waiver-teams"), cols, w.teams, { sort: "pts_per_add" });
      table($("#best-adds"), [
        { key: "player", label: "Player", l: true, fmt: playerCell },
        { key: "sp", label: "Added", fmt: wk },
        { key: "bid", label: "Cost", fmt: a => w.faab ? money(a.bid) : (a.type === "FREEAGENT" ? "FA" : "waiver") },
        { key: "starts", label: "Starts" },
        { key: "started_pts", label: "Started pts", fmt: a => a.started_pts.toFixed(1) },
        { key: "bench_pts", label: "Bench pts", fmt: a => a.bench_pts.toFixed(1) },
      ], w.best_adds.slice(0, 12), { sortable: false });
      $("#faab-sections").hidden = !w.faab;
      if (w.faab) {
        table($("#best-value"), [
          { key: "player", label: "Player", l: true, fmt: playerCell },
          { key: "bid", label: "Bid", fmt: a => money(a.bid) },
          { key: "started_pts", label: "Pts", fmt: a => a.started_pts.toFixed(0) },
          { key: "pts_per_dollar", label: "Pts/$", fmt: a => a.pts_per_dollar.toFixed(1) },
        ], w.best_value.slice(0, 10), { sortable: false });
        table($("#busts"), [
          { key: "player", label: "Player", l: true, fmt: playerCell },
          { key: "bid", label: "Bid", fmt: a => money(a.bid) },
          { key: "starts", label: "Starts" },
          { key: "started_pts", label: "Pts", fmt: a => a.started_pts.toFixed(0) },
        ], w.busts.slice(0, 10), { sortable: false });
        table($("#overpays"), [
          { key: "player", label: "Player", l: true, fmt: playerCell },
          { key: "sp", label: "Run", fmt: wk },
          { key: "bid", label: "Winning bid", fmt: a => money(a.bid) },
          { key: "next_bid", label: "Next bid", fmt: a => a.next_bid == null ? '<span class="na">none</span>' : money(a.next_bid) },
          { key: "bidders", label: "Bidders" },
          { key: "overpay", label: "Overpaid by", fmt: a => `<b>${money(a.overpay)}</b>` },
          { key: "started_pts", label: "Started pts", fmt: a => a.started_pts.toFixed(0) },
        ], w.overpays.slice(0, 12), { sortable: false });
      }
    }
    const sel = $("#waiver-select");
    sel.innerHTML = wYears.map(y => `<option>${y}</option>`).join("");
    sel.addEventListener("change", () => renderWaivers(+sel.value));
    var renderWaiverAll = () => { renderWaivers(+sel.value); table($("#waiver-alltime"), [
      { key: "franchise", label: "Franchise", l: true, fmt: r => esc(r.franchise), sort: r => r.franchise.toLowerCase(), asc: true },
      { key: "seasons", label: "Seasons" },
      { key: "adds", label: "Adds" },
      { key: "started_pts", label: "Started pts", fmt: r => Math.round(r.started_pts).toLocaleString() },
      { key: "pts_per_add", label: "Pts/add", fmt: r => num(r.pts_per_add, 1) },
      { key: "hits", label: "Hits" },
      { key: "faab_spent", label: "FAAB", fmt: r => money(r.faab_spent) },
      { key: "pts_per_dollar", label: "Pts/$", fmt: r => num(r.pts_per_dollar, 2) },
      { key: "overpaid", label: "Overpaid", fmt: r => money(r.overpaid) },
    ], p2.all_time, { sort: "started_pts" }); };
  } else {
    document.querySelector('[data-tab="waivers"]').hidden = true;
  }

  // ---------- team picker ----------
  const picker = $("#team-picker");
  picker.innerHTML = '<option value="">All teams (no highlight)</option>' +
    franchises.map(f => `<option value="${esc(f.key)}">${esc(f.name)}</option>`).join("");
  picker.value = SEL || "";
  function renderAll() {
    renderOverview(); renderChamps(); renderAlltime();
    renderSeason(+$("#season-select").value); renderRegret(+$("#regret-select").value);
    if (p2) renderWaiverAll();
  }
  picker.addEventListener("change", () => {
    SEL = picker.value || null;
    try { SEL ? localStorage.setItem("ffdash.team", SEL) : localStorage.removeItem("ffdash.team"); } catch (e) {}
    try {
      const u = new URL(location.href);
      SEL ? u.searchParams.set("team", SEL) : u.searchParams.delete("team");
      history.replaceState(null, "", u);
    } catch (e) {}
    renderAll();
  });
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
    { key: "notes", label: "Missing data", cls: "wrapcell", fmt: c => esc((c.notes || []).join(" ")) || '<span class="na">none</span>' },
    { key: "changes", label: "League changes", cls: "wrapcell", fmt: c => esc((c.changes || []).join(" ")) },
  ], league.coverage, { sortable: false });
  $("#identity-notes").innerHTML = (p1.identity_notes || []).map(n => `<li>${esc(n)}</li>`).join("") || "<li>None.</li>";
})();
