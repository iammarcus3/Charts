// Scheduled GitHub Action to fetch Last.fm data every Friday,
// process with your exact logic, and persist to weekdata.js
// — respects your file format and NEVER wipes prior weeks.

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const vm = require("vm");

// --- Settings: Last.fm credentials (prefer GitHub Secrets) ---
const API_KEY = process.env.LASTFM_API_KEY || "ed9c6dcac73ea1adcd3750efeea9b822";
const USER = process.env.LASTFM_USER || "IAMMARCUS3";

// --- Settings: repo + file ---
const WEEKDATA_PATH = process.env.WEEKDATA_PATH || "weekdata.js"; // relative to repo root
const DRY_RUN = process.env.DRY_RUN === "true";
const TARGET_WEEK = process.env.TARGET_WEEK ? parseInt(process.env.TARGET_WEEK, 10) : null;

// --- Retry/UA knobs ---
const UA = process.env.USER_AGENT || "ChartsBot/1.0 (+github actions)";
const MAX_TRIES = parseInt(process.env.MAX_TRIES || "6", 10);
const ALLOW_PARTIAL = process.env.ALLOW_PARTIAL === "true";

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
  [1, 1, 58.50], [2, 2, 46.78], [3, 5, 30.90], [6, 6, 25.90], [7, 10, 28.90],
  [11, 15, 27.85], [16, 25, 30.90], [26, 30, 45.70], [31, 50, 40.95],
  [51, 70, 50.90], [71, 85, 46.50], [86, 200, 70.00],
];
const RADIO_FACTORS = [
  [1, 1, 186.90], [2, 2, 450.10], [3, 5, 620.20], [6, 6, 1130.30],
  [7, 10, 1940.40], [11, 15, 900.50], [16, 25, 800.60], [26, 30, 750.70],
  [31, 50, 500.80], [51, 70, 450.90], [71, 85, 200.10], [86, 200, 100.11],
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
    0.2 * (streams / maxStreams) +
    0.5 * (radio / maxRadio)
  ));
}
function getKey(title, artist) {
  return title.toLowerCase().trim() + "||" + artist.toLowerCase().trim();
}

// --- Determine last Friday→Thursday range (Africa/Johannesburg, UTC+2) ---
function lastFridayToThursdayRange() {
  const TZ_OFFSET = 2 * 3600; // seconds
  const nowSec = Math.floor(Date.now() / 1000) + TZ_OFFSET;
  const now = new Date(nowSec * 1000);
  const localMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = localMidnight.getUTCDay(); // 0 Sun .. 6 Sat
  const daysSinceFri = (dow - 5 + 7) % 7;
  const thisFri = new Date(localMidnight.getTime() - daysSinceFri * 86400 * 1000);
  const prevFri = new Date(thisFri.getTime() - 7 * 86400 * 1000);
  const from = Math.floor((prevFri.getTime() - TZ_OFFSET * 1000) / 1000);
  const to   = Math.floor((thisFri.getTime() - TZ_OFFSET * 1000) / 1000);
  console.log("DEBUG: Last Friday→Thursday range", { from, to });
  return { from, to };
}

// --- Helpers / Retry ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSONWithRetry(url, tries = MAX_TRIES) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });

      // Try to parse JSON body either way
      let body = null;
      try { body = await res.json(); } catch { body = null; }

      // If HTTP OK but Last.fm returned API-level error, handle it
      const apiErr = body && typeof body.error !== "undefined" ? Number(body.error) : null;

      if (res.ok && apiErr == null) {
        return body || {};
      }

      const status = res.status;
      const retryAfter = res.headers.get("retry-after");
      const retriableHttp = status >= 500 || status === 429;
      const retriableApi = apiErr === 29 || apiErr === 11 || apiErr === 16; // rate limit or temp errors

      if (!(retriableHttp || retriableApi) || i === tries) {
        const reason = apiErr != null
          ? `Last.fm API error ${apiErr}: ${(body && body.message) || "unknown"}`
          : `HTTP ${status}`;
        throw new Error(reason);
      }

      const backoff = retryAfter
        ? (parseInt(retryAfter, 10) || 1) * 1000
        : Math.min(60000, 500 * 2 ** (i - 1)) + Math.floor(Math.random() * 250);

      console.warn(`WARN: ${apiErr != null ? "API" : "HTTP"} error on attempt ${i}/${tries}; sleeping ${backoff}ms`);
      await sleep(backoff);
    } catch (err) {
      if (i === tries) throw err;
      const backoff = Math.min(60000, 500 * 2 ** (i - 1)) + Math.floor(Math.random() * 250);
      console.warn(`WARN: Network/parse error "${err.message}" on attempt ${i}/${tries}; sleeping ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw new Error("Unexpected retry loop exhaustion");
}

// --- File parsers ---
function tryParseByBraceExtraction(abs) {
  const raw = fs.readFileSync(abs, "utf8");
  const startDecl = raw.indexOf("const weekData");
  if (startDecl === -1) return null;
  const eq = raw.indexOf("=", startDecl);
  if (eq === -1) return null;
  let i = raw.indexOf("{", eq);
  if (i === -1) return null;

  let depth = 0;
  let inStr = false;
  let strCh = null;
  let prev = null;
  const len = raw.length;
  const startObj = i;

  for (; i < len; i++) {
    const ch = raw[i];
    if (inStr) {
      if (ch === strCh && prev !== "\\") { inStr = false; strCh = null; }
      prev = ch; continue;
    } else if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strCh = ch; prev = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const objText = raw.slice(startObj, i + 1);
        try { return JSON.parse(objText); }
        catch {
          try {
            const stub = "module.exports = " + objText + ";";
            const sandbox = { module: { exports: {} } };
            vm.createContext(sandbox);
            new vm.Script(stub).runInContext(sandbox, { timeout: 1000 });
            return sandbox.module.exports;
          } catch {}
        }
        break;
      }
    }
    prev = ch;
  }
  return null;
}

function tryParseByVM(abs) {
  const code = fs.readFileSync(abs, "utf8");
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: function () { throw new Error("require() disabled in parser"); },
    process: { env: {} },
    console: { log(){}, warn(){}, error(){} },
  };
  vm.createContext(sandbox);

  try {
    const transformed =
      code
        .replace(/\bexport\s+default\s+/g, "module.exports = ")
        .replace(/\bexport\s+const\s+(\w+)\s*=\s*/g, "const $1 = ")
      + `
; if (typeof module !== 'undefined' && typeof weekData !== 'undefined' && Object.keys(module.exports).length === 0) {
    module.exports = weekData;
  }`;

    const script = new vm.Script(transformed, { filename: abs });
    script.runInContext(sandbox, { timeout: 1000 });
    let out = sandbox.module.exports;
    if ((!out || typeof out !== "object") && typeof sandbox.weekData !== "undefined") out = sandbox.weekData;
    return out && typeof out === "object" ? out : null;
  } catch (e) {
    console.warn("WARN: VM parse failed:", e.message);
  }
  return null;
}

function loadWeekData(filePathRel) {
  const abs = path.resolve(process.cwd(), filePathRel);
  console.log("DEBUG: Resolved weekdata path =", abs);
  if (!fs.existsSync(abs)) throw new Error("weekdata.js not found");

  const braceObj = tryParseByBraceExtraction(abs);
  if (braceObj) {
    const keys = Object.keys(braceObj).map(Number);
    console.log("DEBUG: Loaded via brace parser with weeks:", keys);
    return braceObj;
  }

  const vmObj = tryParseByVM(abs);
  if (vmObj) {
    const keys = Object.keys(vmObj).map(Number);
    console.log("DEBUG: Loaded via VM parser with weeks:", keys);
    return vmObj;
  }

  throw new Error("Could not load weekdata.js — aborting to protect history.");
}

function saveWeekData(filePathRel, newDataObj, oldKeyCount) {
  const abs = path.resolve(process.cwd(), filePathRel);
  const currentData = loadWeekData(filePathRel);
  const merged = { ...currentData, ...newDataObj };
  const keysSorted = Object.keys(merged).map(Number).sort((a,b)=>a-b);
  console.log("DEBUG: Final week keys to save =", keysSorted);
  if (keysSorted.length < oldKeyCount)
    throw new Error("Refusing to save: week count shrank");

  // --- UMD-style export so weekdata.js works in Node AND the browser
  const newContent =
    "// Auto-generated by scheduled-week.js — UMD-style export\n" +
    "const weekData = " + JSON.stringify(merged, null, 2) + ";\n" +
    "(function(g){ g.weekData = weekData; })(typeof globalThis!=='undefined'?globalThis:window);\n" +
    "if (typeof module !== 'undefined' && module.exports) module.exports = weekData;\n";

  fs.writeFileSync(abs, newContent);
  console.log("DEBUG: weekdata.js written");
}

// --- Last.fm fetchers (with retries & partial fallback) ---
async function fetchScrobbles(from, to) {
  let page = 1, totalPages = 1;
  const all = [];

  while (page <= totalPages) {
    console.log(`DEBUG: Fetching Last.fm page ${page}`);
    const url =
      `https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks` +
      `&user=${encodeURIComponent(USER)}` +
      `&api_key=${API_KEY}` +
      `&format=json` +
      `&from=${from}&to=${to}` +
      `&limit=200&page=${page}`;

    try {
      const j = await fetchJSONWithRetry(url);

      const arr = j.recenttracks?.track || [];
      for (const t of arr) if (t.date) all.push(t);

      const attr = j.recenttracks?.["@attr"];
      totalPages = attr ? parseInt(attr.totalPages || "1", 10) : 1;
      page++;
    } catch (err) {
      if (ALLOW_PARTIAL && all.length > 0) {
        console.warn(`WARN: Using partial scrobbles due to upstream errors after page ${page}: ${err.message}`);
        break;
      }
      throw err;
    }
  }

  console.log("DEBUG: Total scrobbles fetched =", all.length);
  return all;
}

function aggregatePlays(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const title = t.name;
    const artist = t.artist?.["#text"] || "";
    theconst album = t.album?.["#text"] || "Unknown";
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

    const weekData = loadWeekData(WEEKDATA_PATH);
    const preKeys = Object.keys(weekData).map(Number).sort((a,b)=>a-b);
    const preCount = preKeys.length;
    console.log("DEBUG: Weeks present BEFORE =", preKeys);

    const maxExisting = preKeys[preCount - 1];
    const targetWeek = Number.isInteger(TARGET_WEEK) ? TARGET_WEEK : maxExisting + 1;
    const overwriting = Number.isInteger(TARGET_WEEK);
    console.log(`DEBUG: Target week=${targetWeek} Mode=${overwriting ? "OVERWRITE" : "APPEND"}`);

    const { from, to } = lastFridayToThursdayRange();

    let scrobbles = [];
    scrobbles = await fetchScrobbles(from, to);

    const plays = aggregatePlays(scrobbles).sort((a,b)=>b.plays - a.plays);

    // Build song history map
    const songHistory = new Map();
    for (const [w, entries] of Object.entries(weekData)) {
      for (const e of entries) {
        songHistory.set(getKey(e.title, e.artist), {
          totalSales: e.totalSales,
          weeks: e.weeks,
          lastRank: e.rank,
          peak: e.peak,
          last_seen: parseInt(w, 10),
        });
      }
    }

    // Compute provisional stats
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

    const withPoints = provisional.map(e => ({
      ...e,
      points: calcPoints(e.sales, e.streams, e.radio, maxSales, maxStreams, maxRadio)
    })).sort((a,b)=>b.points - a.points);

    const prevWeek = overwriting ? targetWeek - 1 : maxExisting;
    const entries = withPoints.slice(0, MAX_ENTRIES).map((e,i) => {
      const rank = i + 1;
      let movement = "NEW";
      if (e.hist) {
        if (e.hist.last_seen !== prevWeek) movement = "RE";
        else if (rank < e.hist.lastRank) movement = "UP";
        else if (rank > e.hist.lastRank) movement = "DOWN";
        else movement = "—";
      }
      const totalSales = (e.hist?.totalSales || 0) + e.sales;
      const peak = e.hist ? Math.min(rank, e.hist.peak) : rank;
      return {
        rank, movement, title: e.title, artist: e.artist, album: e.album,
        plays: e.plays, sales: e.sales, totalSales, weeks: e.weeks, peak,
        streams: Math.trunc(e.streams), radio: e.radio, points: e.points
      };
    });

    console.log("DEBUG: Final entries prepared =", entries.length);

    if (DRY_RUN) {
      console.log("=== DRY RUN PREVIEW ===");
      for (const e of entries.slice(0, 20))
        console.log(`#${e.rank} ${e.title} — ${e.artist} (${e.points} pts)`);
      console.log("=== END PREVIEW ===");
      return;
    }

    if (entries.length === 0) {
      if (ALLOW_PARTIAL) {
        console.warn("WARN: Zero entries produced; skipping write due to ALLOW_PARTIAL");
        return;
      }
      throw new Error("No entries produced for this window");
    }

    const postTest = { ...weekData, [targetWeek]: entries };
    const postKeys = Object.keys(postTest).map(Number).sort((a,b)=>a-b);
    if (postKeys.length < preCount)
      throw new Error("Refusing to shrink week count!");

    saveWeekData(WEEKDATA_PATH, { [targetWeek]: entries }, preCount);

    // Commit/push
    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync(`git add ${WEEKDATA_PATH}`);
    execSync(`sh -lc 'git commit -m "${overwriting ? "overwrite" : "add"} week ${targetWeek} (Last.fm)" || echo "No changes to commit"'`);
    execSync("git push");
    console.log("SUCCESS: Week", targetWeek, overwriting ? "overwritten" : "added");
  } catch (err) {
    console.error("FATAL ERROR:", err.message);
    process.exitCode = 1;
  }
}

// --- Run when executed directly ---
if (require.main === module) handler();

module.exports = { handler };


