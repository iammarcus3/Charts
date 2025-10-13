
// artist_nominations_stats.js
// Standalone ES module: reads your Excel and populates your existing page.
// Usage (in your HTML):
// <script type="module">
//   import { initArtistStats } from './artist_nominations_stats.js';
//   initArtistStats({ xlsxUrl: 'Copy of Grammy_Nominations_ByYear_ONEFILE_no_consecutive_repeats(AutoRecovered).xlsx' });
// </script>

import * as XLSX from "https://cdn.jsdelivr.net/npm/xlsx@0.19.3/+esm";

const esc = (s) => (s==null? '' : String(s)
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replaceAll('"','&quot;').replaceAll("'",'&#39;'));
const uniq = (arr) => Array.from(new Set(arr));
function inferBool(v){
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  return ['winner','win','won','yes','y','true','1'].includes(s);
}
function tryNum(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }
function detectCols(headers){
  const find = (pats)=> headers.findIndex(h => pats.some(p=>p.test(h)));
  return {
    year:   find([/\byear\b/i]),
    cat:    find([/\bcategory\b/i, /\bcat(egory)?\b/i]),
    nominee:find([/\bnominee\b/i, /artist\s*[—-]\s*title/i, /\bartist.*work\b/i]),
    artist: find([/\bartist\b/i]),
    title:  find([/\btitle\b/i, /\bwork\b/i, /\bsong\b/i, /\balbum\b/i]),
    winner: find([/\bwinn(er|ing)\b/i, /\bwon\b/i, /\bis[_\s]*winner\b/i]),
    rank:   find([/\brank\b/i, /\bposition\b/i]),
  };
}
function splitNominee(s){
  const t = String(s ?? '');
  if (t.includes('—')) { const [a,b] = t.split('—',2); return {artist:a.trim(), work:(b||'').trim()}; }
  if (t.includes(' - ')) { const [a,b] = t.split(' - ',2); return {artist:a.trim(), work:(b||'').trim()}; }
  return {artist:t.trim(), work:''};
}
function collapse(list){
  const out=[]; for(const v of list){ const s=String(v||'').trim(); if(s && !out.includes(s)) out.push(s); }
  return out.join(', ');
}

async function loadXlsx(url){
  const buf = await fetch(url).then(r=>{
    if(!r.ok) throw new Error('Failed to fetch Excel: '+r.status);
    return r.arrayBuffer();
  });
  const wb = XLSX.read(buf, { type:'array' });
  const rows = [];
  const sheets = wb.SheetNames.slice();

  for (const sn of wb.SheetNames){
    const ws = wb.Sheets[sn];
    const arr = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
    if (!arr.length) continue;
    const headers = arr[0].map(h=>String(h||'').trim());
    const map = detectCols(headers);

    for (let r=1; r<arr.length; r++){
      const row = arr[r] || [];
      const out = {};
      out.Year = tryNum(row[map.year]) ?? row[map.year];
      out.Category = row[map.cat] ?? '';
      if (map.nominee >= 0 && (map.artist < 0 || map.title < 0)) {
        const st = splitNominee(row[map.nominee]);
        out.Artist = st.artist; out.Work = st.work;
      } else {
        out.Artist = row[map.artist] ?? '';
        out.Work   = row[map.title] ?? '';
      }
      let winner = (map.winner >= 0) ? inferBool(row[map.winner]) : false;
      if (!winner && map.rank >= 0) {
        const rv = tryNum(row[map.rank]); if (rv === 1) winner = true;
      }
      out.Winner = !!winner;

      if (String(out.Category||'').trim() && String(out.Artist||'').trim()) {
        rows.push(out);
      }
    }
  }
  return { rows, sheets };
}

function compute(rows){
  rows.forEach(r=>{
    const y = tryNum(r.Year); if (y!=null) r.Year = y;
    r.Category = r.Category ?? ''; r.Artist = r.Artist ?? ''; r.Work = r.Work ?? '';
    r.Winner = !!r.Winner;
  });

  const key = (y,a)=>`${y}__${a}`;
  const map = new Map();
  for (const r of rows){
    const k = key(r.Year, r.Artist);
    if (!map.has(k)) map.set(k, { Year:r.Year, Artist:r.Artist, noms:0, won:0, cats:[], wonCats:[] });
    const g = map.get(k);
    g.noms += 1;
    g.cats.push(r.Category);
    if (r.Winner){ g.won += 1; g.wonCats.push(r.Category); }
  }
  const summary = Array.from(map.values()).map(x=>({
    Year: x.Year,
    Artist: x.Artist,
    Nominations: x.noms,
    Wins: x.won,
    WinPct: x.noms ? Math.round((x.won/x.noms)*10000)/100 : 0,
    Nominated_Categories: collapse(x.cats),
    Won_Categories: collapse(x.wonCats),
  })).sort((a,b)=> a.Year!==b.Year ? a.Year-b.Year
                : (b.Wins-a.Wins) || (b.Nominations-a.Nominations) || a.Artist.localeCompare(b.Artist));

  const detail = rows.slice().sort((a,b)=>
    a.Year!==b.Year ? a.Year-b.Year
    : a.Artist!==b.Artist ? a.Artist.localeCompare(b.Artist)
    : a.Category.localeCompare(b.Category) || ((a.Winner===b.Winner)?0:(a.Winner?-1:1))
  );

  return { summary, detail };
}

function paintKpis({rows, years, sheets}){
  const kpis = document.querySelectorAll('.kpi p');
  if (kpis[0]) kpis[0].textContent = uniq(rows.map(r=>r.Artist)).length;
  if (kpis[1]) kpis[1].textContent = rows.length;
  if (kpis[2]) kpis[2].textContent = years.length ? `${years[0]}–${years[years.length-1]}` : '–';
  if (kpis[3]) kpis[3].textContent = sheets && sheets.length ? sheets.join(', ') : '—';
}

function paintYearDropdown(years){
  const sel = document.getElementById('year');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All</option>' + years.map(y=>`<option value="${y}">${y}</option>`).join('');
}

function paintTables({summary, detail}){
  const sumBody = document.querySelector('#summary tbody');
  const detBody = document.querySelector('#detail tbody');
  if (!sumBody || !detBody) return;

  sumBody.innerHTML = summary.map(r => (
    `<tr data-year="${esc(r.Year)}" data-artist="${esc(r.Artist).toLowerCase()}">
      <td>${esc(r.Year)}</td>
      <td>${esc(r.Artist)}</td>
      <td>${esc(r.Nominations)}</td>
      <td>${esc(r.Wins)}</td>
      <td>${r.WinPct.toFixed(2)}%</td>
      <td>${esc(r.Nominated_Categories)}</td>
      <td>${esc(r.Won_Categories)}</td>
    </tr>`
  )).join('');

  detBody.innerHTML = detail.map(r => (
    `<tr data-year="${esc(r.Year)}" data-artist="${esc(r.Artist).toLowerCase()}" data-winner="${r.Winner ? 'yes':'no'}">
      <td>${esc(r.Year)}</td>
      <td>${esc(r.Artist)}</td>
      <td>${esc(r.Category)}</td>
      <td>${esc(r.Work)}</td>
      <td>${r.Winner ? 'Yes':'No'}</td>
    </tr>`
  )).join('');
}

function bindFilters(){
  const yearSel = document.getElementById('year');
  const q = document.getElementById('q');
  if (!yearSel || !q) return;

  function applyFilters() {
    const y = yearSel.value;
    const term = q.value.trim().toLowerCase();
    for (const t of [document.querySelector('#summary tbody'), document.querySelector('#detail tbody')]) {
      for (const tr of t.querySelectorAll('tr')) {
        const yr = tr.getAttribute('data-year');
        const artist = tr.getAttribute('data-artist') || '';
        const yearOk = (y === 'all') || (yr === y);
        const textOk = !term || artist.includes(term);
        tr.style.display = (yearOk && textOk) ? '' : 'none';
      }
    }
  }
  yearSel.addEventListener('change', applyFilters);
  q.addEventListener('input', applyFilters);
  setTimeout(applyFilters, 0);
}

export async function initArtistStats({ xlsxUrl }) {
  if (!xlsxUrl) throw new Error('initArtistStats: xlsxUrl is required');
  const { rows, sheets } = await loadXlsx(xlsxUrl);
  const years = uniq(rows.map(r=>r.Year)).filter(v=>v!=null).sort((a,b)=>a-b);
  paintKpis({rows, years, sheets});
  paintYearDropdown(years);
  const data = compute(rows);
  paintTables(data);
  bindFilters();
}
