// Scheduled GitHub Action to fetch Last.fm data every Friday,
// process with your exact logic, and persist to weekdata.js
// — respects your file format and NEVER wipes prior weeks.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// --- Settings: Last.fm credentials ---
const API_KEY = "ed9c6dcac73ea1adcd3750efeea9b822";
const USER = "IAMMARCUS3";

// --- Settings: repo + file ---
const WEEKDATA_PATH = process.env.WEEKDATA_PATH || "weekdata.js"; // relative to repo root
const DRY_RUN = process.env.DRY_RUN === "true";
// Force a specific week (e.g. 396) to overwrite that week.
// If unset, the script appends the next week after the current max.
const TARGET_WEEK = process.env.TARGET_WEEK ? parseInt(process.env.TARGET_WEEK, 10) : null;

// --- Debug ---
console.log("DEBUG: Starting weekly update job");
console.log("DEBUG: WEEKDATA_PATH =", WEEKDATA_PATH);
console.log("DEBUG: DRY_RUN =", DRY_RUN);
console.log("DEBUG: TARGET_WEEK =", TARGET_WEEK);
console.log("DEBUG: CWD =", process.cwd());
console.log("DEBUG: Node =", process.version);

// --- Constants ---
const MAX_ENTRIES = 200;

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
  if (rank === 1) return 40.45;
  else if (rank <= 5) return 37.89;
  else if (rank <= 10) return 35.16;
  else if (rank <= 20) return 32.99;
  else if (rank <= 40) return 30.98;
  else if (rank <= 50) return 28.10;
  else if (rank <= 60) return 25.78;
  else if (rank <= 70) return 23.06;
  else if (rank <= 80) return 22.99;
  else if (rank <= 100) return 21.99;
  else return 17.9;
}
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

// --- Last Friday→Thursday (South Africa, UTC+2). Returns the last *completed* window.
function lastFridayToThursdayRange() {
  const TZ_OFFSET = 2 * 3600; // seconds
  const nowSec = Math.floor(Date.now() / 1000) + TZ_OFFSET;
  const now = new Date(nowSec * 1000);
  const localMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = localMidnight.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceFri = (dow - 5 + 7) % 7;
  const thisFri = new Date(localMidnight.getTime() - daysSinceFri * 86400 * 1000);
  const prevFri = new Date(thisFri.getTime() - 7 * 86400 * 1000);
  const from = Math.floor((prevFri.getTime() - TZ_OFFSET * 1000) / 1000);
  const to   = Math.floor((thisFri.getTime() - TZ_OFFSET * 1000) / 1000);
  console.log("DEBUG: Last Friday→Thursday range", { from, to });
  return { from, to };
}

// ---- Robust parsers (handle CommonJS + ESM + legacy styles) ----
function tryParseByRegex(abs) {
  const raw = fs.readFileSync(abs, "utf8");

  // 1) const weekData = { ... }; module.exports = weekData;
  let m = raw.match(/const\s+weekData\s*=\s*(\{[\s\S]*?\})\s*;?\s*module\.exports\s*=\s*weekData\b/);
  if (m) { return JSON.parse(m[1]); }

  // 2) module.exports = { ... };
  m = raw.match(/module\.exports\s*=\s*(\{[\s\S]*?\})\s*;?/);
  if (m) { return JSON.parse(m[1]); }

  // 3) export default { ... }
  m = raw.match(/export\s+default\s+(\{[\s\S]*?\})\s*;?/);
  if (m) { return JSON.parse(m[1]); }

  // 4) export const weekData = { ... }
  m = raw.match(/export\s+const\s+weekData\s*=\s*(\{[\s\S]*?\})\s*;?/);
  if (m) { return JSON.parse(m[1]); }

  return null; // unknown format
}

function loadWeekData(filePathRel) {
  const abs = path.isAbsolute(filePathRel)
    ? filePathRel
    : path.resolve(process.cwd(), filePathRel);

  console.log("DEBUG: Resolved weekdata path =", abs);

  if (!fs.existsSync(abs)) {
    throw new Error("weekdata.js not found — refusing to run with empty data");
  }

  // Preferred: tolerant text parse (supports ESM/CJS/legacy)
  try {
    const parsed = tryParseByRegex(abs);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed).map(Number).filter(Number.isFinite);
      if (keys.length === 0) {
        throw new Error("Parsed object has no week keys — aborting to protect history");
      }
      console.log("DEBUG: Loaded via regex parser with weeks:", keys.sort((a,b)=>a-b));
      return parsed;
    }
  } catch (e) {
    console.warn("WARN: regex parse failed:", e.message);
  }

  // Fallback: require() (works for CJS or transpiled ESM)
  try {
    delete require.cache[abs];
    const mod = require(abs);
    const obj = (mod && typeof mod === "object")
      ? (mod.default && typeof mod.default === "object" ? mod.default : mod)
      : null;
    if (obj && !Array.isArray(obj)) {
      const keys = Object.keys(obj).map(Number).filter(Number.isFinite);
      if (keys.length === 0) {
        throw new Error("require() returned object with no week keys — aborting to protect history");
      }
      console.log("DEBUG: Loaded via require() with weeks:", keys.sort((a,b)=>a-b));
      return obj;
    }
  } catch (e) {
    console.warn("WARN: require() load failed:", e.message);
  }

  // Hard fail instead of wiping
  throw new Error("Could not load weekdata.js in any known format — aborting to avoid wiping old data.");
}

function saveWeekData(filePathRel, newDataObj, oldKeyCount) {
  const abs = path.isAbsolute(filePathRel)
    ? filePathRel
    : path.resolve(process.cwd(), filePathRel);

  // Re-load from disk to detect accidental shrink (throws if bad)
  const currentData = loadWeekData(filePathRel);
  const merged = { ...currentData, ...newDataObj };

  const keysSorted = Object.keys(merged).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  console.log("DEBUG: Final week keys to save =", keysSorted);

  if (typeof oldKeyCount === "number" && keysSorted.length < oldKeyCount) {
    throw new Error(`Refusing to save: week count shrank from ${oldKeyCount} to ${keysSorted.length}`);
  }

  const newContent =
    "const weekData = " +
    JSON.stringify(merged, null, 2) +
    ";\n\nmodule.exports = weekData;\n";

  fs.writeFileSync(abs, newContent);
  console.log("DEBUG: weekdata.js written at", abs);
}

// --- Last.fm fetchers (Node 18+ has global fetch) ---
async function fetchScrobbles(from, to) {
  let page = 1, totalPages = 1;
  const all = [];
  while (page <= totalPages) {
    console.log(`DEBUG: Fetching Last.fm scrobbles page ${page}/${totalPages}`);
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks&user=${encodeURIComponent(USER)}&api_key=${API_KEY}&format=json&from=${from}&to=${to}&limit=200&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Last.fm error ${res.status}`);
    const j = await res.json();
    const arr = j.recenttracks?.track || [];
    for (const t of arr) if (t.date) all.push(t); // ignore "now playing"
    const attr = j.recenttracks?.["@attr"];
    totalPages = attr ? parseInt(attr.totalPages || "1", 10) : 1;
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

    // 1) Load weekdata — hard fail if empty/unknown to protect history
    const weekData = loadWeekData(WEEKDATA_PATH);
    const preKeys = Object.keys(weekData).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    const preCount = preKeys.length;
    if (preCount === 0) {
      throw new Error("Loaded weekdata has 0 weeks — refusing to run to protect history.");
    }
    console.log("DEBUG: Weeks present BEFORE =", preKeys);

    // 2) Decide target week number
    const maxExisting = preKeys[preCount - 1];
    const targetWeek = Number.isInteger(TARGET_WEEK) ? TARGET_WEEK : (maxExisting + 1);
    const overwriting = Number.isInteger(TARGET_WEEK);
    console.log(`DEBUG: Max existing=${maxExisting}. Target week=${targetWeek}. Mode=${overwriting ? "OVERWRITE" : "APPEND"}.`);

    // 3) Pull scrobbles for the last full week
    const { from, to } = lastFridayToThursdayRange();
    const scrobbles = await fetchScrobbles(from, to);
    const plays = aggregatePlays(scrobbles).sort((a, b) => b.plays - a.plays);

    // 4) Build song history (from all prior weeks)
    const songHistory = new Map();
    for (const [w, entries] of Object.entries(weekData)) {
      for (const e of entries) {
        songHistory.set(getKey(e.title, e.artist), {
          totalSales: e.totalSales,
          weeks: e.weeks,
          lastRank: e.rank,
          peak: e.peak,
          last_seen: parseInt(w, 10)
        });
      }
    }

    // 5) Compute provisional metrics
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

    // 6) Points + ranking
    const withPoints = provisional.map(e => ({
      ...e,
      points: calcPoints(e.sales, e.streams, e.radio, maxSales, maxStreams, maxRadio)
    })).sort((a, b) => b.points - a.points);

    const prevWeekNumber = overwriting ? (targetWeek - 1) : maxExisting;

    // 7) Final entries for the week
    const entries = withPoints.slice(0, MAX_ENTRIES).map((e, i) => {
      const rank = i + 1;
      let movement = "NEW";
      if (e.hist) {
        if (e.hist.last_seen !== prevWeekNumber) movement = "RE";
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

    // 8) Dry-run vs publish
    if (DRY_RUN) {
      console.log(`=== DRY RUN PREVIEW (${overwriting ? "Overwriting week " + targetWeek : "Appending week " + targetWeek}) Top 20 ===`);
      for (const e of entries.slice(0, 20)) {
        console.log(`#${e.rank} ${e.title} — ${e.artist} | Plays: ${e.plays} | Sales: ${e.sales.toFixed(2)} | Points: ${e.points}`);
      }
      console.log("=== END PREVIEW ===");
      return;
    }

    // 9) Safety pre-check: ensure we won’t lose early weeks accidentally
    const postTest = { ...weekData, [targetWeek]: entries };
    const postTestKeys = Object.keys(postTest).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    console.log("DEBUG: Weeks that would be present AFTER =", postTestKeys);
    if (postTestKeys.length < preCount) {
      throw new Error(`Safety: about to write fewer weeks (${postTestKeys.length}) than before (${preCount}). Aborting.`);
    }

    // 10) Write & commit — PRESERVE ALL OLD WEEKS
    weekData[targetWeek] = entries;

    const postKeys = Object.keys(weekData).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    console.log("DEBUG: Weeks present AFTER  =", postKeys);
    if (postKeys.length < preCount) {
      throw new Error(`Refusing to save: week count shrank from ${preCount} to ${postKeys.length}`);
    }

    saveWeekData(WEEKDATA_PATH, weekData, preCount);

    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync(`git add ${WEEKDATA_PATH}`);
    execSync(`sh -lc 'git commit -m "${overwriting ? "overwrite" : "add"} week ${targetWeek} (Last.fm)" || echo "No changes to commit"'`);
    execSync("git push");
    console.log("SUCCESS: Week", targetWeek, overwriting ? "overwritten" : "added", "and committed");
  } catch (err) {
    console.error("FATAL ERROR:", err.message);
    console.error(err.stack);
    process.exitCode = 1;
  }
}

// --- Run when executed directly ---
if (require.main === module) {
  handler().catch(err => {
    console.error("UNHANDLED:", err);
    process.exit(1);
  });
}

module.exports = { handler };

