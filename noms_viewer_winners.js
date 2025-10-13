
(function(){
  if (!window.grammyNoms || !window.grammyNoms.years) {
    console.error("grammyNoms not found. Load grammy_noms.winners.js before this script.");
    const statusEl = document.getElementById('datasetStatus');
    if (statusEl) statusEl.textContent = "Dataset not found. Load grammy_noms.winners.js first.";
    return;
  }
  const years = window.grammyNoms.years;
  const yearSel = document.getElementById('year');
  const q = document.getElementById('q');
  const summaryBody = document.querySelector('#summary tbody');
  const detailBody = document.querySelector('#detail tbody');
  const kpiArtists = document.getElementById('kpiArtists');
  const kpiNoms = document.getElementById('kpiNoms');
  const kpiYears = document.getElementById('kpiYears');
  const kpiSheets = document.getElementById('kpiSheets');
  const footnote = document.getElementById('footnote');
  const metaSpan = document.getElementById('metaSpan');
  const statusEl = document.getElementById('datasetStatus');

  const yearKeys = Object.keys(years).sort((a,b)=>Number(a)-Number(b));
  if (statusEl) statusEl.textContent = "Loaded " + yearKeys.length + " years";
  if (metaSpan && window.grammyNoms.meta && window.grammyNoms.meta.generated_utc) {
    metaSpan.textContent = "Generated: " + window.grammyNoms.meta.generated_utc;
  }

  // Populate year dropdown
  for (const y of yearKeys) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    yearSel.appendChild(opt);
  }

  // Build detail rows (every nomination row)
  let detailCount = 0;
  const uniqueArtists = new Set();
  for (const y of yearKeys) {
    for (const item of years[y]) {
      if (item.artist) uniqueArtists.add(item.artist);
      const tr = document.createElement('tr');
      tr.dataset.year = y;
      tr.dataset.index = [y, item.artist||'', item.category||'', item.work||''].join(' ').toLowerCase();
      tr.innerHTML = `<td>${y}</td>
                      <td>${item.artist || ''}</td>
                      <td>${item.category || ''}</td>
                      <td>${item.work || ''}</td>
                      <td>${item.winner ? 'Yes' : 'No'}</td>`;
      detailBody.appendChild(tr);
      detailCount++;
    }
  }

  // Summary per year × artist (ignore empty artist)
  const byYearArtist = {};
  for (const y of yearKeys) {
    const rows = years[y] || [];
    for (const d of rows) {
      const a = (d.artist || '').trim();
      if (!a) continue;
      if (!byYearArtist[y]) byYearArtist[y] = {};
      if (!byYearArtist[y][a]) byYearArtist[y][a] = { noms:0, wins:0, cats:new Set(), wonCats:new Set() };
      byYearArtist[y][a].noms++;
      if (d.winner) byYearArtist[y][a].wins++;
      if (d.category) byYearArtist[y][a].cats.add(d.category);
      if (d.winner && d.category) byYearArtist[y][a].wonCats.add(d.category);
    }
  }

  for (const y of yearKeys) {
    const map = byYearArtist[y] || {};
    for (const [artist, stat] of Object.entries(map)) {
      const winPct = stat.noms ? Math.round((stat.wins / stat.noms) * 100) : 0;
      const tr = document.createElement('tr');
      tr.dataset.year = y;
      tr.dataset.index = [y, artist, Array.from(stat.cats).join(','), Array.from(stat.wonCats).join(',')].join(' ').toLowerCase();
      tr.innerHTML = `<td>${y}</td>
                      <td>${artist}</td>
                      <td>${stat.noms}</td>
                      <td>${stat.wins}</td>
                      <td>${winPct}%</td>
                      <td>${Array.from(stat.cats).join(', ')}</td>
                      <td>${Array.from(stat.wonCats).join(', ')}</td>`;
      summaryBody.appendChild(tr);
    }
  }

  // KPIs
  if (kpiArtists) kpiArtists.textContent = uniqueArtists.size;
  if (kpiNoms) kpiNoms.textContent = detailCount;
  if (kpiYears) kpiYears.textContent = yearKeys[0] + "–" + yearKeys[yearKeys.length-1];
  if (kpiSheets) {
    const meta = window.grammyNoms.meta || {};
    kpiSheets.textContent = meta.sheets ? meta.sheets.length : yearKeys.length;
  }
  if (footnote) {
    const meta = window.grammyNoms.meta || {};
    footnote.textContent = "Source: " + (meta.source_file || "JS data") + (meta.notes ? " — " + meta.notes : "");
  }

  function applyFilters(){
    const y = yearSel.value;
    const term = (q.value || "").trim().toLowerCase();
    for (const t of [summaryBody, detailBody]) {
      for (const tr of t.querySelectorAll('tr')) {
        const yearOK = (y === 'all') || (tr.dataset.year === y);
        const indexOK = !term || (tr.dataset.index || '').includes(term);
        tr.style.display = (yearOK && indexOK) ? '' : 'none';
      }
    }
  }
  yearSel.addEventListener('change', applyFilters);
  q.addEventListener('input', applyFilters);
  applyFilters();
})();
