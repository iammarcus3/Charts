/* Record Label Intelligence – full, production-ready front-end
 * - Uses weekData (weekly) + labelPricing (per year)
 * - Optional artistsExtra & albumsData if you provide data.js
 * - Deterministic label assignment for unknown artists
 * - Budgets estimated & blended; artists-in-red highlighted; top-50 per label
 */

(() => {
  // ---------- Utilities ----------
  const START = new Date("2018-02-23"); // Week 1 Friday
  const WEEK = 7 * 24 * 3600 * 1000;

  const fmt = (n, d = 0) =>
    n == null || isNaN(n) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  const money = (n, d = 0) =>
    n == null || isNaN(n) ? "—" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

  const hash32 = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0);
  };

  // Gather available label universe from pricing; fallback list if missing.
  const KNOWN_LABELS = Object.keys(window.labelPricing || {});
  const FALLBACK_LABELS = ["Universal Music", "Sony Music", "Warner Music", "EMPIRE", "Def Jam", "Columbia Records"];

  const pickDeterministicLabel = (artist) => {
    const pool = KNOWN_LABELS.length ? KNOWN_LABELS : FALLBACK_LABELS;
    const idx = hash32(artist) % pool.length;
    return pool[idx];
  };

  // Budget estimator (blended; no marker)
  function estimateBudgetUSD(units) {
    let total;
    if (units >= 100_000_000) total = randRange(20e6, 50e6);
    else if (units >= 10_000_000) total = randRange(5e6, 20e6);
    else total = randRange(0.5e6, 5e6);
    const prod = total * 0.30 * jitter();
    const tour = total * 0.25 * jitter();
    const mkt  = total * 0.20 * jitter();
    const vid  = total * 0.15 * jitter();
    const mer  = total * 0.10 * jitter();
    return { total, prod, tour, mkt, vid, mer };
  }
  const randRange = (a, b) => a + Math.random() * (b - a);
  const jitter = () => 0.9 + 0.2 * Math.random();

  // ---------- 1) Build yearly from weekly ----------
  // weekData: { "1": [ { artist, title, album, sales, totalSales, plays, ... } ], "2": [...], ... }
  const yearlyByArtist = {};  // { artist: { [year]: { sales, plays } }, overall: {sales, plays} }
  const weeklyByArtist = {};  // { artist: [ {week, sales, plays} ] }
  const yearsSet = new Set();

  for (const wkStr in weekData) {
    const w = Number(wkStr);
    const dt = new Date(START.getTime() + (w - 1) * WEEK);
    const year = String(dt.getFullYear());
    yearsSet.add(year);

    for (const row of weekData[wkStr]) {
      const a = row.artist;
      if (!a) continue;
      const sales = Number(row.sales ?? row.totalSales ?? 0);
      const plays = Number(row.plays ?? 0);

      yearlyByArtist[a] = yearlyByArtist[a] || {};
      yearlyByArtist[a][year] = yearlyByArtist[a][year] || { sales: 0, plays: 0 };
      yearlyByArtist[a][year].sales += sales;
      yearlyByArtist[a][year].plays += plays;

      weeklyByArtist[a] = weeklyByArtist[a] || [];
      weeklyByArtist[a].push({ week: w, sales, plays });
    }
  }
  const YEARS = Array.from(yearsSet).sort();

  // ---------- 2) Build artist index (labels, totals, finances) ----------
  const artists = {}; // { artist: { artist, label, yearly, overall, debtUSD, finalUSD } }
  for (const artist of Object.keys(yearlyByArtist)) {
    const fromExtras = (window.artistsExtra || {})[artist] || {};
    const label = fromExtras.label || pickDeterministicLabel(artist);

    // totals
    let sTot = 0, pTot = 0;
    for (const y in yearlyByArtist[artist]) {
      sTot += yearlyByArtist[artist][y].sales;
      pTot += yearlyByArtist[artist][y].plays;
    }

    // finances
    const debtUSD = Number(fromExtras.debtUSD || 0);
    const finalUSD = Number(fromExtras.finalUSD ?? (sTot + pTot - debtUSD));

    // per-year budgets (scaled by that year units)
    const budgets = {};
    for (const y in yearlyByArtist[artist]) {
      const units = yearlyByArtist[artist][y].sales + yearlyByArtist[artist][y].plays;
      const est = estimateBudgetUSD(units);
      budgets[y] = est.total;
    }

    artists[artist] = {
      artist,
      label,
      yearly: yearlyByArtist[artist],
      weekly: weeklyByArtist[artist]?.sort((a,b)=>a.week-b.week) || [],
      overall: { sales: sTot, plays: pTot },
      debtUSD, finalUSD,
      budgetsYearlyUSD: budgets
    };
  }

  // ---------- 3) Build label → yearly aggregates & expected revenue ----------
  const labelAgg = {}; // { label: { yearly: {year:{sales,plays,expectedUSD,budgetUSD,debtUSD}}, overall:{...} } }
  for (const name in artists) {
    const a = artists[name];
    const L = a.label;
    labelAgg[L] = labelAgg[L] || { yearly: {}, overall: { sales: 0, plays: 0, expectedUSD: 0, budgetUSD: 0, debtUSD: 0 } };

    for (const y in a.yearly) {
      const yr = labelAgg[L].yearly[y] || { sales: 0, plays: 0, expectedUSD: 0, budgetUSD: 0, debtUSD: 0 };
      yr.sales += a.yearly[y].sales;
      yr.plays += a.yearly[y].plays;

      // pricing → expected revenue (combined: sales + plays)
      const pricing = (window.labelPricing?.[L]?.[Number(y)]) || {};
      const expectedUSD = (pricing.salePerRecord || 0) * a.yearly[y].sales +
                          (pricing.salePerPlay   || 0) * a.yearly[y].plays;
      yr.expectedUSD += expectedUSD;

      // debt allocation proportional to units share (avoid div-by-0)
      const artistUnits = a.overall.sales + a.overall.plays || 1;
      const yrUnits = a.yearly[y].sales + a.yearly[y].plays;
      yr.debtUSD += a.debtUSD * (yrUnits / artistUnits);

      // budget (blended)
      yr.budgetUSD += Number(a.budgetsYearlyUSD[y] || 0);

      labelAgg[L].yearly[y] = yr;
    }
  }

  // compute overall per label
  for (const L in labelAgg) {
    for (const y of YEARS) {
      const r = labelAgg[L].yearly[y] || { sales:0, plays:0, expectedUSD:0, budgetUSD:0, debtUSD:0 };
      labelAgg[L].overall.sales      += r.sales;
      labelAgg[L].overall.plays      += r.plays;
      labelAgg[L].overall.expectedUSD+= r.expectedUSD;
      labelAgg[L].overall.budgetUSD  += r.budgetUSD;
      labelAgg[L].overall.debtUSD    += r.debtUSD;
    }
  }

  // ---------- 4) Albums (optional) ----------
  const albumsByLabel = {};
  (window.albumsData || []).forEach(alb => {
    const L = alb.label || pickDeterministicLabel(alb.artist || "");
    albumsByLabel[L] = albumsByLabel[L] || [];
    const budgetUSD = (Number(alb.totalBudgetM || alb.totalBudget || 0)) * 1_000_000;
    albumsByLabel[L].push({
      album: alb.album, artist: alb.artist, sales: Number(alb.sales||0), plays: Number(alb.plays||0),
      budgetUSD
    });
  });

  // ---------- 5) UI boot ----------
  const els = {
    tabs: [...document.querySelectorAll(".tab-btn")],
    panels: {
      labels: document.getElementById("panel-labels"),
      artists: document.getElementById("panel-artists"),
      albums: document.getElementById("panel-albums"),
      pricing: document.getElementById("panel-pricing"),
    },
    kpi: {
      sales: document.getElementById("kpiSales"),
      plays: document.getElementById("kpiPlays"),
      debt: document.getElementById("kpiDebt"),
      counts: document.getElementById("kpiCounts"),
    },
    search: document.getElementById("searchInput"),
    yearSelect: document.getElementById("yearSelect")
  };

  // Populate year filter
  YEARS.forEach(y => {
    const opt = document.createElement("option");
    opt.value = y; opt.textContent = y;
    els.yearSelect.appendChild(opt);
  });

  // KPIs
  const totalSales = Object.values(labelAgg).reduce((a,L)=>a+L.overall.sales,0);
  const totalPlays = Object.values(labelAgg).reduce((a,L)=>a+L.overall.plays,0);
  const totalDebt  = Object.values(labelAgg).reduce((a,L)=>a+L.overall.debtUSD,0);
  els.kpi.sales.textContent = fmt(totalSales);
  els.kpi.plays.textContent = fmt(totalPlays);
  els.kpi.debt.textContent  = money(totalDebt);
  els.kpi.counts.textContent = `${Object.keys(labelAgg).length} • ${Object.keys(artists).length}`;

  // Tabs
  els.tabs.forEach(t => t.addEventListener("click", () => {
    els.tabs.forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    const key = t.dataset.tab;
    for (const p in els.panels) els.panels[p].classList.toggle("hidden", p !== key);
    if (key === "labels") renderLabels();
    if (key === "artists") renderArtists();
    if (key === "albums") renderAlbums();
    if (key === "pricing") renderPricing();
  }));

  // Filters
  els.search.addEventListener("input", () => {
    if (!document.querySelector('.tab-btn.active')?.dataset.tab) return;
    const tab = document.querySelector('.tab-btn.active').dataset.tab;
    if (tab === "labels") renderLabels();
    if (tab === "artists") renderArtists();
  });
  els.yearSelect.addEventListener("change", () => renderLabels());

  // ---------- Renders ----------
  function renderLabels() {
    const q = (els.search.value || "").toLowerCase();
    const year = els.yearSelect.value;
    const wrap = els.panels.labels;
    wrap.innerHTML = "";

    const labels = Object.keys(labelAgg).filter(L => L.toLowerCase().includes(q))
      .sort((a,b)=> (labelAgg[b].overall.expectedUSD - labelAgg[a].overall.expectedUSD));

    labels.forEach(L => {
      const card = document.createElement("div");
      card.className = "glass rounded-2xl p-4";

      // Inline yearly (last up to 4 years)
      const yrs = (year ? [year] : YEARS).slice(-4);
      const inlineRows = yrs.map(y => {
        const r = labelAgg[L].yearly[y] || {sales:0,plays:0,expectedUSD:0};
        return `<tr>
          <td class="text-slate-400">${y}</td>
          <td>${fmt(r.sales)}</td>
          <td>${fmt(r.plays)}</td>
          <td>${money(r.expectedUSD)}</td>
        </tr>`;
      }).join("");

      card.innerHTML = `
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-lg font-semibold">
            <a href="#" data-open-label="${L}" class="hover:underline">${L}</a>
          </h3>
          <span class="pill">Artists: ${Object.values(artists).filter(a=>a.label===L).length}</span>
        </div>
        <div class="mt-2 grid grid-cols-4 gap-2 text-sm">
          <div><div class="text-slate-400">Sales</div><div class="font-semibold">${fmt(labelAgg[L].overall.sales)}</div></div>
          <div><div class="text-slate-400">Plays</div><div class="font-semibold">${fmt(labelAgg[L].overall.plays)}</div></div>
          <div><div class="text-slate-400">Expected</div><div class="font-semibold">${money(labelAgg[L].overall.expectedUSD)}</div></div>
          <div><div class="text-slate-400">Debt</div><div class="font-semibold">${money(labelAgg[L].overall.debtUSD)}</div></div>
        </div>
        <div class="mt-3 overflow-auto">
          <table class="tbl text-sm min-w-[540px]">
            <thead><tr><th>Year</th><th>Sales</th><th>Plays</th><th>Expected Rev</th></tr></thead>
            <tbody>${inlineRows}</tbody>
          </table>
        </div>
        <div class="mt-3 flex justify-end">
          <button class="pill" data-open-label="${L}">Open details</button>
        </div>
      `;
      wrap.appendChild(card);
    });

    wrap.querySelectorAll("[data-open-label]").forEach(btn => {
      btn.addEventListener("click", (e) => { e.preventDefault(); openLabelModal(btn.dataset.openLabel); });
    });
  }

  function renderArtists() {
    const q = (els.search.value || "").toLowerCase();
    const tbody = document.querySelector("#panel-artists tbody");
    tbody.innerHTML = "";

    Object.values(artists)
      .filter(a => a.artist.toLowerCase().includes(q) || a.label.toLowerCase().includes(q))
      .sort((a,b) => (b.overall.sales + b.overall.plays) - (a.overall.sales + a.overall.plays))
      .forEach(a => {
        const neg = a.finalUSD < 0 ? "neg" : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><a href="#" class="artist-link ${neg}" data-artist="${a.artist}">${a.artist}</a></td>
          <td>${a.label}</td>
          <td>${fmt(a.overall.sales)}</td>
          <td>${fmt(a.overall.plays)}</td>
          <td>${money(a.debtUSD)}</td>
          <td class="${neg}">${money(a.finalUSD)}</td>
        `;
        tbody.appendChild(tr);
      });

    tbody.querySelectorAll(".artist-link").forEach(l => {
      l.addEventListener("click", (e) => { e.preventDefault(); openArtistModal(l.dataset.artist); });
    });
  }

  function renderAlbums() {
    const tbody = document.querySelector("#panel-albums tbody");
    tbody.innerHTML = "";
    (window.albumsData || [])
      .sort((a,b)=> (Number(b.points||0)) - (Number(a.points||0)))
      .forEach((alb, i) => {
        const budgetUSD = (Number(alb.totalBudgetM || alb.totalBudget || 0)) * 1_000_000;
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${alb.album || "—"}</td>
          <td><a href="#" class="artist-link" data-artist="${alb.artist || ""}">${alb.artist || "—"}</a></td>
          <td>${alb.label || "—"}</td>
          <td>${fmt(alb.sales)}</td>
          <td>${fmt(alb.plays)}</td>
          <td>${money(budgetUSD)}</td>
        `;
        tbody.appendChild(tr);
      });
    tbody.querySelectorAll(".artist-link").forEach(l => {
      l.addEventListener("click", (e) => { e.preventDefault(); openArtistModal(l.dataset.artist); });
    });
  }

  function renderPricing() {
    const wrap = document.getElementById("pricingWrap");
    wrap.innerHTML = "";
    const labels = Object.keys(window.labelPricing || {}).sort();
    labels.forEach(L => {
      const years = Object.keys(labelPricing[L]).map(Number).sort((a,b)=>b-a);
      const rows = years.map(y => {
        const p = labelPricing[L][y];
        const r = labelAgg[L]?.yearly?.[y] || { sales:0, plays:0, expectedUSD:0 };
        return `<tr>
          <td class="text-slate-400">${y}</td>
          <td>${p.salePerRecord ?? "—"}</td>
          <td>${p.salePerPlay ?? "—"}</td>
          <td>${p.artistSplit ?? p.pctArtist ?? "—"}</td>
          <td>${p.labelSplit ?? p.pctLabel ?? "—"}</td>
          <td>${fmt(r.sales)}</td>
          <td>${fmt(r.plays)}</td>
          <td>${money(r.expectedUSD)}</td>
        </tr>`;
      }).join("");
      const card = document.createElement("div");
      card.className = "glass rounded-2xl p-4";
      card.innerHTML = `
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-semibold">${L}</h3>
          <button class="pill" data-open-label="${L}">Open label</button>
        </div>
        <div class="mt-3 overflow-auto">
          <table class="tbl text-sm min-w-[780px]">
            <thead><tr>
              <th>Year</th><th>Sale/Record</th><th>Sale/Play</th><th>% Artist</th><th>% Label</th>
              <th>Sales</th><th>Plays</th><th>Expected Rev</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
      wrap.appendChild(card);
      card.querySelector("[data-open-label]").addEventListener("click", (e)=>{ e.preventDefault(); openLabelModal(L); });
    });
  }

  // ---------- Label Modal ----------
  let stackedChart;
  function openLabelModal(L) {
    const modal = document.getElementById("labelModal");
    document.getElementById("labelTitle").textContent = L;
    modal.classList.add("show");

    // subtab switching
    const btns = [...modal.querySelectorAll(".subtabs button")];
    const panels = {
      overview: document.getElementById("mtab-overview"),
      artists:  document.getElementById("mtab-artists"),
      albums:   document.getElementById("mtab-albums"),
      pricing:  document.getElementById("mtab-pricing"),
    };
    btns.forEach(b => b.onclick = () => {
      btns.forEach(x => x.classList.remove("active")); b.classList.add("active");
      for (const k in panels) panels[k].classList.toggle("hidden", k !== b.dataset.mtab);
    });

    // Overview (stacked per year)
    const years = YEARS;
    const series = years.map(y => labelAgg[L]?.yearly?.[y]?.expectedUSD || 0);
    const debt   = years.map(y => labelAgg[L]?.yearly?.[y]?.debtUSD || 0);
    const budget = years.map(y => labelAgg[L]?.yearly?.[y]?.budgetUSD || 0);

    const ctx = document.getElementById("labelStacked").getContext("2d");
    if (stackedChart) stackedChart.destroy();
    stackedChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: years,
        datasets: [
          { label: "Expected Revenue", data: series, stack: "x" },
          { label: "Budget", data: budget, stack: "x" },
          { label: "Debt", data: debt, stack: "x" }
        ]
      },
      options: { plugins:{legend:{position:"bottom"}}, responsive:true, scales:{ x:{stacked:true}, y:{stacked:true} } }
    });

    // Yearly table
    const rows = years.map(y => {
      const r = labelAgg[L]?.yearly?.[y] || { sales:0, plays:0, expectedUSD:0, budgetUSD:0, debtUSD:0 };
      return `<tr>
        <td class="text-slate-400">${y}</td>
        <td>${fmt(r.sales)}</td><td>${fmt(r.plays)}</td>
        <td>${money(r.expectedUSD)}</td><td>${money(r.budgetUSD)}</td><td>${money(r.debtUSD)}</td>
      </tr>`;
    }).join("");
    document.getElementById("labelYearTable").innerHTML = `
      <div class="overflow-auto">
        <table class="tbl text-sm min-w-[760px]">
          <thead><tr><th>Year</th><th>Sales</th><th>Plays</th><th>Expected Rev</th><th>Budget</th><th>Debt</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <th>Total</th>
            <th>${fmt(labelAgg[L].overall.sales)}</th>
            <th>${fmt(labelAgg[L].overall.plays)}</th>
            <th>${money(labelAgg[L].overall.expectedUSD)}</th>
            <th>${money(labelAgg[L].overall.budgetUSD)}</th>
            <th>${money(labelAgg[L].overall.debtUSD)}</th>
          </tr></tfoot>
        </table>
      </div>
    `;

    // Artists tab (top 50, red if negative)
    const list = Object.values(artists).filter(a => a.label === L)
      .sort((a,b)=> (b.overall.sales + b.overall.plays) - (a.overall.sales + a.overall.plays));
    const limit = 50;
    renderLabelArtists(list.slice(0, limit));
    let shown = limit;
    document.getElementById("loadMoreArtists").onclick = () => {
      const next = list.slice(shown, shown + limit);
      if (!next.length) return;
      appendLabelArtists(next);
      shown += limit;
    };

    // Albums tab (if supplied)
    const albRows = ( (window.albumsData || []).filter(a => (a.label || pickDeterministicLabel(a.artist||"")) === L) )
      .slice(0, 200) // cap for performance
      .map((a, i) => {
        const budgetUSD = (Number(a.totalBudgetM || a.totalBudget || 0)) * 1_000_000;
        return `<tr><td>${i+1}</td><td>${a.album||"—"}</td><td>${a.artist||"—"}</td><td>${fmt(a.sales)}</td><td>${fmt(a.plays)}</td><td>${money(budgetUSD)}</td></tr>`;
      }).join("");
    document.getElementById("labelAlbumsTbl").querySelector("tbody").innerHTML = albRows || `<tr><td colspan="6" class="text-slate-400">No albums supplied.</td></tr>`;

    // Pricing tab
    const p = window.labelPricing?.[L] || {};
    const pYears = Object.keys(p).map(Number).sort((a,b)=>b-a);
    const pRows = pYears.map(y=>{
      const yr = labelAgg[L]?.yearly?.[y] || { sales:0, plays:0, expectedUSD:0 };
      const row = p[y];
      return `<tr>
        <td class="text-slate-400">${y}</td>
        <td>${row.salePerRecord ?? "—"}</td>
        <td>${row.salePerPlay ?? "—"}</td>
        <td>${row.artistSplit ?? row.pctArtist ?? "—"}</td>
        <td>${row.labelSplit ?? row.pctLabel ?? "—"}</td>
        <td>${fmt(yr.sales)}</td>
        <td>${fmt(yr.plays)}</td>
        <td>${money(yr.expectedUSD)}</td>
      </tr>`;
    }).join("");
    document.getElementById("labelPricingTbl").innerHTML = `
      <div class="overflow-auto">
        <table class="tbl text-sm min-w-[800px]">
          <thead><tr>
            <th>Year</th><th>Sale/Record</th><th>Sale/Play</th><th>% Artist</th><th>% Label</th>
            <th>Sales</th><th>Plays</th><th>Expected Rev (Combined)</th>
          </tr></thead>
          <tbody>${pRows}</tbody>
        </table>
      </div>
    `;
  }

  function renderLabelArtists(list) {
    const tbody = document.querySelector("#labelArtistsTbl tbody");
    tbody.innerHTML = "";
    appendLabelArtists(list);
  }
  function appendLabelArtists(items) {
    const tbody = document.querySelector("#labelArtistsTbl tbody");
    const start = tbody.children.length;
    items.forEach((a, i) => {
      const neg = a.finalUSD < 0 ? "neg" : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${start + i + 1}</td>
        <td><a href="#" class="artist-link ${neg}" data-artist="${a.artist}">${a.artist}</a></td>
        <td>${fmt(a.overall.sales)}</td>
        <td>${fmt(a.overall.plays)}</td>
        <td>${money(a.debtUSD)}</td>
        <td class="${neg}">${money(a.finalUSD)}</td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".artist-link").forEach(l => {
      l.addEventListener("click",(e)=>{ e.preventDefault(); openArtistModal(l.dataset.artist); });
    });
  }

  // ---------- Artist Modal ----------
  let weeklyChart, yearlyChart;
  function openArtistModal(name) {
    const a = artists[name]; if (!a) return;
    const modal = document.getElementById("artistModal");
    modal.classList.add("show");
    document.getElementById("artistTitle").textContent = name;

    // weekly line
    const ctx1 = document.getElementById("artistWeekly").getContext("2d");
    if (weeklyChart) weeklyChart.destroy();
    weeklyChart = new Chart(ctx1, {
      type: "line",
      data: {
        labels: a.weekly.map(x => "W"+x.week),
        datasets: [
          { label: "Sales", data: a.weekly.map(x=>x.sales) },
          { label: "Plays", data: a.weekly.map(x=>x.plays) }
        ]
      },
      options:{plugins:{legend:{position:"bottom"}}}
    });

    // yearly bar
    const years = Object.keys(a.yearly).sort();
    const ctx2 = document.getElementById("artistYearly").getContext("2d");
    if (yearlyChart) yearlyChart.destroy();
    yearlyChart = new Chart(ctx2, {
      type: "bar",
      data: {
        labels: years,
        datasets: [
          { label: "Sales", data: years.map(y=>a.yearly[y].sales) },
          { label: "Plays", data: years.map(y=>a.yearly[y].plays) }
        ]
      },
      options:{plugins:{legend:{position:"bottom"}}}
    });

    // meta
    const neg = a.finalUSD < 0 ? 'class="neg"' : "";
    document.getElementById("artistMeta").innerHTML = `
      <div><span class="text-slate-400">Label:</span> ${a.label}</div>
      <div><span class="text-slate-400">Totals:</span> Sales ${fmt(a.overall.sales)}, Plays ${fmt(a.overall.plays)}</div>
      <div><span class="text-slate-400">Debt:</span> ${money(a.debtUSD)} • <span class="text-slate-400">Final:</span> <span ${neg}>${money(a.finalUSD)}</span></div>
    `;

    // albums list if supplied
    const albums = (window.albumsData || []).filter(x => (x.artist || "") === name);
    document.getElementById("artistAlbums").innerHTML = albums.length
      ? `<div class="mt-2 overflow-auto">
           <table class="tbl text-sm min-w-[720px]">
             <thead><tr><th>Album</th><th>Label</th><th>Sales</th><th>Plays</th><th>Budget</th></tr></thead>
             <tbody>
               ${albums.map(alb => `<tr>
                 <td>${alb.album||"—"}</td>
                 <td>${alb.label||"—"}</td>
                 <td>${fmt(alb.sales)}</td>
                 <td>${fmt(alb.plays)}</td>
                 <td>${money((Number(alb.totalBudgetM||alb.totalBudget||0))*1_000_000)}</td>
               </tr>`).join("")}
             </tbody>
           </table>
         </div>`
      : `<div class="text-slate-400 text-sm">No albums on file.</div>`;
  }

  // Close modals
  document.getElementById("closeLabelModal").addEventListener("click", () => {
    document.getElementById("labelModal").classList.remove("show");
    if (stackedChart) stackedChart.destroy();
  });
  document.getElementById("closeArtistModal").addEventListener("click", () => {
    document.getElementById("artistModal").classList.remove("show");
    if (weeklyChart) weeklyChart.destroy();
    if (yearlyChart)  yearlyChart.destroy();
  });

  // initial paint
  renderLabels();
})();
