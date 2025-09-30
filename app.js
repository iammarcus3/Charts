document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  renderLabels();
  renderArtists();
  setupModals();
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

function renderLabels() {
  const wrap = document.getElementById('labelsGrid');
  wrap.innerHTML = Object.values(artistsYearData)
    .reduce((map,a)=>{ if(!map[a.label]) map[a.label]=[]; map[a.label].push(a); return map; }, {})
    ? 'Use label data from Excel' : 'Labels not fully implemented';
}

function renderArtists() {
  const tbody = document.querySelector('#artistsTable tbody');
  tbody.innerHTML = Object.values(artistsYearData).map(a => `
    <tr>
      <td><a href="#" class="artist-link" data-artist="${a.artist}">${a.artist}</a></td>
      <td>${(a.overall.sales||0).toLocaleString()}</td>
      <td>${(a.overall.plays||0).toLocaleString()}</td>
    </tr>`).join('');
  tbody.addEventListener('click', e=>{
    const link = e.target.closest('.artist-link');
    if(link){ e.preventDefault(); openArtistModal(link.dataset.artist); }
  });
}

function setupModals(){
  document.getElementById('closeArtistModal').addEventListener('click', ()=>{
    document.getElementById('artistModal').classList.add('hidden');
  });
  document.getElementById('closeLabelModal').addEventListener('click', ()=>{
    document.getElementById('labelModal').classList.add('hidden');
  });
}

function openArtistModal(name){
  const data = artistsYearData[name];
  if(!data) return;
  document.getElementById('artistTitle').textContent = name;
  document.getElementById('artistModal').classList.remove('hidden');
  // Chart yearly
  const ctx = document.getElementById('artistYearlyChart').getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(data.yearly),
      datasets: [
        { label:'Sales', data: Object.values(data.yearly).map(y=>y.sales) },
        { label:'Plays', data: Object.values(data.yearly).map(y=>y.plays) }
      ]
    }
  });
  // Table yearly
  let table = '<table class="data-table"><thead><tr><th>Year</th><th>Sales</th><th>Plays</th></tr></thead><tbody>';
  for(const [year,vals] of Object.entries(data.yearly)){
    table += `<tr><td>${year}</td><td>${vals.sales.toLocaleString()}</td><td>${vals.plays.toLocaleString()}</td></tr>`;
  }
  table += `<tr><td><strong>Total</strong></td><td><strong>${(data.overall.sales||0).toLocaleString()}</strong></td><td><strong>${(data.overall.plays||0).toLocaleString()}</strong></td></tr>`;
  table += '</tbody></table>';
  document.getElementById('artistYearlyTable').innerHTML = table;
}
