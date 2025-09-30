// App logic for Record Label Dashboard

document.addEventListener("DOMContentLoaded", () => {
  renderGlobalStats();
  renderLabelTabs();
  setupModal();
});

function renderGlobalStats() {
  const container = document.getElementById("globalCards");
  const totalRevenue = Object.values(artistData).reduce((acc, a) => acc + a.totalRevenue, 0);
  const totalDebt = Object.values(artistData).reduce((acc, a) => acc + a.debt, 0);
  const topArtist = Object.values(artistData).sort((a, b) => b.totalRevenue - a.totalRevenue)[0];
  const topLabel = Object.values(labelPricing).map((l, idx) => Object.keys(labelPricing)[idx]);

  const cards = [
    { title: "Total Revenue", value: `$${totalRevenue.toLocaleString()}` },
    { title: "Total Debt", value: `$${totalDebt.toLocaleString()}` },
    { title: "Top Artist", value: topArtist.artist },
    { title: "Labels", value: topLabel.length }
  ];

  container.innerHTML = cards.map(c => `
    <div class="bg-gray-800 p-4 rounded-lg shadow text-center">
      <h3 class="text-lg font-semibold mb-2">${c.title}</h3>
      <p class="text-xl text-pink-400 font-bold">${c.value}</p>
    </div>
  `).join("");
}

function renderLabelTabs() {
  const container = document.getElementById("labelTabs");
  const content = document.getElementById("labelContent");
  const labels = Object.keys(labelPricing);

  labels.forEach((label, idx) => {
    const tab = document.createElement("button");
    tab.className = "px-4 py-2 rounded bg-gray-700 hover:bg-pink-500";
    tab.innerText = label;
    tab.addEventListener("click", () => showLabel(label));
    container.appendChild(tab);

    if (idx === 0) showLabel(label);
  });

  function showLabel(label) {
    const yearly = labelPricing[label];
    const tableRows = Object.entries(yearly).map(([year, stats]) => `
      <tr>
        <td class="px-4 py-2">${year}</td>
        <td class="px-4 py-2">$${stats.salePerRecord}</td>
        <td class="px-4 py-2">$${stats.salePerPlay}</td>
        <td class="px-4 py-2">${(stats.artistSplit * 100) || '-'}%</td>
        <td class="px-4 py-2">${(stats.labelSplit * 100) || '-'}%</td>
      </tr>
    `).join("");

    content.innerHTML = `
      <h3 class="text-xl font-bold mb-2">${label}</h3>
      <table class="table-auto w-full text-sm text-left bg-gray-800 rounded">
        <thead><tr class="bg-gray-700">
          <th class="px-4 py-2">Year</th>
          <th class="px-4 py-2">Sale/Record</th>
          <th class="px-4 py-2">Sale/Play</th>
          <th class="px-4 py-2">% Artist</th>
          <th class="px-4 py-2">% Label</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    `;
  }
}

function setupModal() {
  const modal = document.getElementById("artistModal");
  const closeBtn = document.getElementById("closeModal");
  closeBtn.addEventListener("click", () => modal.classList.add("hidden"));

  document.querySelectorAll(".artist-link").forEach(el => {
    el.addEventListener("click", () => {
      const artist = el.dataset.artist;
      showArtistModal(artist);
    });
  });
}

function showArtistModal(artist) {
  const modal = document.getElementById("artistModal");
  modal.classList.remove("hidden");

  document.getElementById("artistName").innerText = artist;

  const stats = [];
  for (const week in weekData) {
    weekData[week].forEach(entry => {
      if (entry.artist === artist) {
        stats.push({ week: parseInt(week), sales: entry.sales, plays: entry.plays });
      }
    });
  }

  const ctx = document.getElementById("artistChart").getContext("2d");
  new Chart(ctx, {
    type: "line",
    data: {
      labels: stats.map(s => "Week " + s.week),
      datasets: [
        { label: "Sales", data: stats.map(s => s.sales), borderColor: "rgb(255,99,132)", fill: false },
        { label: "Plays", data: stats.map(s => s.plays), borderColor: "rgb(54,162,235)", fill: false }
      ]
    }
  });

  document.getElementById("artistStats").innerHTML = `
    <p>Total Weeks: ${stats.length}</p>
    <p>Total Sales: $${stats.reduce((a,b)=>a+b.sales,0).toLocaleString()}</p>
    <p>Total Plays: ${stats.reduce((a,b)=>a+b.plays,0).toLocaleString()}</p>
  `;
}
