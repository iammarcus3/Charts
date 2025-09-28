// Scheduled Netlify function to fetch Last.fm data every Friday,
// process it with your exact Python logic, and append to weekData.js

const MAX_ENTRIES = 200;
const LAST_STATIC_WEEK = 396;

// --- FACTOR TABLES from your Python ---
const STREAMS_FACTORS = [
  [1, 1, 48.50],
  [2, 2, 46.78],
  [3, 5, 30.90],
  [6, 6, 20.90],
  [7, 10, 22.90],
  [11, 15, 27.85],
  [16, 25, 25.90],
  [26, 30, 42.70],
  [31, 50, 33.95],
  [51, 70, 50.90],
  [71, 85, 46.50],
  [86, 200, 70.00],
];

const RADIO_FACTORS = [
  [1, 1, 186.90],
  [2, 2, 450.10],
  [3, 5, 620.20],
  [6, 6, 930.30],
  [7, 10, 1840.40],
  [11, 15, 800.50],
  [16, 25, 700.60],
  [26, 30, 650.70],
  [31, 50, 400.80],
  [51, 70, 150.90],
  [71, 85, 90.10],
  [86, 200, 60.11],
];

// --- Rank multipliers (EXACT from your Python) ---
function getMultiplierForRank(rank) {
  if (rank === 1) return 39.45;
  else if (rank <= 5) return 35.89;
  else if (rank <= 10) return 32.16;
  else if (rank <= 20) return 30.99;
  else if (rank <= 40) return 28.98;
  else if (rank <= 50) return 26.10;
  else if (rank <= 60) return 23.78;
  else if (rank <= 70) return 21.06;
  else if (rank <= 80) return 20.99;
  else return 10.9;
}

// --- Helpers ---
function getFactor(factors, weeksOnChart) {
  for (const [start, end, factor] of factors) {
    if (start <= weeksOnChart && weeksOnChart <= end) return factor;
  }
  return factors[factors.length - 1][2];
}
function calcSales(plays, multiplier) { return plays * multiplier; }
function calcStreams(sales, weeksOnChart) {
  const f = getFactor(STREAMS_FACTORS, weeksOnChart);
  return sales * f * 8500;
}
function calcRadio(sales, weeksOnChart) {
  const f = getFactor(RADIO_FACTORS, weeksOnChart);
  return sales * f * 1_000_000;
}
function calcPoints(sales, streams, radio, maxSales, maxStreams, maxRadio) {
  if (maxSales === 0) maxSales = 1;
  if (maxStreams === 0) maxStreams = 1;
  if (maxRadio === 0) maxRadio = 1;
  const points = 200 * (
    0.3 * (sales / maxSales) +
    0.3 * (streams / maxStreams) +
    0.4 * (radio / maxRadio)
  );
  return Math.round(points);
}
function getKey(title, artist) {
  return String(title).toLowerCase().trim() + "||" + String(artist).toLowerCase().trim();
}

// --- Last.fm settings (YOUR KEY + USER) ---
const API_KEY = "ed9c6dcac73ea1adcd3750efeea9b822";
const USER = "IAMMARCUS3";

// --- Compute the last Friday→Thursday range (Africa/Johannesburg) ---
function toUnix(date) { return Math.floor(date.getTime() / 1000); }
function lastFridayToThursdayRange() {
  const TZ_OFFSET_SEC = 2 * 3600; // +02:00
  const nowUtcSec = Math.floor(Date.now() / 1000);
  const nowLocalSec = nowUtcSec + TZ_OFFSET_SEC;
  const d = new Date(nowLocalSec * 1000);

  const localMidnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  let dow = localMidnight.getUTCDay(); // 0=Sun .. 6=Sat
  const daysSinceFriday = ((dow - 5 + 7) % 7);
  const thisFridayLocal = new Date(localMidnight.getTime() - daysSinceFriday * 24 * 3600 * 1000);
  const prevFridayLocal = new Date(thisFridayLocal.getTime() - 7 * 24 * 3600 * 1000);

  const from = toUnix(new Date(prevFridayLocal.getTime() - TZ_OFFSET_SEC * 1000));
  const to = toUnix(new Date(thisFridayLocal.getTime() - TZ_OFFSET_SEC * 1000));
  return { from, to };
}

// --- Fetch Last.fm scrobbles for a given range ---
async function fetchScrobbles(from, to) {
  let page = 1, totalPages = 1;
  const tracks = [];
  while (page <= totalPages) {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks&user=${USER}&api_key=${API_KEY}&format=json&from=${from}&to=${to}&limit=200&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Last.fm error ${res.status}`);
    const j = await res.json();
    const arr = j.recenttracks?.track || [];
    for (const t of arr) {
      if (!t.date) continue; // ignore now-playing
      tracks.push(t);
    }
    const attr = j.recenttracks["@attr"];
    totalPages = attr ? parseInt(attr.totalPages || "1", 10) : 1;
    page++;
  }
  return tracks;
}

// --- Aggregate scrobbles into plays ---
function aggregatePlays(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const title = t.name;
    const artist = t.artist?.["#text"] || t.artist?.name || "";
    const album = t.album?.["#text"] || "Unknown";
    const key = getKey(title, artist);
    const cur = map.get(key) || { title, artist, album, plays: 0 };
    cur.plays += 1;
    map.set(key, cur);
  }
  return Array.from(map.values());
}

// --- Main handler ---
export async function handler() {
  try {
    const { from, to } = lastFridayToThursdayRange();
    const scrobbles = await fetchScrobbles(from, to);
    const candidates = aggregatePlays(scrobbles);

    // Sort by plays (desc)
    candidates.sort((a, b) => b.plays - a.plays);

    // First pass: compute sales/streams/radio
    let maxSales = 0, maxStreams = 0, maxRadio = 0;
    const provisional = candidates.map((c, idx) => {
      const rank = idx + 1;
      const weeksOnChart = 1; // new entries default
      const mult = getMultiplierForRank(rank);
      const sales = calcSales(c.plays, mult);
      const streams = calcStreams(sales, weeksOnChart);
      const radio = calcRadio(sales, weeksOnChart);

      maxSales = Math.max(maxSales, sales);
      maxStreams = Math.max(maxStreams, streams);
      maxRadio = Math.max(maxRadio, radio);

      return { ...c, rank, sales, streams, radio };
    });

    // Second pass: calculate points + finalize
    const weekEntry = provisional.map((row) => ({
      rank: row.rank,
      movement: "NEW", // movement tracking needs persistence of prior weekdata
      title: row.title,
      artist: row.artist,
      album: row.album,
      plays: row.plays,
      sales: row.sales,
      totalSales: row.sales,
      weeks: 1,
      peak: row.rank,
      streams: Math.trunc(row.streams),
      radio: row.radio,
      points: calcPoints(row.sales, row.streams, row.radio, maxSales, maxStreams, maxRadio)
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/javascript" },
      body: `weekData["${LAST_STATIC_WEEK + 1}"] = ${JSON.stringify(weekEntry, null, 2)};`
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
