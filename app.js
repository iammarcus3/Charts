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
  wrap.innerHTML = "";

  for (const [label, stats] of Object.entries(labelYearAgg)) {
    const card = document.createElement("div");
    card.className = "label-card";
    card.innerHTML = `
      <h3>${label}</h3>
      <p><strong>Sales:</strong> ${stats.overall.sales.toLocaleString()}</p>
      <p><strong>Plays:</strong> ${stats.overall.plays.toLocaleString()}</p>
      <p><strong>Debt:</strong> $${stats.overall.debt.toLocaleString()}</p>
      <p><strong>Budgets:</strong> $${stats.overall.budgets.toLocaleString()}</p>
    `;
    card.addEventListener("click", () => openLabelModal(label));
    wrap.appendChild(card);
  }
}

function renderArtists() {
  const tbody = document.querySelector('#artistsTable tbody');
  tbody.innerHTML = "";

  for (const [artist, data] of Object.entries(artistsYearData)) {
    const debtClass = data.overall.final_total_usd < 0 ? "red" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><a href="#" class="artist-link ${debtClass}" data-artist="${artist}">${artist}</a></td>
      <td>${(data.overall.sales || 0).toLocaleString()}</td>
      <td>${(data.overall.plays || 0).toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', e => {
    const link = e.target.closest('.artist-link');
    if (link) {
      e.preventDefault();
      openArtistModal(link.dataset.artist);
    }
  });
}

function setupModals() {
  document.getElementById('closeArtistModal')?.addEventListener('click', () => {
    document.getElementById('artistModal').classList.add('hidden');
  });
  document.getElementById('closeLabelModal')?.addEventListener('click', () => {
    document.getElementById('labelModal').classList.add('hidden');
  });
}

function openArtistModal(name) {
  const data = artistsYearData[name];
  if (!data) return;
  document.getElementById('artistTitle').textContent = name;
  document.getElementById('artistModal').classList.remove('hidden');

  // Chart yearly sales/plays
  const ctx = document.getElementById('artistYearlyChart').getContext('2d');
  if (window.artistChart) window.artistChart.destroy();
  window.artistChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(data.yearly),
      datasets: [
        { label: 'Sales', data: Object.values(data.yearly).map(y => y.sales) },
        { label: 'Plays', data: Object.values(data.yearly).map(y => y.plays) }
      ]
    }
  });

  // Yearly table
  let table = '<table class="data-table"><thead><tr><th>Year</th><th>Sales</th><th>Plays</th></tr></thead><tbody>';
  for (const [year, vals] of Object.entries(data.yearly)) {
    table += `<tr><td>${year}</td><td>${vals.sales.toLocaleString()}</td><td>${vals.plays.toLocaleString()}</td></tr>`;
  }
  table += `<tr><td><strong>Total</strong></td><td><strong>${(data.overall.sales||0).toLocaleString()}</strong></td><td><strong>${(data.overall.plays||0).toLocaleString()}</strong></td></tr>`;
  table += '</tbody></table>';
  document.getElementById('artistYearlyTable').innerHTML = table;
}

function openLabelModal(label) {
  const stats = labelYearAgg[label];
  if (!stats) return;
  document.getElementById('labelTitle').textContent = label;
  document.getElementById('labelModal').classList.remove('hidden');

  // Simple table with totals
  let table = '<table class="data-table"><thead><tr><th>Metric</th><th>Total</th></tr></thead><tbody>';
  table += `<tr><td>Sales</td><td>${stats.overall.sales.toLocaleString()}</td></tr>`;
  table += `<tr><td>Plays</td><td>${stats.overall.plays.toLocaleString()}</td></tr>`;
  table += `<tr><td>Debt</td><td>$${stats.overall.debt.toLocaleString()}</td></tr>`;
  table += `<tr><td>Budgets</td><td>$${stats.overall.budgets.toLocaleString()}</td></tr>`;
  table += '</tbody></table>';
  document.getElementById('labelYearlyTable').innerHTML = table;
}
