(function(){
  try {
    const table = document.querySelector('#summary tbody');
    if (!table) return;
    for (const tr of table.querySelectorAll('tr')) {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) continue;
      const artistCell = tds[1];
      const name = (artistCell.textContent || '').trim();
      if (!name) continue;
      const a = document.createElement('a');
      a.textContent = name;
      a.href = 'artist_detail.html?artist=' + encodeURIComponent(name);
      a.style.color = '#a5b4fc';
      a.style.textDecoration = 'none';
      a.onmouseenter = () => a.style.textDecoration = 'underline';
      a.onmouseleave = () => a.style.textDecoration = 'none';
      artistCell.textContent = '';
      artistCell.appendChild(a);
    }
  } catch(e) {
    console.error('artist_click_enhancer:', e);
  }
})();