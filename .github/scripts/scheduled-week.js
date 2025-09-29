// Scheduled GitHub Action to fetch Last.fm data every Friday,
// process it with your exact Python logic, and persist to weekdata.js

const fetch = require("node-fetch");
const fs = require("fs");
const { execSync } = require("child_process");

// --- Settings: Your Last.fm credentials ---
const API_KEY = "ed9c6dcac73ea1adcd3750efeea9b822";
const USER = "IAMMARCUS3";

// --- Settings: GitHub repo for persistence ---
const GH_REPO    = process.env.GITHUB_REPO || "iammarcus3/Charts";
const GH_BRANCH  = process.env.GITHUB_BRANCH || "main";
const WEEKDATA_PATH = process.env.WEEKDATA_PATH || "weekdata.js";
const DRY_RUN = process.env.DRY_RUN === "true";

// --- Debug log start ---
console.log("DEBUG: Starting weekly update job");
console.log("DEBUG: GH_REPO =", GH_REPO);
console.log("DEBUG: GH_BRANCH =", GH_BRANCH);
console.log("DEBUG: WEEKDATA_PATH =", WEEKDATA_PATH);
console.log("DEBUG: DRY_RUN =", DRY_RUN);

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
function calcRadio(sales, weeks) { return sales * getFactor(RADIO_FACTORS, weeks) * 1_000; }
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

// --- Last Friday→Thursday window (South Africa time, UTC+2) ---
function lastFridayToThursdayRange() {
  const TZ_OFFSET = 2 * 3600;
  const now = Math.floor(Date.now() / 1000) + TZ_OFFSET;
  const d = new Date(now * 1000);
  const localMidnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = localMidnight.getUTCDay();
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
    for (const t of arr) if (t.date) all.push(t); // ignore "now playing"
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

    // 1. Load weekdata.js as a module
    const weekData = require("./" + WEEKDATA_PATH);
    console.log("DEBUG: weekdata.js loaded successfully");

    // 2. Last completed week
    const lastWeek = Math.max(...Object.keys(weekData).map(Number));
    const nextWeek = Math.max(lastWeek, LAST_STATIC_WEEK) + 1;
    console.log("DEBUG: Last week =", lastWeek, "Next week =", nextWeek);

    // 3. Get scrobbles
    const { from, to } = lastFridayToThursdayRange();
    const scrobbles = await fetchScrobbles(from, to);
    const plays = aggregatePlays(scrobbles);
    plays.sort((a, b) => b.plays - a.plays);

    // 4. Song history
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

    // 5. Compute provisional stats
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

    // 6. Finalize with points
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

    // 8. Dry-run vs publish
    if (DRY_RUN) {
      console.log("=== DRY RUN PREVIEW (Top 20) ===");
      for (const e of entries.slice(0, 20)) {
        console.log(
          `#${e.rank} ${e.title} — ${e.artist} | Plays: ${e.plays} | Sales: ${e.sales.toFixed(2)} | Points: ${e.points}`
        );
      }
      console.log("=== END PREVIEW ===");
      return;
    }

    // 9. Write & commit
    weekData[nextWeek] = entries;
    const newContent = "module.exports = " + JSON.stringify(weekData, null, 2) + ";\n";
    fs.writeFileSync(WEEKDATA_PATH, newContent);
    console.log("DEBUG: weekdata.js written locally");

    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync(`git add ${WEEKDATA_PATH}`);
    execSync(`git commit -m "add week ${nextWeek} (Last.fm)" || echo "No changes to commit"`);
    execSync("git push");
    console.log("SUCCESS: Week", nextWeek, "committed to GitHub");
  } catch (err) {
    console.error("FATAL ERROR:", err.message);
    console.error(err.stack);
  }
}

// --- Run the handler when executed directly ---
if (require.main === module) {
  handler().catch(err => {
    console.error("UNHANDLED:", err);
    process.exit(1);
  });
}

module.exports = { handler };
