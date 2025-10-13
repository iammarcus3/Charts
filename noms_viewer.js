
(function(){
  if (!window.grammyNoms || !window.grammyNoms.years) {
    console.error("grammyNoms not found. Load grammy_noms.js before this script.");
    return;
  }
  const years = window.grammyNoms.years;
  const yearSel = document.getElementById('year');
  const q = document.getElementById('q');
  const summaryBody = document.querySelector('#summary tbody');
  const detailBody = document.querySelector('#detail tbody');
  const kpiNumbers = document.querySelectorAll('.kpis .kpi p');

  // Populate year dropdown
  const yearKeys = Object.keys(years).sort((a,b)=>Number(a)-Number(b));
  for (const y of yearKeys) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    yearSel.appendChild(opt);
  }

  // Build detail rows
  let detailCount = 0;
  let uniqueArtists = new Set();
  for (const y of yearKeys) {
    for (const item of years[y]) {
      if (item.artist) uniqueArtists.add(item.artist);
      const tr = document.createElement('tr');
      tr.setAttribute('data-year', y);
      tr.setAttribute('data-index', [y, item.artist||'', item.category||'', item.work||''].join(' ').toLowerCase());
      tr.innerHTML = `<td>${y}</td>
                      <td>${item.artist || '—'}</td>
                      <td>${item.category || '—'}</td>
                      <td>${item.work || '—'}</td>
                      <td>${item.winner ? 'Yes' : 'No'}</td>`;
      detailBody.appendChild(tr);
      detailCount++;
    }
  }

  // Build summary: per year + artist, ignoring blank artist rows
  const byYearArtist = {};
  for (const y of yearKeys) {
    byYearArtist[y] = {};
    for (const d of years[y]) {
      const a = (d.artist || '').trim();
      if (!a) continue; // ignore empty artist
      if (!byYearArtist[y][a]) byYearArtist[y][a] = { noms:0, wins:0, cats:new Set(), wonCats:new Set() };
      byYearArtist[y][a].noms += 1;
      if (d.winner) byYearArtist[y][a].wins += 1;
      if (d.category) {
        byYearArtist[y][a].cats.add(d.category);
        if (d.winner) byYearArtist[y][a].wonCats.add(d.category);
      }
    }
  }

  for (const y of yearKeys) {
    for (const [artist, stat] of Object.entries(byYearArtist[y])) {
      const winPct = stat.noms ? Math.round((stat.wins / stat.noms) * 100) : 0;
      const tr = document.createElement('tr');
      tr.setAttribute('data-year', y);
      tr.setAttribute('data-index', [y, artist, Array.from(stat.cats).join(','), Array.from(stat.wonCats).join(',')].join(' ').toLowerCase());
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
  if (kpiNumbers && kpiNumbers.length >= 4) {
    kpiNumbers[0].textContent = uniqueArtists.size;                 // Total Artists (non-empty)
    kpiNumbers[1].textContent = detailCount;                        // Total Nominations (detail entries)
    const yrMin = yearKeys[0], yrMax = yearKeys[yearKeys.length-1];
    kpiNumbers[2].textContent = `${yrMin}–${yrMax}`;                // Years range
    kpiNumbers[3].textContent = yearKeys.length;                    // Sheets Read (count)
  }

  function applyFilters() {
    const y = yearSel.value;
    const term = (q.value || '').trim().toLowerCase();
    for (const t of [summaryBody, detailBody]) {
      for (const tr of t.querySelectorAll('tr')) {
        const yr = tr.getAttribute('data-year');
        const idx = tr.getAttribute('data-index') || '';
        const yearOk = (y === 'all') || (yr === y);
        const textOk = !term || idx.includes(term);
        tr.style.display = (yearOk && textOk) ? '' : 'none';
      }
    }
  }
  yearSel.addEventListener('change', applyFilters);
  q.addEventListener('input', applyFilters);
  applyFilters();
})();
