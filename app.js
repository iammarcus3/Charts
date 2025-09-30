// Record Label Intelligence App
// Expects: artistsData, albumsData, labelsSummary, albumDebtBreakdown, labelPricing, weekData

const START_DATE = new Date('2018-02-23'); // Week 1 Friday

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  fillGlobal();
  fillFilters();
  renderLabelsGrid();
  renderArtistsTable();
  renderAlbumsTable();
  renderPricing();
  setupSearch();
  setupModal();
});

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const target = t.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + target).classList.add('active');
  }));
}

function fnum(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function money(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fillGlobal() {
  const totalRevenue = Object.values(artistsData).reduce((a,x)=> a + (x.totalRevenueUSD||0), 0);
  const totalDebt = Object.values(artistsData).reduce((a,x)=> a + (x.debtUSD||0), 0);
  const labelsCount = Object.keys(labelsSummary).length;
  const artistsCount = Object.keys(artistsData).length;

  document.getElementById('totalRevenue').textContent = money(totalRevenue);
  document.getElementById('totalDebt').textContent = money(totalDebt);
  document.getElementById('labelsCount').textContent = fnum(labelsCount);
  document.getElementById('artistsCount').textContent = fnum(artistsCount);
}

function fillFilters() {
  const select = document.getElementById('labelFilter');
  select.innerHTML = '<option value="">All Labels</option>' + Object.keys(labelsSummary).map(l => `<option value="${l}">${l}</option>`).join('');
  select.addEventListener('change', renderArtistsTable);
}

function renderLabelsGrid() {
  const wrap = document.getElementById('labelsGrid');
  wrap.innerHTML = Object.values(labelsSummary)
    .sort((a,b)=> (b.totalRevenueUSD||0) - (a.totalRevenueUSD||0))
    .map(label => {
      const debtBadge = label.unrecoupedUSD > 0 ? `<span class="badge red">Unrecouped ${money(label.unrecoupedUSD)}</span>` : '<span class="badge green">Fully recouped</span>';
      const topAlbums = (label.topAlbums||[]).slice(0,5).map(a => `<li>${a.album} <span class="small">(${a.artist})</span></li>`).join('');
      return `<div class="label-card">
        <h3>${label.label}</h3>
        <div class="label-stats">
          <div><span class="small">Artists</span><br><strong>${fnum(label.artistsCount)}</strong></div>
          <div><span class="small">Albums</span><br><strong>${fnum(label.albumsCount)}</strong></div>
          <div><span class="small">Top Artist</span><br><strong><a href="#" class="artist-link" data-artist="${label.topArtist}">${label.topArtist||'—'}</a></strong></div>
          <div><span class="small">Revenue</span><br><strong>${money(label.totalRevenueUSD)}</strong></div>
          <div><span class="small">Debt</span><br><strong>${money(label.totalDebtUSD)}</strong></div>
          <div><span class="small">Final Total</span><br><strong>${money(label.finalTotalUSD)}</strong></div>
        </div>
        <div style="margin-top:8px;">${debtBadge}</div>
        <details style="margin-top:8px;">
          <summary>Top Albums</summary>
          <ul>${topAlbums}</ul>
        </details>
        <details>
          <summary>Yearly Pricing</summary>
          ${renderLabelPricingTable(label.label)}
        </details>
      </div>`
    }).join('');

  // Delegate clicks for artist links
  wrap.addEventListener('click', (e)=>{
    const link = e.target.closest('.artist-link');
    if (link) { e.preventDefault(); openArtistModal(link.dataset.artist); }
  });
}

function renderLabelPricingTable(label) {
  const years = labelPricing[label] ? Object.keys(labelPricing[label]).sort((a,b)=>Number(b)-Number(a)) : [];
  if (!years.length) return '<div class="small">No pricing data.</div>';
  const rows = years.map(y => {
    const p = labelPricing[label][y];
    return `<tr>
      <td>${y}</td>
      <td>${p.salePerRecord !== null ? money(p.salePerRecord) : '—'}</td>
      <td>${p.salePerPlay !== null ? money(p.salePerPlay) : '—'}</td>
      <td>${p.artistSplit != null ? (p.artistSplit*100).toFixed(0)+'%' : '—'}</td>
      <td>${p.labelSplit != null ? (p.labelSplit*100).toFixed(0)+'%' : '—'}</td>
    </tr>`
  }).join('');
  return `<table class="data-table"><thead><tr>
    <th>Year</th><th>Sale/Record</th><th>Sale/Play</th><th>% Artist</th><th>% Label</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderArtistsTable() {
  const tbody = document.querySelector('#artistsTable tbody');
  const labelFilter = document.getElementById('labelFilter').value;
  const q = document.getElementById('artistSearch').value?.toLowerCase() || '';

  const rows = Object.values(artistsData)
    .filter(a => a && a.artist)
    .filter(a => !labelFilter || a.label === labelFilter)
    .filter(a => !q || a.artist.toLowerCase().includes(q))
    .sort((a,b)=> (b.totalRevenueUSD||0) - (a.totalRevenueUSD||0))
    .map(a => `<tr>
      <td><a href="#" class="artist-link" data-artist="${a.artist}">${a.artist}</a></td>
      <td>${a.label||'—'}</td>
      <td>${money(a.totalRevenueUSD)}</td>
      <td>${money(a.debtUSD)}</td>
      <td>${money(a.finalTotalUSD)}</td>
      <td>${money(a.artistPayoutUSD)}</td>
      <td>${money(a.labelIncomeUSD)}</td>
    </tr>`).join('');

  tbody.innerHTML = rows || '<tr><td colspan="7" class="small">No artists.</td></tr>';

  // Delegate clicks for artist links
  tbody.addEventListener('click', (e)=>{
    const link = e.target.closest('.artist-link');
    if (link) { e.preventDefault(); openArtistModal(link.dataset.artist); }
  });
}

function renderAlbumsTable() {
  const tbody = document.querySelector('#albumsTable tbody');
  const rows = (albumsData||[])
    .sort((a,b)=> (b.points||0) - (a.points||0))
    .map(alb => `<tr>
      <td>${alb.album||'—'}</td>
      <td><a href="#" class="artist-link" data-artist="${alb.artist}">${alb.artist||'—'}</a></td>
      <td>${alb.label||'—'}</td>
      <td>${fnum(alb.points)}</td>
      <td>${fnum(alb.salesUnitsMillions)}</td>
      <td>${fnum(alb.playsMillions)}</td>
      <td>${fnum(alb.totalBudgetM)}</td>
    </tr>`).join('');
  tbody.innerHTML = rows || '<tr><td colspan="7" class="small">No albums.</td></tr>';

  tbody.addEventListener('click', (e)=>{
    const link = e.target.closest('.artist-link');
    if (link) { e.preventDefault(); openArtistModal(link.dataset.artist); }
  });
}

function renderPricing() {
  const wrap = document.getElementById('pricingWrap');
  const labels = Object.keys(labelPricing).sort();
  wrap.innerHTML = labels.map(label => `
    <h3>${label}</h3>
    ${renderLabelPricingTable(label)}
  `).join('');
}

function setupSearch() {
  document.getElementById('artistSearch').addEventListener('input', renderArtistsTable);
}

let weeklyChart, yearlyChart;

function setupModal() {
  document.getElementById('closeModal').addEventListener('click', ()=>{
    document.getElementById('artistModal').classList.add('hidden');
    if (weeklyChart) weeklyChart.destroy();
    if (yearlyChart) yearlyChart.destroy();
  });
}

function openArtistModal(artistName) {
  const artist = artistsData[artistName];
  if (!artist) return;

  document.getElementById('artistTitle').textContent = artistName;
  document.getElementById('artistModal').classList.remove('hidden');

  const weekly = getArtistWeekly(artistName);
  const yearly = aggregateYearly(weekly);

  const ctx1 = document.getElementById('artistWeeklyChart').getContext('2d');
  const ctx2 = document.getElementById('artistYearlyChart').getContext('2d');

  if (weeklyChart) weeklyChart.destroy();
  weeklyChart = new Chart(ctx1, {
    type: 'line',
    data: {
      labels: weekly.map(w => 'W' + w.week),
      datasets: [
        { label: 'Sales', data: weekly.map(w=>w.sales||0) },
        { label: 'Plays', data: weekly.map(w=>w.plays||0) }
      ]
    }
  });

  if (yearlyChart) yearlyChart.destroy();
  yearlyChart = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: Object.keys(yearly),
      datasets: [
        { label: 'Sales', data: Object.values(yearly).map(y=>y.sales||0) },
        { label: 'Plays', data: Object.values(yearly).map(y=>y.plays||0) }
      ]
    }
  });

  // Meta
  const totalWeeks = weekly.length;
  const totalSales = weekly.reduce((a,x)=>a+(x.sales||0),0);
  const totalPlays = weekly.reduce((a,x)=>a+(x.plays||0),0);

  const albums = (artist.albums||[]).sort((a,b)=> (b.points||0)-(a.points||0));
  const albumList = albums.slice(0,20).map(alb => `<li>${alb.album} <span class="small">(${alb.label||'—'})</span> — Points: ${fnum(alb.points)}, Sales(M): ${fnum(alb.salesUnitsMillions)}, Plays(M): ${fnum(alb.playsMillions)}, Budget(M): ${fnum(alb.totalBudgetM)}</li>`).join('');

  document.getElementById('artistMeta').innerHTML = `
    <div><strong>Label:</strong> ${artist.label||'—'}</div>
    <div><strong>Total Revenue:</strong> ${money(artist.totalRevenueUSD)}</div>
    <div><strong>Debt:</strong> ${money(artist.debtUSD)}</div>
    <div><strong>Final Total:</strong> ${money(artist.finalTotalUSD)}</div>
    <div><strong>Artist $:</strong> ${money(artist.artistPayoutUSD)} • <strong>Label $:</strong> ${money(artist.labelIncomeUSD)}</div>
    <div><strong>Weeks Charted:</strong> ${fnum(totalWeeks)} • <strong>Sales (sum):</strong> ${fnum(totalSales)} • <strong>Plays (sum):</strong> ${fnum(totalPlays)}</div>
  `;

  document.getElementById('artistAlbums').innerHTML = albums.length ? `<h3>Albums</h3><ul>${albumList}</ul>` : '<div class="small">No linked albums.</div>';
}

function getArtistWeekly(artistName) {
  const out = [];
  for (const wk in weekData) {
    const arr = weekData[wk] || [];
    for (const row of arr) {
      if (row.artist === artistName) {
        out.push({ week: Number(wk), sales: row.sales || row.totalSales || 0, plays: row.plays || 0 });
      }
    }
  }
  out.sort((a,b)=> a.week - b.week);
  return out;
}

function aggregateYearly(weeklyRows) {
  const agg = {};
  for (const row of weeklyRows) {
    const date = new Date(START_DATE.getTime() + (row.week-1)*7*24*3600*1000);
    const y = String(date.getFullYear());
    if (!agg[y]) agg[y] = { sales: 0, plays: 0 };
    agg[y].sales += row.sales || 0;
    agg[y].plays += row.plays || 0;
  }
  return agg;
}
