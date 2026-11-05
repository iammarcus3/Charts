const fetch = require("node-fetch");

const API_KEY = "ed9c6dcac73ea1adcd3750efeea9b822";
const LASTFM_USER = process.env.LASTFM_USER || "IAMMARCUS3";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = "iammarcus3";
const REPO_NAME = "Charts";
const BRANCH = "main";

const FILE_PATH =
  "raw/listening_history/zerocharts-scrobbles-iammarcus3 (1) (2).json";

const GITHUB_API =
  `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(FILE_PATH).replace(/%2F/g, "/")}`;

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTimestamp(scrobble) {
  const raw = scrobble?.date?.uts;
  if (raw === undefined || raw === null || raw === "") return null;

  const timestamp = Number(raw);
  return Number.isFinite(timestamp) && timestamp >= 0
    ? timestamp
    : null;
}

function scrobbleKey(scrobble) {
  const artist =
    scrobble?.artist?.["#text"] ||
    scrobble?.artist?.name ||
    scrobble?.artist ||
    "";

  const track = scrobble?.name || scrobble?.track || "";
  const album = scrobble?.album?.["#text"] || scrobble?.album || "";
  const timestamp = getTimestamp(scrobble);

  return [
    normalize(artist),
    normalize(track),
    normalize(album),
    timestamp === null ? "" : timestamp,
  ].join("|");
}

const RETRYABLE_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubRequest(url, options = {}) {
  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN environment variable.");
  }

  let lastError;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(options.headers || {}),
        },
      });

      const text = await response.text();
      let data = {};

      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        if (response.ok) {
          throw new Error(`GitHub returned invalid JSON (HTTP ${response.status}).`);
        }
      }

      if (response.ok) return data;

      const error = new Error(
        `GitHub request failed (${response.status}): ${
          data.message || text || "Unknown error"
        }`
      );
      error.status = response.status;

      if (!RETRYABLE_GITHUB_STATUSES.has(response.status) || attempt === 3) {
        throw error;
      }

      lastError = error;
    } catch (error) {
      if (error.status && !RETRYABLE_GITHUB_STATUSES.has(error.status)) {
        throw error;
      }
      if (attempt === 3) throw error;
      lastError = error;
    }

    const waitMs = Math.min(8000, 1000 * (2 ** attempt));
    console.warn(`GitHub API request failed; retrying in ${waitMs}ms (attempt ${attempt + 1}/4).`);
    await delay(waitMs);
  }

  throw lastError || new Error("GitHub API request failed after retries.");
}

async function readExistingFile() {
  try {
    const data = await githubRequest(
      `${GITHUB_API}?ref=${encodeURIComponent(BRANCH)}`
    );

    if (data.type !== "file") {
      throw new Error("The specified GitHub path is not a file.");
    }

    let content;

    if (data.content) {
      content = Buffer.from(data.content, "base64").toString("utf8");
    } else if (data.download_url) {
      const response = await fetch(data.download_url);

      if (!response.ok) {
        throw new Error(
          `Could not download the existing file (HTTP ${response.status}).`
        );
      }

      content = await response.text();
    } else {
      throw new Error("GitHub returned no file content or download URL.");
    }

    return {
      sha: data.sha,
      data: JSON.parse(content),
    };
  } catch (error) {
    if (error.message.includes("(404)")) {
      return {
        sha: null,
        data: {
          scrobbles: [],
          total: 0,
        },
      };
    }

    throw error;
  }
}

async function fetchLastFmPage(page, from) {
  const params = new URLSearchParams({
    method: "user.getRecentTracks",
    user: LASTFM_USER,
    api_key: API_KEY,
    format: "json",
    limit: "200",
    page: String(page),
  });

  if (from !== null) {
    params.set("from", String(from));
  }

  const response = await fetch(
    `https://ws.audioscrobbler.com/2.0/?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(`Last.fm request failed (HTTP ${response.status}).`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Last.fm error ${data.error}: ${data.message}`);
  }

  const recentTracks = data?.recenttracks;

  if (!recentTracks || !recentTracks.track) {
    throw new Error("Last.fm returned an unexpected response.");
  }

  const tracks = Array.isArray(recentTracks.track)
    ? recentTracks.track
    : [recentTracks.track];

  return {
    tracks,
    totalPages: Math.max(
      1,
      Number(recentTracks["@attr"]?.totalPages) || 1
    ),
  };
}

async function fetchNewScrobbles(from) {
  const results = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await fetchLastFmPage(page, from);

    totalPages = result.totalPages;

    for (const track of result.tracks) {
      // Do not import the currently playing track.
      if (track?.["@attr"]?.nowplaying === "true") continue;

      if (getTimestamp(track) === null) continue;

      results.push(track);
    }

    page += 1;

    if (page > totalPages) break;

    // Safety limit to avoid an accidental runaway import.
    if (page > 10000) {
      throw new Error("Stopped because the Last.fm page limit was exceeded.");
    }
  } while (page <= totalPages);

  return results;
}

async function saveToGitHub(payload, sha) {
  const makeBody = (data, currentSha) => {
    const body = {
      message: "chore: update Last.fm listening history",
      content: Buffer.from(
        JSON.stringify(data, null, 2),
        "utf8"
      ).toString("base64"),
      branch: BRANCH,
    };
    if (currentSha) body.sha = currentSha;
    return body;
  };

  const put = (body) => githubRequest(GITHUB_API, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  try {
    return await put(makeBody(payload, sha));
  } catch (error) {
    // A 5xx response can be returned after GitHub has already accepted a PUT.
    // Re-read the file before retrying so an ambiguous response cannot create
    // a duplicate write or overwrite a newer concurrent update.
    const recoverable = error.status === 409 || RETRYABLE_GITHUB_STATUSES.has(error.status);
    if (!recoverable) throw error;

    const latest = await readExistingFile();
    if (!Array.isArray(latest.data.scrobbles)) throw error;

    const latestKeys = new Set(latest.data.scrobbles.map(scrobbleKey));
    const payloadKeys = payload.scrobbles.map(scrobbleKey);

    if (payloadKeys.every((key) => latestKeys.has(key))) {
      console.log("GitHub already contains the complete Last.fm history payload.");
      return latest;
    }

    // Merge any records written by another run before retrying with the fresh SHA.
    const mergedScrobbles = [...latest.data.scrobbles];
    for (const scrobble of payload.scrobbles) {
      const key = scrobbleKey(scrobble);
      if (!latestKeys.has(key)) {
        latestKeys.add(key);
        mergedScrobbles.push(scrobble);
      }
    }
    mergedScrobbles.sort((a, b) => (getTimestamp(a) ?? 0) - (getTimestamp(b) ?? 0));

    const timestamps = mergedScrobbles
      .map(getTimestamp)
      .filter((timestamp) => timestamp !== null);
    const recoveredPayload = {
      ...latest.data,
      ...payload,
      scrobbles: mergedScrobbles,
      total: mergedScrobbles.length,
      range: {
        ...(latest.data.range || {}),
        from: timestamps.length ? new Date(Math.min(...timestamps) * 1000).toISOString() : null,
        to: timestamps.length ? new Date(Math.max(...timestamps) * 1000).toISOString() : null,
      },
      exported_at: payload.exported_at,
    };

    console.warn("Retrying Last.fm history save using the latest GitHub file SHA.");
    return put(makeBody(recoveredPayload, latest.sha));
  }
}

async function main() {
  const { sha, data: existing } = await readExistingFile();

  if (!Array.isArray(existing.scrobbles)) {
    throw new Error(
      "The existing JSON file does not contain a scrobbles array."
    );
  }

  const existingScrobbles = existing.scrobbles;
  const timestamps = existingScrobbles
    .map(getTimestamp)
    .filter((timestamp) => timestamp !== null);

  // Fetch one second before the newest scrobble to catch overlapping records.
  // This also works for multiple plays recorded at the same second.
  const latestTimestamp =
    timestamps.length > 0 ? Math.max(...timestamps) : null;

  const fetchFrom =
    latestTimestamp === null
      ? Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60
      : Math.max(0, latestTimestamp - 1);

  const fetchedScrobbles = await fetchNewScrobbles(fetchFrom);

  const seen = new Set(existingScrobbles.map(scrobbleKey));
  const newScrobbles = [];

  for (const scrobble of fetchedScrobbles) {
    const key = scrobbleKey(scrobble);

    if (seen.has(key)) continue;

    seen.add(key);
    newScrobbles.push(scrobble);
  }

  const allScrobbles = [...existingScrobbles, ...newScrobbles];

  allScrobbles.sort((a, b) => {
    return (getTimestamp(a) ?? 0) - (getTimestamp(b) ?? 0);
  });

  const validTimestamps = allScrobbles
    .map(getTimestamp)
    .filter((timestamp) => timestamp !== null);

  const payload = {
    ...existing,
    scrobbles: allScrobbles,
    total: allScrobbles.length,
    range: {
      ...(existing.range || {}),
      from:
        validTimestamps.length > 0
          ? new Date(Math.min(...validTimestamps) * 1000).toISOString()
          : null,
      to:
        validTimestamps.length > 0
          ? new Date(Math.max(...validTimestamps) * 1000).toISOString()
          : null,
    },
    exported_at: new Date().toISOString(),
  };

  if (newScrobbles.length === 0) {
    console.log("No new scrobbles found. GitHub file was not changed.");
    console.log(`Existing scrobbles: ${existingScrobbles.length}`);
    return;
  }

  await saveToGitHub(payload, sha);

  console.log("Last.fm history successfully updated!");
  console.log(`Previously stored: ${existingScrobbles.length}`);
  console.log(`New scrobbles added: ${newScrobbles.length}`);
  console.log(`Total scrobbles: ${allScrobbles.length}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Last.fm sync failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  normalize,
  getTimestamp,
  scrobbleKey,
  fetchNewScrobbles,
  main,
};
