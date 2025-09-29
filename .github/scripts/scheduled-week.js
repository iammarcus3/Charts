// Scheduled GitHub Action to fetch Last.fm data every Friday,
// process it with your exact Python logic, and persist to weekdata.js

const fetch = require("node-fetch");

// --- Settings: Your Last.fm credentials ---
const API_KEY = "ed9c6dcac73ea1adcd3750efeea9b822";
const USER = "IAMMARCUS3";

// --- Settings: GitHub repo for persistence ---
const GH_TOKEN   = process.env.GITHUB_TOKEN;
const GH_REPO    = process.env.GITHUB_REPO || "iammarcus3/Charts";
const GH_BRANCH  = process.env.GITHUB_BRANCH || "main";
const WEEKDATA_PATH = process.env.WEEKDATA_PATH || "weekdata.js";

// --- Debug log start ---
console.log("DEBUG: Starting weekly update job");
console.log("DEBUG: GH_REPO =", GH_REPO);
console.log("DEBUG: GH_BRANCH =", GH_BRANCH);
console.log("DEBUG: WEEKDATA_PATH =", WEEKDATA_PATH);

// --- Constants ---
const MAX_ENTRIES = 200;
const LAST_STATIC_WEEK = 396;

// --- Factor tables (EXACT from your Python) ---
const STREAMS_FACTORS = [
  [1, 1, 48.50], [2, 2, 46.78], [3, 5, 30.90], [6, 6, 20.90], [7, 10, 22.90],
  [11, 15, 27.85], [16, 25, 25.90], [26, 30, 42.70], [31, 50, 33.95],
  [51, 70, 50.90], [71, 85, 46.50], [86, 200, 70.00],
];
const RADIO_FACTORS = [
  [1, 1, 186.90], [2, 2, 450.10], [3, 5, 620.20], [6, 6, 930.30],
  [7, 10, 1840.40], [11, 15, 800.50], [16, 25, 700.60], [26, 30, 650.70],
  [31, 50, 400.80], [51, 70, 150.90], [71, 85, 90.10], [86, 200, 60.11],
];
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
function getFactor(factors, weeks) {
  for (const [s, e, f] of factors) if (s <= weeks && weeks <= e) return f;
  return factors[factors.length - 1][2];
}
function calcSales(plays, mult) { return plays * mult; }
function calcStreams(sales, weeks) { return sales * getFactor(STREAMS_FACTORS, weeks) * 8500; }
function calcRadio(sales, weeks) { return sales * getFactor(RADIO_FACTORS, weeks) * 1_000_000; }
function calcPoints(sales, streams, radio, maxSales, maxStreams, maxRadio) {
  if (maxSales === 0) maxSales = 1;
  if (maxStreams === 0) maxStreams = 1;
  if (maxRadio === 0) maxRadio = 1;
  return Math.round(200 * (
    0.3 * (sales / maxSales) +
    0.3 * (streams / maxStreams) +
    0.4 * (radio / maxRadio)
  ));
}
function getKey(title, artist) {
  return title.toLowerCase().trim() + "||" + artist.toLowerCase().trim();
}

// --- GitHub file helpers ---
async function githubGetFile() {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${WEEKDATA_PATH}?ref=${GH_BRANCH}`;
  console.log("DEBUG: Fetching weekdata.js from", url);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${GH_TOKEN}` }});
  if (!res.ok) {
    const msg = `GitHub get file failed: ${res.status} ${res.statusText}`;
    console.error("ERROR:", msg);
    throw new Error(msg);
  }
  const j = await res.json();
  console.log("DEBUG: weekdata.js successfully fetched, size =", j.size);
  return { content: Buffer.from(j.content, j.encoding).toString("utf-8"), sha: j.sha };
}
async function githubUpdateFile(newContent, sha, message) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${WEEKDATA_PATH}`;
  console.log("DEBUG: Updating file at", url);

  const body = {
    message,
    content: Buffer.from(newContent, "utf-8").toString("base64"),
    sha,
    branch: GH_BRANCH
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errMsg = `GitHub update failed: ${res.status} ${await res.text()}`;
    console.error("ERROR:", errMsg);
    throw new Error(errMsg);
  }
  console.log("DEBUG: weekdata.js successfully updated");
  return await res.json();
}

// --- Last Friday→Thursday window (South Africa time, UTC+2) ---
function lastFridayToThursdayRange() {
  const TZ_OFFSET = 2 * 3600;
  const now = Math.floor(Date.now() / 1000) + TZ_OFFSET;
  const d = new Date(now * 1000);
  const localMidnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = localMidnight.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceFri = (dow - 5 + 7) % 7;
  const thisFri = new Date(localMidnight.getTime() - daysSinceFri * 86400 * 1000);
  const prevFri = new Date(thisFri.getTime() - 7 * 86400 * 1000);
  const from = Math.floor((prevFri.getTime() - TZ_OFFSET * 1000) / 1000);
  const to = Math.floor((thisFri.getTime() - TZ_OFFSET * 1000) / 1000);
  console.log("DEBUG: Last Friday→Thursday range", { from, to });
  return { from, to };
}

// --- Fetch scrobbles ---
async function fetchScrobbles(from, to) {
  let page = 1, totalPages = 1;
  const all = [];
  while (page <= totalPages) {
    console.log(`DEBUG: Fetching Last.fm scrobbles page ${page}/${totalPages}`);
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks&user=${USER}&api_key=${API_KEY}&format=json&from=${from}&to=${to}&limit=200&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Last.fm error ${res.status}`);
    const j = await res.json();
    const arr = j.recenttracks?.track || [];
    for (const t of arr) if (t.date) all.push(t);
    const attr = j.recenttracks["@attr"];
    totalPages = attr ? parseInt(attr.totalPages || "1") : 1;
    page++;
  }
  console.log("DEBUG: Total scrobbles fetched =", all.length);
  return all;
}
function aggregatePlays(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const title = t.name;
    const artist = t.artist?.["#text"] || "";
    const album = t.album?.["#text"] || "Unknown";
    const key = getKey(title, artist);
    const cur = map.get(key) || { title, artist, album, plays: 0 };
    cur.plays++;
    map.set(key, cur);
  }
  console.log("DEBUG: Aggregated unique songs =", map.size);
  return [...map.values()];
}

// --- Main scheduled handler ---
async function handler() {
  try {
    console.log("DEBUG: Handler started");

    // 1. Load weekdata.js from GitHub
    const { content, sha } = await githubGetFile();
    const weekData = JSON.parse(content.match(/\{[\s\S]*\}/)[0]);
    console.log("DEBUG: Parsed weekData successfully");

    // 2. Get last completed week number
    const lastWeek = Math.max(...Object.keys(weekData).map(Number));
    const nextWeek = Math.max(lastWeek, LAST_STATIC_WEEK) + 1;
    console.log("DEBUG: Last week =", lastWeek, "Next week =", nextWeek);

    // 3. Get scrobbles for Fri→Thu
    const { from, to } = lastFridayToThursdayRange();
    const scrobbles = await fetchScrobbles(from, to);
    const plays = aggregatePlays(scrobbles);
    plays.sort((a, b) => b.plays - a.plays);

    // 4. Load song history
    const songHistory = new Map();
    for (const [w, entries] of Object.entries(weekData)) {
      for (const e of entries) {
        const key = getKey(e.title, e.artist);
        songHistory.set(key, {
          totalSales: e.totalSales,
          weeks: e.weeks,
          lastRank: e.rank,
          peak: e.peak,
          last_seen: parseInt(w)
        });
      }
    }
    console.log("DEBUG: Song history loaded, entries =", songHistory.size);

    // 5. Compute sales/streams/radio/points
    let maxSales = 0, maxStreams = 0, maxRadio = 0;
    const provisional = plays.map((p, i) => {
      const rank = i + 1;
      const mult = getMultiplierForRank(rank);
      const hist = songHistory.get(getKey(p.title, p.artist));
      const weeks = hist ? hist.weeks + 1 : 1;
      const sales = calcSales(p.plays, mult);
      const streams = calcStreams(sales, weeks);
      const radio = calcRadio(sales, weeks);
      maxSales = Math.max(maxSales, sales);
      maxStreams = Math.max(maxStreams, streams);
      maxRadio = Math.max(maxRadio, radio);
      return { ...p, rank, sales, streams, radio, weeks, hist };
    });
    console.log("DEBUG: Provisional entries =", provisional.length);

    // 6. Calculate points & finalize ranking
    const withPoints = provisional.map(e => ({
      ...e,
      points: calcPoints(e.sales, e.streams, e.radio, maxSales, maxStreams, maxRadio)
    })).sort((a, b) => b.points - a.points);

    // 7. Build final entries
    const entries = withPoints.slice(0, MAX_ENTRIES).map((e, i) => {
      const rank = i + 1;
      let movement = "NEW";
      if (e.hist) {
        if (e.hist.last_seen !== lastWeek) movement = "RE";
        else if (rank < e.hist.lastRank) movement = "UP";
        else if (rank > e.hist.lastRank) movement = "DOWN";
        else movement = "—";
      }
      const totalSales = (e.hist?.totalSales || 0) + e.sales;
      const peak = e.hist ? Math.min(rank, e.hist.peak) : rank;
      return {
        rank,
        movement,
        title: e.title,
        artist: e.artist,
        album: e.album,
        plays: e.plays,
        sales: e.sales,
        totalSales,
        weeks: e.weeks,
        peak,
        streams: Math.trunc(e.streams),
        radio: e.radio,
        points: e.points
      };
    });
    console.log("DEBUG: Final entries prepared =", entries.length);

    // 8. Update weekData + push to GitHub
    weekData[nextWeek] = entries;
    const newContent = "const weekData = " + JSON.stringify(weekData, null, 2) + ";";
    await githubUpdateFile(newContent, sha, `add week ${nextWeek} (Last.fm)`);

    console.log("SUCCESS: Week", nextWeek, "updated with", entries.length, "entries");
    return { statusCode: 200, body: JSON.stringify({ ok: true, week: nextWeek, entries: entries.length }) };
  } catch (err) {
    console.error("FATAL ERROR:", err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

module.exports = { handler };
