
/*! Artist Nominations Stats — By Year
 *  Standalone, no-build JS module.
 *  Usage:
 *    <script src="artist_nominations_stats.js"></script>
 *    <script>
 *      ArtistNomsStats.render({
 *        container: '#stats',
 *        // Option A: provide data directly as array of rows:
 *        // data: [{Year:2020, Category:'Record of the Year', Artist:'X', Work:'Y', Winner:true}, ...]
 *        // Option B: point to an .xlsx file (requires SheetJS XLSX to be loaded on the page):
 *        // xlsxUrl: 'Copy of Grammy_Nominations_ByYear_ONEFILE_no_consecutive_repeats(AutoRecovered).xlsx'
 *        // or supply a File object from <input type="file">: xlsxFile: file
 *      });
 *    </script>
 */
(function (global) {
  const NS = {};

  // ---------- Utilities ----------
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  };
  const uniq = (arr) => Array.from(new Set(arr));

  function inferBool(v) {
    if (typeof v === 'boolean') return v;
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    return s === 'yes' || s === 'y' || s === 'true' || s === '1' || s === 'win' || s === 'won' || s === 'winner';
  }

  function tryNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function detectCols(headers) {
    // Find indices in a case-insensitive manner
    const find = (patterns) => {
      const idx = headers.findIndex(h => patterns.some(p => p.test(h)));
      return idx >= 0 ? idx : null;
    };
    const H = headers.map(h => String(h || '').trim());
    const I = {
      year: find([/\byear\b/i]),
      cat: find([/\bcategory\b/i, /\bcat(egory)?\b/i]),
      nominee: find([/\bnominee\b/i, /artist\s*[—-]\s*title/i, /\bartist.*work\b/i]),
      artist: find([/\bartist\b/i]),
      title: find([/\btitle\b/i, /\bwork\b/i, /\bsong\b/i, /\balbum\b/i]),
      winner: find([/\bwinn(er|ing)\b/i, /\bwon\b/i, /\bis[_\s]*winner\b/i]),
      rank: find([/\brank\b/i, /\bposition\b/i]),
    };
    return I;
  }

  function splitNominee(s) {
    if (!s) return { artist:'', work:'' };
    const t = String(s);
    if (t.includes('—')) {
      const [a, b] = t.split('—', 1+1);
      return { artist: a.trim(), work: (b||'').trim() };
    }
    if (t.includes(' - ')) {
      const [a, b] = t.split(' - ', 1+1);
      return { artist: a.trim(), work: (b||'').trim() };
    }
    return { artist: t.trim(), work: '' };
  }

  function collapse(list) {
    const vals = [];
    for (const v of list) {
      const s = String(v || '').trim();
      if (s && !vals.includes(s)) vals.push(s);
    }
    return vals.join(', ');
  }

  // ---------- Data ingestion ----------
  async function readXlsxFromUrl(url) {
    if (!global.XLSX) throw new Error('XLSX library not found. Include SheetJS (https://cdn.jsdelivr.net/npm/xlsx) or provide JSON data.');
    const buf = await fetch(url).then(r => r.arrayBuffer());
    return parseXlsxArrayBuffer(buf);
  }
  async function readXlsxFromFile(file) {
    if (!global.XLSX) throw new Error('XLSX library not found. Include SheetJS or provide JSON data.');
    const buf = await file.arrayBuffer();
    return parseXlsxArrayBuffer(buf);
  }
  function parseXlsxArrayBuffer(buf) {
    const wb = global.XLSX.read(buf, { type: 'array' });
    const rows = [];
    for (const sn of wb.SheetNames) {
      const ws = wb.Sheets[sn];
      const arr = global.XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
      if (!arr.length) continue;
      const headers = arr[0].map(h => String(h || '').trim());
      const map = detectCols(headers);
      for (let r = 1; r < arr.length; r++) {
        const row = arr[r] || [];
        const out = {};
        out.Year = tryNumber(row[map.year]) ?? row[map.year];
        out.Category = row[map.cat] ?? '';
        if (map.nominee != null && (map.artist == null || map.title == null)) {
          const st = splitNominee(row[map.nominee]);
          out.Artist = st.artist; out.Work = st.work;
        } else {
          out.Artist = row[map.artist] ?? '';
          out.Work   = row[map.title] ?? '';
        }
        let winner = map.winner != null ? inferBool(row[map.winner]) : false;
        if (!winner && map.rank != null) {
          const rv = tryNumber(row[map.rank]);
          if (rv === 1) winner = true;
        }
        out.Winner = !!winner;
        if (String(out.Category || '').trim() && String(out.Artist || '').trim()) {
          rows.push(out);
        }
      }
    }
    return rows;
  }

  // ---------- Compute summary ----------
  function compute(groupRows) {
    // Normalize Year as integer if possible
    for (const r of groupRows) {
      const y = tryNumber(r.Year);
      r.Year = Number.isFinite(y) ? y : r.Year;
      r.Category = r.Category ?? '';
      r.Artist = r.Artist ?? '';
      r.Work = r.Work ?? '';
      r.Winner = !!r.Winner;
    }
    // Group by (Year, Artist)
    const key = (y,a) => `${y}__${a}`;
    const G = new Map();
    for (const r of groupRows) {
      const k = key(r.Year, r.Artist);
      if (!G.has(k)) G.set(k, { Year:r.Year, Artist:r.Artist, noms:0, won:0, cats:[], wonCats:[] });
      const g = G.get(k);
      g.noms += 1;
      g.cats.push(r.Category);
      if (r.Winner) {
        g.won += 1;
        g.wonCats.push(r.Category);
      }
    }
    const summary = Array.from(G.values()).map(x => ({
      Year: x.Year,
      Artist: x.Artist,
      Nominations: x.noms,
      Wins: x.won,
      WinPct: x.noms ? Math.round((x.won / x.noms) * 10000)/100 : 0,
      Nominated_Categories: collapse(x.cats),
      Won_Categories: collapse(x.wonCats)
    }));
    summary.sort((a,b)=> a.Year!==b.Year ? a.Year-b.Year
                  : (b.Wins-a.Wins) || (b.Nominations-a.Nominations) || a.Artist.localeCompare(b.Artist));
    // Detail sorted similarly
    const detail = groupRows.slice().sort((a,b)=> a.Year!==b.Year ? a.Year-b.Year
                        : a.Artist!==b.Artist ? a.Artist.localeCompare(b.Artist)
                        : a.Category.localeCompare(b.Category) || (a.Winner===b.Winner?0:(a.Winner?-1:1)));
    return { summary, detail };
  }

  // ---------- Render UI ----------
  function injectStyles(root=document) {
    if ($('#artist-noms-stats-style', root)) return;
    const css = `
      #artist-noms-stats * { box-sizing: border-box; }
      #artist-noms-stats { --bg:#0b0f1a; --card:#0f172a; --line:#1f2937; --text:#e5e7eb; --muted:#9ca3af; }
      #artist-noms-stats { color:var(--text); background:var(--bg); padding:0; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      #artist-noms-stats header { padding:16px 20px; background:var(--card); position:sticky; top:0; z-index:10; border-bottom:1px solid var(--line); }
      #artist-noms-stats h1 { margin:0; font-size:18px; letter-spacing:.2px; }
      #artist-noms-stats main { padding: 18px; }
      #artist-noms-stats .grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; margin-bottom:14px; }
      #artist-noms-stats .kpi { background:#111827; border:1px solid var(--line); border-radius:12px; padding:12px; }
      #artist-noms-stats .kpi h3 { margin:.2rem 0; font-size:12px; color:var(--muted); font-weight:500; }
      #artist-noms-stats .kpi p { margin:0; font-size:20px; font-weight:700; }
      #artist-noms-stats .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:16px; }
      #artist-noms-stats .controls { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
      #artist-noms-stats select, #artist-noms-stats input[type="search"] { background:#111827; border:1px solid var(--line); color:var(--text); padding:8px 10px; border-radius:8px; }
      #artist-noms-stats .table-wrap { overflow:auto; border-radius:12px; border:1px solid var(--line); }
      #artist-noms-stats table { width:100%; border-collapse:collapse; min-width:800px; }
      #artist-noms-stats th, #artist-noms-stats td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
      #artist-noms-stats th { position:sticky; top:0; background:#0b1220; }
      #artist-noms-stats tr:hover td { background:#0c1627; }
      #artist-noms-stats .muted { color:var(--muted); font-size:12px; }
    `;
    const style = document.createElement('style');
    style.id = 'artist-noms-stats-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function renderLayout(container, years, totals, sheetNames) {
    const yearOptions = years.map(y => `<option value="${y}">${y}</option>`).join('');
    container.innerHTML = `
      <div id="artist-noms-stats">
        <header><h1>Artist Nominations — By Year</h1></header>
        <main>
          <div class="grid">
            <div class="kpi"><h3>Total Artists</h3><p id="kpi-artists">${totals.totalArtists}</p></div>
            <div class="kpi"><h3>Total Nominations</h3><p id="kpi-noms">${totals.totalNoms}</p></div>
            <div class="kpi"><h3>Years</h3><p id="kpi-years">${years[0] ?? ''}–${years[years.length-1] ?? ''}</p></div>
            <div class="kpi"><h3>Sheets Read</h3><p id="kpi-sheets">${esc(sheetNames.join(', '))}</p></div>
          </div>
          <div class="card">
            <div class="controls">
              <label>Year:
                <select id="year">
                  <option value="all">All</option>
                  ${yearOptions}
                </select>
              </label>
              <input id="q" type="search" placeholder="Search artist…">
              <span class="muted">Winners = "Yes" in the Detail table.</span>
            </div>
            <div class="table-wrap">
              <table id="summary">
                <thead><tr><th>Year</th><th>Artist</th><th>Nominations</th><th>Wins</th><th>Win %</th><th>Nominated Categories</th><th>Won Categories</th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <h3 style="margin-top:0">Detail (Per Entry)</h3>
            <div class="table-wrap">
              <table id="detail">
                <thead><tr><th>Year</th><th>Artist</th><th>Category</th><th>Work</th><th>Winner</th></tr></thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
    `;
  }

  function paintTables(container, data) {
    const sumBody = $('#summary tbody', container);
    const detBody = $('#detail tbody', container);
    sumBody.innerHTML = data.summary.map(r => (
      `<tr data-year="${esc(r.Year)}" data-artist="${esc(r.Artist).toLowerCase()}">
        <td>${esc(r.Year)}</td>
        <td>${esc(r.Artist)}</td>
        <td>${esc(r.Nominations)}</td>
        <td>${esc(r.Wins)}</td>
        <td>${esc(r.WinPct.toFixed(2))}%</td>
        <td>${esc(r.Nominated_Categories)}</td>
        <td>${esc(r.Won_Categories)}</td>
      </tr>`
    )).join('');

    detBody.innerHTML = data.detail.map(r => (
      `<tr data-year="${esc(r.Year)}" data-artist="${esc(r.Artist).toLowerCase()}" data-winner="${r.Winner ? 'yes':'no'}">
        <td>${esc(r.Year)}</td>
        <td>${esc(r.Artist)}</td>
        <td>${esc(r.Category)}</td>
        <td>${esc(r.Work)}</td>
        <td>${r.Winner ? 'Yes' : 'No'}</td>
      </tr>`
    )).join('');
  }

  function bindFilters(container) {
    const yearSel = $('#year', container);
    const q = $('#q', container);
    function applyFilters() {
      const y = yearSel.value;
      const term = q.value.trim().toLowerCase();
      for (const t of [$('#summary tbody', container), $('#detail tbody', container)]) {
        for (const tr of $$('.table-wrap tbody tr', t.parentElement.parentElement)) {
          const yr = tr.getAttribute('data-year');
          const artist = tr.getAttribute('data-artist') || '';
          const yearOk = (y === 'all') || (String(yr) === y);
          const textOk = !term || artist.includes(term);
          tr.style.display = (yearOk && textOk) ? '' : 'none';
        }
      }
    }
    yearSel.addEventListener('change', applyFilters);
    q.addEventListener('input', applyFilters);
  }

  // ---------- Public API ----------
  NS.render = async function render(opts) {
    const {
      container: containerOpt,
      data,         // array of rows [{Year, Category, Artist, Work, Winner}, ...]
      xlsxUrl,      // URL to an Excel file (requires window.XLSX)
      xlsxFile,     // File object from <input type=file> (requires window.XLSX)
      sheetNames=[],// optional, used for display only when providing JSON
    } = opts || {};

    const container = typeof containerOpt === 'string' ? $(containerOpt) : (containerOpt || document.body);
    if (!container) throw new Error('Container not found');

    injectStyles();

    let rows;
    let sheets = sheetNames && sheetNames.length ? sheetNames.slice() : [];
    if (Array.isArray(data)) {
      rows = data.slice();
      if (!sheets.length) sheets = ['JSON'];
    } else if (xlsxFile) {
      rows = await readXlsxFromFile(xlsxFile);
      sheets = ['XLSX(File)'];
    } else if (xlsxUrl) {
      rows = await readXlsxFromUrl(xlsxUrl);
      sheets = ['XLSX(URL)'];
    } else {
      container.innerHTML = '<div style="padding:20px;color:#e5e7eb">No data provided. Pass {data:[...]}, {xlsxUrl}, or {xlsxFile} to ArtistNomsStats.render().</div>';
      return;
    }

    const years = uniq(rows.map(r => r.Year)).filter(v => v != null).sort((a,b)=>Number(a)-Number(b));
    const totals = {
      totalArtists: uniq(rows.map(r => r.Artist)).length,
      totalNoms: rows.length
    };

    renderLayout(container, years, totals, sheets);
    const computed = compute(rows);
    paintTables(container, computed);
    bindFilters(container);
  };

  global.ArtistNomsStats = NS;
})(window);
