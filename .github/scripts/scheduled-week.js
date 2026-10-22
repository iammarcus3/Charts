const fetch = require("node-fetch");

// --- Settings ---
const API_KEY = "ed9c6dcac73ea1adcd3750efeea9b822";
const USER = "IAMMARCUS3";
const GH_TOKEN   = process.env.GITHUB_TOKEN;
const GH_REPO    = process.env.GITHUB_REPO || "iammarcus3/Charts";
const GH_BRANCH  = process.env.GITHUB_BRANCH || "main";

// The exact path to your raw listening history file
const RAW_DATA_PATH = "raw/listening_history/zerocharts-scrobbles-iammarcus3 (1) (2).json";

async function githubGetFile() {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${RAW_DATA_PATH}?ref=${GH_BRANCH}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${GH_TOKEN}` }});
  
  if (!res.ok) {
    throw new Error(`GitHub get file failed: ${res.status} ${res.statusText}`);
  }
  
  const j = await res.json();
  const content = Buffer.from(j.content, j.encoding).toString("utf-8");
  return { data: JSON.parse(content), sha: j.sha };
}

async function githubUpdateFile(newContent, sha, message) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${RAW_DATA_PATH}`;
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
    throw new Error(`GitHub update failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

async function fetchNewScrobbles(fromTimestamp) {
  let page = 1;
  let totalPages = 1;
  const newScrobbles = [];

  while (page <= totalPages) {
    console.log(`Fetching Last.fm page ${page}/${totalPages}...`);
    // limit=200 is the max allowed by Last.fm
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks&user=${USER}&api_key=${API_KEY}&format=json&from=${fromTimestamp}&limit=200&page=${page}`;
    
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Last.fm error ${res.status}`);
    
    const j = await res.json();
    const tracks = j.recenttracks?.track || [];
    
    for (const t of tracks) {
      // Ignore "currently playing" tracks which lack a timestamp
      if (t.date && t.date.uts) {
        newScrobbles.push({
          artist: t.artist?.["#text"] || "Unknown Artist",
          track: t.name || "Unknown Track",
          album: t.album?.["#text"] || "Unknown Album",
          timestamp: parseInt(t.date.uts, 10)
        });
      }
    }
    
    const attr = j.recenttracks?.["@attr"];
    totalPages = attr ? parseInt(attr.totalPages || "1", 10) : 1;
    page++;
  }
  
  // Last.fm returns newest first, so we reverse it to maintain chronological order
  return newScrobbles.reverse();
}

async function handler() {
  try {
    console.log("Starting raw data update job...");

    // 1. Load the existing JSON from GitHub
    const { data, sha } = await githubGetFile();
    const existingScrobbles = data.scrobbles || [];
    
    if (existingScrobbles.length === 0) {
      console.log("No existing scrobbles found in the file.");
      return;
    }

    // 2. Determine the most recent timestamp to
