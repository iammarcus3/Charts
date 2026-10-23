
(() => {
  "use strict";

  /*
   * YOURHOT100 — STATS PARADISE
   *
   * Source of truth:
   * vault/tracks.json
   * vault/albums.json
   * vault/artists.json
   * vault/listening_history.jsonl
   *
   * Song and album rankings preserve the established YourHot100 model:
   * weekly activity Top 100 -> rank-score units -> derived-units ranking.
   *
   * Album eligibility and official album debut are distinct:
   * - Eligibility: 3 distinct canonical catalogue tracks.
   * - Official debut: first week with 3 distinct album tracks on the Hot 100.
   * - Debut is a one-time activation.
   * - After activation, the normal album model applies each week.
   *
   * Tables show at most 250 rows, but all history is used for calculations.
   * Activity counts and rank-score inputs are never displayed or exported.
   */

  const CONFIG = Object.freeze({
    MIN_ALBUM_TRACKS: 3,
    HOT100_SIZE: 100,
    TABLE_LIMIT: 250,
    SONG_UNIT_FACTOR: 50000,
    ALBUM_UNIT_FACTOR: 5000,
    RANK_UNIT_FACTOR: 500,
    WEEK_MS: 7 * 24 * 60 * 60 * 1000
  });

  const $ = selector => document.querySelector(selector);

  const ui = {
    status: $("#data-status"),
    archiveDescription: $("#archive-description"),
    summary: $("#summary-cards"),
    nav: $("#section-nav"),
    search: $("#search-input"),
    timeMode: $("#time-mode"),
    year: $("#year-select"),
    sort: $("#sort-select"),
    direction: $("#sort-direction"),
    customDates: $("#custom-date-filters"),
    dateFrom: $("#date-from"),
    dateTo: $("#date-to"),
    title: $("#content-title"),
    description: $("#content-description"),
    content: $("#view-content"),
    error: $("#error-container"),
    reset: $("#reset-filters"),
    export: $("#export-csv"),
    periodSwitch: $("#period-switch")
  };

  const state = {
    currentView: "overview",
    periodMode: "year",
    sortTouched: false,

    tracks: new Map(),
    albums: new Map(),
    artists: new Map(),
    events: [],

    albumTrackMap: new Map(),
    trackToAlbums: new Map(),
    eligibleAlbumIds: new Set(),
    debutedAlbumIds: new Set(),
    albumDebuts: new Map(),

    snapshots: [],
    songRecords: [],
    albumRecords: [],
    artistRecords: [],
    weeklyRecords: [],
    numberOneRecords: [],
    debutRecords: [],
    exitRecords: [],
    allRecords: [],

    visibleRows: [],
    visibleColumns: [],
    years: [],

    latestWeekStart: null,
    earliestWeekStart: null,
    currentSixMonthStart: null,
    previousSixMonthStart: null,
    previousSixMonthEnd: null
  };

  const VIEW_INFO = {
    overview: {
      title: "Overview",
      description: "The biggest achievements across your available chart history."
    },
    songs: {
      title: "Song Archive",
      description: "Period units sold, career units sold, peaks and chart careers."
    },
    albums: {
      title: "Album Archive",
      description: "Album chart careers, plus the number of tracks from each album that reached No. 1 or the Top 10."
    },
    artists: {
      title: "Artist Archive",
      description: "Period and career units, credited songs, lead albums and rank movement."
    },
    weeks: {
      title: "Weekly History",
      description: "Observed Friday–Thursday chart snapshots, without invented missing weeks."
    },
    numberones: {
      title: "No. 1 Archive",
      description: "Recorded song and album No. 1 achievements."
    },
    debuts: {
      title: "Album Debuts",
      description: "First official debut week for each album only. Album re-entries are not included; eligible albums without an official debut remain in the Album Archive."
    },
    periods: {
      title: "Yearly & Monthly Performance",
      description: "Units sold and chart achievements aggregated over observed chart weeks."
    },
    records: {
      title: "The Record Book",
      description: "Dynamically calculated all-time song, album and artist achievements."
    }
  };

  const SORT_OPTIONS = {
    overview: [
      ["title", "Title"]
    ],
    songs: [
      ["periodUnitsSold", "Units sold"],
      ["unitsSold", "Career units sold"],
      ["latestRank", "Latest position"],
      ["peak", "Peak position"],
      ["weeksOnChart", "Weeks charted"],
      ["weeksAtNo1", "No. 1 weeks"],
      ["weeksTop10", "Top 10 weeks"],
      ["debutTs", "Debut date"],
      ["title", "Song title"],
      ["artist", "Artist"]
    ],
    albums: [
      ["periodUnitsSold", "Units sold"],
      ["unitsSold", "Career units sold"],
      ["latestRank", "Latest position"],
      ["peak", "Peak position"],
      ["weeksOnChart", "Weeks charted"],
      ["numberOneTracks", "No. 1 tracks"],
      ["top10Tracks", "Top 10 tracks"],
      ["weeksAtNo1", "No. 1 weeks"],
      ["reentryCount", "Re-entries"],
      ["trackCount", "Distinct tracks"],
      ["importTs", "Import date"],
      ["releaseTs", "Release date"],
      ["debutTs", "Official debut date"],
      ["firstRankedTs", "First Top 100 appearance"],
      ["title", "Album title"],
      ["artist", "Lead artist"]
    ],
    artists: [
      ["periodUnitsSold", "Units sold"],
      ["unitsSold", "Career units sold"],
      ["recentUnits", "Latest six-month units"],
      ["songNo1Count", "Distinct No. 1 songs"],
      ["songCount", "Songs charted"],
      ["albumCount", "Lead albums charted"],
      ["no1Weeks", "No. 1 weeks"],
      ["currentSixMonthRank", "Recent leaderboard position"],
      ["name", "Artist name"]
    ],
    weeks: [
      ["dateTs", "Chart-week date"],
      ["songCount", "Songs charted"],
      ["albumCount", "Albums charted"],
      ["newEntries", "New entries"],
      ["reentries", "Re-entries"]
    ],
    numberones: [
      ["dateTs", "Chart-week date"],
      ["songUnits", "Song units sold"],
      ["albumUnits", "Album units sold"],
      ["songTitle", "Song title"],
      ["albumTitle", "Album title"]
    ],
    debuts: [
      ["dateTs", "Official debut date"],
      ["status", "Debut status"],
      ["rank", "Debut position"],
      ["unitsSold", "Debut-week units"],
      ["title", "Album"],
      ["artist", "Lead artist"]
    ],
    periods: [
      ["unitsSold", "Total units sold"],
      ["songUnitsSold", "Song units sold"],
      ["albumUnitsSold", "Album units sold"],
      ["chartWeeks", "Observed chart weeks"],
      ["songAppearances", "Song appearances"],
      ["albumAppearances", "Album appearances"],
      ["dateTs", "Period"],
      ["period", "Year / month"]
    ],
    records: [
      ["valueNumber", "Record value"],
      ["name", "Record"],
      ["title", "Record holder"]
    ]
  };

  /* ---------------------------------------------------------------
     GENERAL HELPERS
  ---------------------------------------------------------------- */

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function safeString(value, fallback = "Unknown") {
    const result = String(value ?? "").trim();
    return result || fallback;
  }

  function unique(values) {
    return [...new Set(
      values
        .filter(value => value !== null && value !== undefined && value !== "")
        .map(value => String(value))
    )];
  }

  function asArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
  }

  function idsFrom(value) {
    return unique(asArray(value).map(item => {
      if (item == null) return null;

      if (typeof item === "object") {
        return item.id ??
          item.track_id ??
          item.album_id ??
          item.artist_id ??
          null;
      }

      return item;
    }));
  }

  function parseMap(data) {
    if (Array.isArray(data)) {
      return new Map(
        data
          .filter(item => item && item.id != null)
          .map(item => [String(item.id), item])
      );
    }

    if (data && typeof data === "object") {
      return new Map(Object.entries(data).map(([id, item]) => [
        String(id),
        item && typeof item === "object"
          ? { ...item, id: String(item.id ?? id) }
          : { id: String(id), value: item }
      ]));
    }

    throw new Error("A Music Vault catalogue file has an unsupported structure.");
  }

  function timestampSeconds(value) {
    if (value && typeof value === "object") {
      value =
        value.uts ??
        value.timestamp ??
        value.played_at ??
        value.date ??
        value.datetime ??
        value["#text"];
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value > 1e12 ? value / 1000 : value);
    }

    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);

      if (Number.isFinite(numeric)) {
        return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
      }

      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }

    return null;
  }

  function getWeekStartMs(seconds) {
    const date = new Date(seconds * 1000);
    date.setUTCHours(0, 0, 0, 0);
    const daysSinceFriday = (date.getUTCDay() + 2) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceFriday);
    return date.getTime();
  }

  function shiftMonthsUTC(timestamp, months) {
    const date = new Date(timestamp);
    const targetDay = date.getUTCDate();

    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);

    const lastDay = new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      0
    )).getUTCDate();

    date.setUTCDate(Math.min(targetDay, lastDay));
    return date.getTime();
  }

  function formatDate(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";

    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  function formatMonth(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";

    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  function dateKey(timestamp) {
    if (!Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  function formatNumber(value) {
    if (value === null || value === undefined || value === "") return "—";

    const number = Number(value);
    if (!Number.isFinite(number)) return "—";

    return Math.round(number).toLocaleString("en-US");
  }

  function formatUnits(value) {
    return formatNumber(value);
  }

  function formatPosition(value) {
    if (value === null || value === undefined || value === "") return "—";

    const number = Number(value);

    if (!Number.isInteger(number) || number < 1 || number > CONFIG.HOT100_SIZE) {
      return "—";
    }

    return `#${number}`;
  }

  function formatLeaderboardPosition(value) {
    if (value === null || value === undefined || value === "") return "—";

    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) return "—";

    return `#${number}`;
  }

  function getName(item) {
    if (!item || typeof item !== "object") return "Unknown";

    return safeString(
      item.name ??
      item.title ??
      item.artist_name ??
      item.track_title
    );
  }

  function getTrackTitle(track) {
    return safeString(
      track?.title ?? track?.name ?? track?.track_title,
      "Unknown Song"
    );
  }

  function getAlbumTitle(album) {
    return safeString(
      album?.title ?? album?.name ?? album?.album_title,
      "Unknown Album"
    );
  }

  function readTimestampFromItem(item, keys) {
    for (const key of keys) {
      if (item && item[key] != null && item[key] !== "") {
        const seconds = timestampSeconds(item[key]);
        if (seconds != null) return seconds * 1000;
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------
     CANONICAL ARTIST AND ALBUM RELATIONSHIPS
  ---------------------------------------------------------------- */

  function getArtistName(id) {
    if (id == null) return "Unknown Artist";

    const rawArtist = state.artists.get(String(id));
    const canonicalId = rawArtist?.canonical_artist_id;
    const artist = canonicalId != null
      ? (state.artists.get(String(canonicalId)) || rawArtist)
      : rawArtist;

    return artist ? getName(artist) : "Unknown Artist";
  }

  function resolveArtistId(value) {
    if (value && typeof value === "object") {
      value = value.id ??
        value.artist_id ??
        value.artistId ??
        value.mbid ??
        value.name ??
        value.artist_name;
    }

    if (value === null || value === undefined || value === "") return null;

    const key = String(value).trim();

    if (state.artists.has(key)) {
      const artist = state.artists.get(key);
      const canonicalId = artist?.canonical_artist_id;
      return canonicalId != null && state.artists.has(String(canonicalId))
        ? String(canonicalId)
        : key;
    }

    const lower = key.toLowerCase();

    for (const [id, artist] of state.artists) {
      const name = String(artist?.name ?? artist?.title ?? "")
        .trim()
        .toLowerCase();
      const aliases = Array.isArray(artist?.aliases) ? artist.aliases : [];
      const aliasMatches = aliases.some(alias =>
        String(alias ?? "").trim().toLowerCase() === lower
      );

      if ((name && name === lower) || aliasMatches) {
        const canonicalId = artist?.canonical_artist_id;
        return canonicalId != null && state.artists.has(String(canonicalId))
          ? String(canonicalId)
          : String(id);
      }
    }

    return null;
  }

  function getTrackArtistIds(track) {
    if (!track) return [];

    const ids = [];

    let rawIds =
      track.artist_ids ??
      track.artists_ids ??
      track.artistIds ??
      track.artist_id_list;

    if (typeof rawIds === "string" && rawIds.trim().startsWith("[")) {
      try {
        rawIds = JSON.parse(rawIds);
      } catch (_) {
        // Continue with the supplied source value.
      }
    }

    asArray(rawIds).forEach(value => {
      const id = resolveArtistId(value);
      if (id && !ids.includes(id)) ids.push(id);
    });

    let credits =
      track.artist_names ??
      track.artists ??
      track.artist_credits ??
      track.artist;

    if (!Array.isArray(credits)) {
      credits = typeof credits === "string"
        ? credits.split(/,\s*|\s+(?:feat\.?|ft\.?|&|x)\s+/i).filter(Boolean)
        : [];
    }

    credits.forEach(value => {
      const id = resolveArtistId(value);
      if (id && !ids.includes(id)) ids.push(id);
    });

    const leadId = resolveArtistId(
      track.primary_artist_id ?? track.artist_id
    );

    if (leadId && !ids.includes(leadId)) ids.unshift(leadId);

    return ids;
  }

  function getTrackArtistNames(track) {
    const ids = getTrackArtistIds(track);
    if (ids.length) return ids.map(getArtistName);

    let credits =
      track?.artist_names ??
      track?.artist_credits ??
      track?.artists ??
      track?.artist;

    if (!Array.isArray(credits)) {
      credits = typeof credits === "string"
        ? credits.split(/,\s*|\s+(?:feat\.?|ft\.?|&|x)\s+/i).filter(Boolean)
        : [];
    }

    const names = credits.map(value => {
      if (value && typeof value === "object") {
        return value.name ?? value.artist_name ?? value.title ?? "";
      }
      return String(value ?? "");
    }).filter(Boolean);

    return names.length ? [...new Set(names)] : ["Unknown Artist"];
  }

  function getLeadAlbumArtistId(album) {
    if (!album) return null;

    const raw = album.primary_artist_id ?? album.artist_id;
    if (raw != null) {
      const id = resolveArtistId(raw);
      if (id) return id;
    }

    return idsFrom(album.artist_ids ?? album.artists)
      .map(resolveArtistId)
      .find(Boolean) ?? null;
  }

  function getTrackAlbumIds(track) {
    if (!track) return [];

    const listed = Array.isArray(track.album_ids)
      ? track.album_ids
      : [];

    if (listed.length) return unique(listed);

    const fallback = track.album_id ?? track.primary_album_id;
    return fallback != null ? [String(fallback)] : [];
  }

  function getTrackIdsFromAlbum(album) {
    if (!album) return [];

    return unique([
      ...idsFrom(album.track_ids),
      ...idsFrom(album.tracks)
    ]).filter(trackId => state.tracks.has(String(trackId)));
  }

  function buildAlbumTrackMap() {
    const albumTrackMap = new Map();
    const trackToAlbums = new Map();

    state.albums.forEach((album, albumId) => {
      albumTrackMap.set(String(albumId), new Set(getTrackIdsFromAlbum(album)));
    });

    state.tracks.forEach((track, trackId) => {
      getTrackAlbumIds(track).forEach(albumId => {
        if (!state.albums.has(String(albumId))) return;

        if (!albumTrackMap.has(String(albumId))) {
          albumTrackMap.set(String(albumId), new Set());
        }

        albumTrackMap.get(String(albumId)).add(String(trackId));
      });
    });

    albumTrackMap.forEach((trackIds, albumId) => {
      trackIds.forEach(trackId => {
        if (!trackToAlbums.has(String(trackId))) {
          trackToAlbums.set(String(trackId), new Set());
        }
        trackToAlbums.get(String(trackId)).add(String(albumId));
      });
    });

    state.albumTrackMap = albumTrackMap;
    state.trackToAlbums = trackToAlbums;
    state.eligibleAlbumIds = new Set();

    // Catalogue eligibility only. It does not imply an official debut.
    albumTrackMap.forEach((trackIds, albumId) => {
      if (trackIds.size >= CONFIG.MIN_ALBUM_TRACKS) {
        state.eligibleAlbumIds.add(String(albumId));
      }
    });
  }

  /* ---------------------------------------------------------------
     ESTABLISHED YOURHOT100 UNITS MODEL
  ---------------------------------------------------------------- */

  function rankScoreForRank(rank) {
    if (rank === 1) return 100;
    if (rank === 2) return 98;

    return Math.max(
      1,
      Math.round(98 - ((rank - 2) * 97 / 98))
    );
  }

  function makeChartEntries(countMap, type, allowedIds = null) {
    const candidates = [];

    countMap.forEach((activityCount, idValue) => {
      const id = String(idValue);

      if (allowedIds && !allowedIds.has(id)) return;
      if (!(Number(activityCount) > 0)) return;

      if (type === "songs") {
        const track = state.tracks.get(id);
        if (!track) return;

        candidates.push({
          id,
          title: getTrackTitle(track),
          artist: getTrackArtistNames(track).join(", "),
          artistIds: getTrackArtistIds(track),
          activityCount: Number(activityCount),
          trackCount: 1
        });
      } else {
        const album = state.albums.get(id);
        if (!album) return;

        const leadArtistId = getLeadAlbumArtistId(album);

        candidates.push({
          id,
          title: getAlbumTitle(album),
          artist: getArtistName(leadArtistId),
          artistIds: leadArtistId ? [leadArtistId] : [],
          leadArtistId,
          activityCount: Number(activityCount),
          trackCount: state.albumTrackMap.get(id)?.size ?? 0
        });
      }
    });

    candidates.sort((a, b) =>
      b.activityCount - a.activityCount ||
      a.title.localeCompare(b.title)
    );

    const selected = candidates.slice(0, CONFIG.HOT100_SIZE);

    selected.forEach((entry, index) => {
      const rankScore = rankScoreForRank(index + 1);
      const factor = type === "songs"
        ? CONFIG.SONG_UNIT_FACTOR
        : CONFIG.ALBUM_UNIT_FACTOR;

      entry.unitsSold =
        entry.activityCount * factor +
        rankScore * CONFIG.RANK_UNIT_FACTOR;
    });

    selected.sort((a, b) =>
      b.unitsSold - a.unitsSold ||
      b.activityCount - a.activityCount ||
      a.title.localeCompare(b.title)
    );

    return selected.map((entry, index) => ({
      id: entry.id,
      title: entry.title,
      artist: entry.artist,
      artistIds: entry.artistIds,
      leadArtistId: entry.leadArtistId ?? null,
      trackCount: entry.trackCount,
      unitsSold: entry.unitsSold,
      rank: index + 1,
      type
    }));
  }

  function calculateAlbumDebutUnits(albumId, albumCounts, debutedIds) {
    const candidates = [];

    albumCounts.forEach((activityCount, idValue) => {
      const id = String(idValue);

      if (!debutedIds.has(id)) return;
      if (!(Number(activityCount) > 0)) return;

      const album = state.albums.get(id);
      if (!album) return;

      candidates.push({
        id,
        title: getAlbumTitle(album),
        activityCount: Number(activityCount)
      });
    });

    candidates.sort((a, b) =>
      b.activityCount - a.activityCount ||
      a.title.localeCompare(b.title)
    );

    const activityIndex = candidates.findIndex(
      item => item.id === String(albumId)
    );

    if (activityIndex < 0 || activityIndex >= CONFIG.HOT100_SIZE) {
      return null;
    }

    return (
      candidates[activityIndex].activityCount * CONFIG.ALBUM_UNIT_FACTOR +
      rankScoreForRank(activityIndex + 1) * CONFIG.RANK_UNIT_FACTOR
    );
  }

  /* ---------------------------------------------------------------
     VAULT LOADING
  ---------------------------------------------------------------- */

  async function fetchVaultFiles() {
    const paths = [
      "vault/tracks.json",
      "vault/albums.json",
      "vault/artists.json",
      "vault/listening_history.jsonl"
    ];

    const responses = await Promise.all(paths.map(path => fetch(path)));

    for (let index = 0; index < responses.length; index++) {
      if (!responses[index].ok) {
        throw new Error(
          `Could not load ${paths[index]} (HTTP ${responses[index].status}). ` +
          "Check the paths and serve the page from the project root."
        );
      }
    }

    state.tracks = parseMap(await responses[0].json());
    state.albums = parseMap(await responses[1].json());
    state.artists = parseMap(await responses[2].json());

    const historyText = await responses[3].text();
    const lines = historyText.split(/\r?\n/).filter(Boolean);
    const events = [];

    for (let index = 0; index < lines.length; index++) {
      try {
        const sourceEvent = JSON.parse(lines[index]);

        const timestamp = timestampSeconds(
          sourceEvent.timestamp ??
          sourceEvent.uts ??
          sourceEvent.played_at ??
          sourceEvent.date ??
          sourceEvent.datetime
        );

        const rawId =
          sourceEvent.track_id ??
          sourceEvent.trackId ??
          sourceEvent.track;

        if (timestamp == null || rawId == null) continue;

        const trackId = String(
          typeof rawId === "object"
            ? rawId.id ?? rawId.track_id ?? ""
            : rawId
        );

        if (!trackId) continue;

        events.push({
          trackId,
          albumId: sourceEvent.album_id ?? sourceEvent.albumId ?? (typeof sourceEvent.album === "object" ? sourceEvent.album?.id : sourceEvent.album),
          timestamp,
          weekStart: getWeekStartMs(timestamp)
        });
      } catch (error) {
        console.warn(
          `Stats Paradise skipped malformed source row ${index + 1}.`,
          error
        );
      }
    }

    state.events = events
      .filter(event => state.tracks.has(event.trackId))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!state.events.length) {
      throw new Error(
        "The history file loaded, but no timestamped records matched canonical tracks."
      );
    }
  }

  /* ---------------------------------------------------------------
     WEEKLY SNAPSHOT CONSTRUCTION
  ---------------------------------------------------------------- */

  function buildChartArchive() {
    const groupedEvents = new Map();

    state.events.forEach(event => {
      if (!groupedEvents.has(event.weekStart)) {
        groupedEvents.set(event.weekStart, []);
      }
      groupedEvents.get(event.weekStart).push(event);
    });

    // Only source-observed weeks are built.
    const weekStarts = [...groupedEvents.keys()].sort((a, b) => a - b);

    if (!weekStarts.length) {
      throw new Error("No chart weeks could be constructed from the source history.");
    }

    state.earliestWeekStart = weekStarts[0];
    state.latestWeekStart = weekStarts[weekStarts.length - 1];

    state.currentSixMonthStart = shiftMonthsUTC(state.latestWeekStart, -6);
    state.previousSixMonthEnd = state.currentSixMonthStart - 1;
    state.previousSixMonthStart = shiftMonthsUTC(state.latestWeekStart, -12);

    state.snapshots = [];
    state.albumDebuts = new Map();
    state.debutedAlbumIds = new Set();

    weekStarts.forEach(weekStart => {
      const events = groupedEvents.get(weekStart) || [];
      const trackCounts = new Map();
      const albumCounts = new Map();

      events.forEach(event => {
        const trackId = String(event.trackId);

        trackCounts.set(
          trackId,
          (trackCounts.get(trackId) || 0) + 1
        );

        // Match index.html and certifications.html: credit a scrobble only
        // to the release attached to that listening event, not every catalogue
        // release that happens to contain the same recording.
        const sourceAlbumId = event.albumId;
        if (sourceAlbumId != null && state.eligibleAlbumIds.has(String(sourceAlbumId))) {
          albumCounts.set(
            String(sourceAlbumId),
            (albumCounts.get(String(sourceAlbumId)) || 0) + 1
          );
        }
      });

      const songs = makeChartEntries(trackCounts, "songs");
      const chartingSongIds = new Set(songs.map(entry => String(entry.id)));

      // One-time activation on the first qualifying simultaneous three-track week.
      // Expanded/deluxe editions belong to the original album family and must not
      // create a second official debut when the parent already debuted or qualifies now.
      const qualifyingAlbumDebuts = [];

      state.eligibleAlbumIds.forEach(albumId => {
        const id = String(albumId);
        if (state.debutedAlbumIds.has(id)) return;

        const trackIds = state.albumTrackMap.get(id) || new Set();
        let simultaneousTracks = 0;
        trackIds.forEach(trackId => {
          if (chartingSongIds.has(String(trackId))) simultaneousTracks++;
        });

        if (simultaneousTracks >= CONFIG.MIN_ALBUM_TRACKS) {
          qualifyingAlbumDebuts.push({ id, simultaneousTracks });
        }
      });

      // Canonicalize edition labels the same way across the entire catalogue.
      // Parenthesized labels are removed, and common unbracketed edition suffixes
      // are normalized too (including "Scary Hours Edition").
      const normalizeAlbumFamilyTitle = value => {
        let title = String(value || "").toLowerCase().replace(/[’']/g, "");
        title = title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
        title = title.replace(/\b(?:scary hours|deluxe|expanded|special|anniversary|bonus tracks?|remaster(?:ed)?|reissue|collector(?:'s)?|complete|legacy|edition|version|reloaded|ep|single)\b/gi, " ");
        return title.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
      };

      const isEditionOf = (editionId, parentId) => {
        if (editionId === parentId) return false;
        const edition = state.albums.get(String(editionId));
        const parent = state.albums.get(String(parentId));
        if (!edition || !parent) return false;

        const editionArtist = getLeadAlbumArtistId(edition);
        const parentArtist = getLeadAlbumArtistId(parent);
        if (!editionArtist || !parentArtist || String(editionArtist) !== String(parentArtist)) return false;

        const normalizedEdition = normalizeAlbumFamilyTitle(getAlbumTitle(edition));
        const normalizedParent = normalizeAlbumFamilyTitle(getAlbumTitle(parent));
        const editionHasReleaseCue = /\b(?:deluxe|expanded|special|anniversary|bonus|remaster(?:ed)?|reissue|collector(?:'s)?|complete|legacy|edition|version|reloaded|scary hours|ep|single|cuffing season)\b/i.test(getAlbumTitle(edition));
        const sameTitleFamily = normalizedEdition === normalizedParent ||
          (editionHasReleaseCue && normalizedEdition.startsWith(normalizedParent + " "));
        if (!normalizedParent || !sameTitleFamily) return false;

        // Matching title alone is not enough: require at least three shared
        // canonical tracks so similarly named but unrelated albums stay separate.
        const editionTracks = state.albumTrackMap.get(String(editionId)) || new Set();
        const parentTracks = state.albumTrackMap.get(String(parentId)) || new Set();
        let sharedTracks = 0;
        editionTracks.forEach(trackId => {
          if (parentTracks.has(String(trackId))) sharedTracks++;
        });
        return sharedTracks >= CONFIG.MIN_ALBUM_TRACKS;
      };

      // Parent albums first; IDs must not determine which edition gets the debut.
      qualifyingAlbumDebuts.sort((a, b) =>
        getAlbumTitle(state.albums.get(a.id)).length -
        getAlbumTitle(state.albums.get(b.id)).length
      );

      qualifyingAlbumDebuts.forEach(candidate => {
        const { id, simultaneousTracks } = candidate;
        const parentAlreadyDebuted = [...state.debutedAlbumIds].some(parentId =>
          isEditionOf(id, String(parentId))
        );
        const parentQualifiesNow = qualifyingAlbumDebuts.some(parent =>
          isEditionOf(id, parent.id)
        );
        if (parentAlreadyDebuted || parentQualifiesNow) return;

        state.debutedAlbumIds.add(id);
        state.albumDebuts.set(id, {
          weekStart,
          simultaneousTracks,
          unitsSold: null,
          rank: null
        });
      });

      // Once activated, no recurring three-track condition is applied.
      const albums = makeChartEntries(
        albumCounts,
        "albums",
        state.debutedAlbumIds
      );

      state.albumDebuts.forEach((activation, albumId) => {
        if (activation.weekStart !== weekStart) return;

        const rankedEntry = albums.find(
          entry => String(entry.id) === String(albumId)
        );

        activation.rank = rankedEntry?.rank ?? null;
        activation.unitsSold = rankedEntry?.unitsSold ??
          calculateAlbumDebutUnits(
            albumId,
            albumCounts,
            state.debutedAlbumIds
          );
      });

      state.snapshots.push({
        weekStart,
        weekEnd: weekStart + CONFIG.WEEK_MS - 1,
        songs,
        albums,
        sourceEventCount: events.length
      });
    });
  }

  /* ---------------------------------------------------------------
     ENTITY AGGREGATION
  ---------------------------------------------------------------- */

  function newEntityRecord(entry, firstWeek) {
    return {
      id: String(entry.id),
      type: entry.type === "albums" ? "Album" : "Song",
      title: entry.title,
      artist: entry.artist,
      artistIds: entry.artistIds || [],
      leadArtistId: entry.leadArtistId || null,

      firstChartDate: firstWeek,
      lastOffset: firstWeek,

      peak: 101,
      peakOffset: null,
      latestRank: null,

      weeksOnChart: 0,
      weeksAtNo1: 0,
      weeksTop10: 0,
      weeksTop20: 0,
      weeksTop40: 0,
      weeksTop50: 0,
      weeksTop100: 0,

      currentChartStreak: 0,
      maxChartStreak: 0,
      currentNo1Streak: 0,
      maxNo1Streak: 0,
      lastNo1Offset: null,

      unitsSold: 0,
      bestWeek: null,
      firstNo1Date: null,
      reentryCount: 0,

      history: [],
      appearances: []
    };
  }

  function calculateCurrentStreak(history) {
    if (!history.length) return 0;

    let streak = 1;

    for (let index = history.length - 1; index > 0; index--) {
      if (
        history[index].weekStart -
        history[index - 1].weekStart !== CONFIG.WEEK_MS
      ) {
        break;
      }
      streak++;
    }

    return streak;
  }

  function findSnapshotOnOrBefore(timestamp) {
    let result = null;

    for (const snapshot of state.snapshots) {
      if (snapshot.weekStart <= timestamp) result = snapshot;
      else break;
    }

    return result;
  }

  function aggregateEntityRecords() {
    const songs = new Map();
    const albumChartRecords = new Map();

    const weeklyRecords = [];
    const numberOneRecords = [];
    const songEvents = [];
    const exitRecords = [];

    let previousSnapshot = null;

    for (const snapshot of state.snapshots) {
      const weekStart = snapshot.weekStart;

      const songIdsNow = new Set(snapshot.songs.map(entry => String(entry.id)));
      const albumIdsNow = new Set(snapshot.albums.map(entry => String(entry.id)));

      snapshot.songs.forEach(entry => {
        const id = String(entry.id);
        let record = songs.get(id);
        let entryStatus = null;

        if (!record) {
          record = newEntityRecord(entry, weekStart);
          record.type = "Song";
          songs.set(id, record);
          entryStatus = "Debut";
        } else if (
          previousSnapshot &&
          previousSnapshot.weekStart + CONFIG.WEEK_MS === weekStart &&
          !previousSnapshot.songs.some(oldEntry => String(oldEntry.id) === id)
        ) {
          entryStatus = "Re-entry";
          record.reentryCount++;
        }

        const consecutive = record.lastOffset + CONFIG.WEEK_MS === weekStart;
        record.currentChartStreak = consecutive ? record.currentChartStreak + 1 : 1;
        record.maxChartStreak = Math.max(record.maxChartStreak, record.currentChartStreak);

        record.weeksOnChart++;
        record.lastOffset = weekStart;
        record.latestRank = entry.rank;
        record.unitsSold += Number(entry.unitsSold || 0);

        record.history.push({
          weekStart,
          rank: entry.rank,
          unitsSold: Number(entry.unitsSold || 0)
        });
        record.appearances.push(weekStart);

        if (entry.rank < record.peak) {
          record.peak = entry.rank;
          record.peakOffset = weekStart;
        }

        if (entry.rank === 1) {
          record.weeksAtNo1++;
          record.currentNo1Streak =
            record.lastNo1Offset === weekStart - CONFIG.WEEK_MS
              ? record.currentNo1Streak + 1
              : 1;
          record.lastNo1Offset = weekStart;
          record.maxNo1Streak = Math.max(record.maxNo1Streak, record.currentNo1Streak);

          if (record.firstNo1Date == null) record.firstNo1Date = weekStart;
        } else {
          record.currentNo1Streak = 0;
          record.lastNo1Offset = null;
        }

        if (entry.rank <= 10) record.weeksTop10++;
        if (entry.rank <= 20) record.weeksTop20++;
        if (entry.rank <= 40) record.weeksTop40++;
        if (entry.rank <= 50) record.weeksTop50++;
        if (entry.rank <= 100) record.weeksTop100++;

        if (!record.bestWeek || Number(entry.unitsSold || 0) > record.bestWeek.unitsSold) {
          record.bestWeek = {
            weekStart,
            rank: entry.rank,
            unitsSold: Number(entry.unitsSold || 0)
          };
        }

        if (entryStatus) {
          songEvents.push({
            dateTs: weekStart,
            date: formatDate(weekStart),
            type: "Song",
            status: entryStatus,
            title: entry.title,
            artist: entry.artist,
            rank: entry.rank,
            unitsSold: entry.unitsSold,
            id
          });
        }
      });

      snapshot.albums.forEach(entry => {
        const id = String(entry.id);
        let record = albumChartRecords.get(id);
        let entryStatus = null;

        if (!record) {
          record = newEntityRecord(entry, weekStart);
          record.type = "Album";
          albumChartRecords.set(id, record);
          entryStatus = "First Top 100 appearance";
        } else if (
          previousSnapshot &&
          previousSnapshot.weekStart + CONFIG.WEEK_MS === weekStart &&
          !previousSnapshot.albums.some(oldEntry => String(oldEntry.id) === id)
        ) {
          entryStatus = "Re-entry";
          record.reentryCount++;
        }

        const consecutive = record.lastOffset + CONFIG.WEEK_MS === weekStart;
        record.currentChartStreak = consecutive ? record.currentChartStreak + 1 : 1;
        record.maxChartStreak = Math.max(record.maxChartStreak, record.currentChartStreak);

        record.weeksOnChart++;
        record.lastOffset = weekStart;
        record.latestRank = entry.rank;
        record.unitsSold += Number(entry.unitsSold || 0);

        record.history.push({
          weekStart,
          rank: entry.rank,
          unitsSold: Number(entry.unitsSold || 0)
        });
        record.appearances.push(weekStart);

        if (entry.rank < record.peak) {
          record.peak = entry.rank;
          record.peakOffset = weekStart;
        }

        if (entry.rank === 1) {
          record.weeksAtNo1++;
          record.currentNo1Streak =
            record.lastNo1Offset === weekStart - CONFIG.WEEK_MS
              ? record.currentNo1Streak + 1
              : 1;
          record.lastNo1Offset = weekStart;
          record.maxNo1Streak = Math.max(record.maxNo1Streak, record.currentNo1Streak);

          if (record.firstNo1Date == null) record.firstNo1Date = weekStart;
        } else {
          record.currentNo1Streak = 0;
          record.lastNo1Offset = null;
        }

        if (entry.rank <= 10) record.weeksTop10++;
        if (entry.rank <= 20) record.weeksTop20++;
        if (entry.rank <= 40) record.weeksTop40++;
        if (entry.rank <= 50) record.weeksTop50++;
        if (entry.rank <= 100) record.weeksTop100++;

        if (!record.bestWeek || Number(entry.unitsSold || 0) > record.bestWeek.unitsSold) {
          record.bestWeek = {
            weekStart,
            rank: entry.rank,
            unitsSold: Number(entry.unitsSold || 0)
          };
        }

      });

      // Only assert exits between adjacent observed calendar weeks.
      if (
        previousSnapshot &&
        previousSnapshot.weekStart + CONFIG.WEEK_MS === weekStart
      ) {
        previousSnapshot.songs.forEach(entry => {
          const id = String(entry.id);
          if (!songIdsNow.has(id)) {
            exitRecords.push({
              dateTs: weekStart,
              date: formatDate(weekStart),
              type: "Song",
              status: "Exit",
              title: entry.title,
              artist: entry.artist,
              rank: null,
              unitsSold: entry.unitsSold,
              id
            });
          }
        });

        previousSnapshot.albums.forEach(entry => {
          const id = String(entry.id);
          if (!albumIdsNow.has(id)) {
            exitRecords.push({
              dateTs: weekStart,
              date: formatDate(weekStart),
              type: "Album",
              status: "Exit",
              title: entry.title,
              artist: entry.artist,
              rank: null,
              unitsSold: entry.unitsSold,
              id
            });
          }
        });
      }

      const no1Song = snapshot.songs.find(entry => entry.rank === 1) || null;
      const no1Album = snapshot.albums.find(entry => entry.rank === 1) || null;

      const songEntryEventsThisWeek = songEvents.filter(event => event.dateTs === weekStart);

      weeklyRecords.push({
        dateTs: weekStart,
        date: formatDate(weekStart),
        year: new Date(weekStart).getUTCFullYear(),
        songCount: snapshot.songs.length,
        albumCount: snapshot.albums.length,
        newEntries: songEntryEventsThisWeek.filter(event => event.status === "Debut").length,
        reentries: songEntryEventsThisWeek.filter(event => event.status === "Re-entry").length,
        topSong: no1Song,
        topAlbum: no1Album,
        songUnits: no1Song?.unitsSold ?? null,
        albumUnits: no1Album?.unitsSold ?? null,
        songs: snapshot.songs,
        albums: snapshot.albums
      });

      if (no1Song || no1Album) {
        numberOneRecords.push({
          dateTs: weekStart,
          date: formatDate(weekStart),
          songTitle: no1Song?.title ?? "No qualifying song",
          songArtist: no1Song?.artist ?? "—",
          songId: no1Song?.id ?? null,
          songUnits: no1Song?.unitsSold ?? null,
          albumTitle: no1Album?.title ?? "No qualifying album",
          albumArtist: no1Album?.artist ?? "—",
          albumId: no1Album?.id ?? null,
          albumUnits: no1Album?.unitsSold ?? null
        });
      }

      previousSnapshot = snapshot;
    }

    const latestSnapshot = state.snapshots[state.snapshots.length - 1];

    const latestSongEntries = new Map(
      (latestSnapshot?.songs || []).map(entry => [String(entry.id), entry])
    );

    const latestAlbumEntries = new Map(
      (latestSnapshot?.albums || []).map(entry => [String(entry.id), entry])
    );

    state.songRecords = [...songs.values()].map(record => {
      const track = state.tracks.get(String(record.id));
      const firstPeakIndex = record.history.findIndex(entry => entry.rank === record.peak);

      return {
        ...record,
        type: "Song",
        artist: getTrackArtistNames(track).join(", ") || record.artist,
        artistIds: getTrackArtistIds(track),
        debutDate: formatDate(record.firstChartDate),
        debutTs: record.firstChartDate,
        peakDate: formatDate(record.peakOffset),
        lastDate: formatDate(record.lastOffset),
        latestRank: latestSongEntries.get(String(record.id))?.rank ?? null,
        firstNo1Date: record.firstNo1Date == null ? "—" : formatDate(record.firstNo1Date),
        currentChartStreak: calculateCurrentStreak(record.history),
        officialDebuted: true,
        recentHistory: record.history
      };
    });

    const songRecordById = new Map(state.songRecords.map(record => [String(record.id), record]));
    const albumTrackAchievements = new Map();

    state.eligibleAlbumIds.forEach(albumId => {
      albumTrackAchievements.set(String(albumId), { no1Tracks: 0, top10Tracks: 0 });
    });

    state.trackToAlbums.forEach((albumIds, trackId) => {
      const songRecord = songRecordById.get(String(trackId));
      if (!songRecord || songRecord.peak == null) return;

      albumIds.forEach(albumId => {
        const achievement = albumTrackAchievements.get(String(albumId));
        if (!achievement) return;
        if (songRecord.peak === 1) achievement.no1Tracks++;
        if (songRecord.peak <= 10) achievement.top10Tracks++;
      });
    });

    state.albumRecords = [...state.eligibleAlbumIds].map(albumId => {
      const id = String(albumId);
      const album = state.albums.get(id);
      const chartRecord = albumChartRecords.get(id) || null;
      const activation = state.albumDebuts.get(id) || null;
      const albumHistory = chartRecord?.history || [];

      const hasRankedDebutWeek = activation
        ? albumHistory.some(item => item.weekStart === activation.weekStart)
        : false;

      const extraDebutUnits = activation && !hasRankedDebutWeek
        ? (activation.unitsSold == null ? 0 : Number(activation.unitsSold))
        : 0;

      const careerUnits = chartRecord
        ? chartRecord.unitsSold + extraDebutUnits
        : activation?.unitsSold ?? null;

      const trackCount = state.albumTrackMap.get(id)?.size ?? 0;
      const latestEntry = latestAlbumEntries.get(id) || null;
      const firstRankedTs = chartRecord?.firstChartDate ?? null;
      const firstPeakIndex = chartRecord
        ? chartRecord.history.findIndex(item => item.rank === chartRecord.peak)
        : -1;

      let status;

      if (!activation) status = "Eligible · not debuted";
      else if (latestEntry) status = "Debuted · currently ranked";
      else if (chartRecord) status = "Debuted · not currently ranked";
      else status = "Debuted · no Top 100 appearance";

      return {
        id,
        type: "Album",
        title: getAlbumTitle(album),
        artist: getArtistName(getLeadAlbumArtistId(album)),
        leadArtistId: getLeadAlbumArtistId(album),

        eligible: true,
        officialDebuted: Boolean(activation),
        status,
        trackCount,
        numberOneTracks: albumTrackAchievements.get(id)?.no1Tracks ?? 0,
        top10Tracks: albumTrackAchievements.get(id)?.top10Tracks ?? 0,

        importTs: readTimestampFromItem(album, ["imported_at", "import_date", "added_at", "created_at"]),
        releaseTs: readTimestampFromItem(album, ["release_date", "released", "first_release_date", "releaseDate"]),
        importDate: formatDate(readTimestampFromItem(album, ["imported_at", "import_date", "added_at", "created_at"])),
        releaseDate: formatDate(readTimestampFromItem(album, ["release_date", "released", "first_release_date", "releaseDate"])),

        debutDate: activation ? formatDate(activation.weekStart) : "Not debuted",
        debutTs: activation?.weekStart ?? null,
        debutRank: activation?.rank ?? null,
        debutUnits: activation?.unitsSold ?? null,
        qualifyingTracksAtDebut: activation?.simultaneousTracks ?? null,

        firstRankedDate: firstRankedTs == null ? "—" : formatDate(firstRankedTs),
        firstRankedTs,

        latestRank: latestEntry?.rank ?? null,
        peak: chartRecord?.weeksOnChart ? chartRecord.peak : null,
        peakOffset: chartRecord?.peakOffset ?? null,
        peakDate: chartRecord?.peakOffset == null ? "—" : formatDate(chartRecord.peakOffset),
        firstNo1Date: chartRecord?.firstNo1Date == null ? "—" : formatDate(chartRecord.firstNo1Date),
        firstNo1Ts: chartRecord?.firstNo1Date ?? null,

        lastOffset: chartRecord?.lastOffset ?? null,
        lastDate: chartRecord?.lastOffset == null ? "—" : formatDate(chartRecord.lastOffset),

        weeksOnChart: chartRecord?.weeksOnChart ?? 0,
        weeksAtNo1: chartRecord?.weeksAtNo1 ?? 0,
        weeksTop10: chartRecord?.weeksTop10 ?? 0,
        weeksTop20: chartRecord?.weeksTop20 ?? 0,
        weeksTop40: chartRecord?.weeksTop40 ?? 0,
        weeksTop50: chartRecord?.weeksTop50 ?? 0,
        weeksTop100: chartRecord?.weeksTop100 ?? 0,

        maxNo1Streak: chartRecord?.maxNo1Streak ?? 0,
        maxChartStreak: chartRecord?.maxChartStreak ?? 0,
        reentryCount: chartRecord?.reentryCount ?? 0,
        currentChartStreak: chartRecord ? calculateCurrentStreak(chartRecord.history) : 0,

        unitsSold: careerUnits,
        bestWeek: chartRecord?.bestWeek ?? null,
        weeksToPeak: firstPeakIndex >= 0 ? firstPeakIndex + 1 : null,

        history: albumHistory,
        appearances: chartRecord?.appearances ?? [],
        recentHistory: albumHistory
      };
    });

    state.weeklyRecords = weeklyRecords;
    state.numberOneRecords = numberOneRecords;

    const officialAlbumEvents = [];

    // The Debuts view is exclusively official album debuts. First Top 100
    // appearance is a separate album archive field, not a second debut event.
    state.albumDebuts.forEach((activation, albumId) => {
      const id = String(albumId);
      const album = state.albums.get(id);
      const rankedEntry = activation.rank != null;

      officialAlbumEvents.push({
        dateTs: activation.weekStart,
        date: formatDate(activation.weekStart),
        type: "Album",
        status: rankedEntry
          ? "Official debut + first Top 100 appearance"
          : "Official album debut",
        title: getAlbumTitle(album),
        artist: getArtistName(getLeadAlbumArtistId(album)),
        rank: activation.rank,
        unitsSold: activation.unitsSold,
        simultaneousTracks: activation.simultaneousTracks,
        id
      });
    });

    // Debuts means first official album-debut week only. No re-entries,
    // song debuts, or chart exits are included in this archive.
    state.debutRecords = officialAlbumEvents
      .filter(event => event.type === "Album")
      .sort((a, b) => b.dateTs - a.dateTs);

    state.exitRecords = exitRecords;

    calculateMovement();
    calculateArtistRecords();
    calculateRecordBook();
  }

  /* ---------------------------------------------------------------
     SIX-MONTH MOVEMENT
  ---------------------------------------------------------------- */

  function calculateMovement() {
    const latest = state.snapshots[state.snapshots.length - 1];
    if (!latest) return;

    // Compare latest observed chart ranks to the closest observed snapshot
    // on or before six calendar months earlier.
    const comparison = findSnapshotOnOrBefore(state.currentSixMonthStart);

    const oldSongRanks = new Map(
      (comparison?.songs || []).map(entry => [String(entry.id), entry.rank])
    );

    const oldAlbumRanks = new Map(
      (comparison?.albums || []).map(entry => [String(entry.id), entry.rank])
    );

    state.songRecords.forEach(record => {
      const oldRank = oldSongRanks.get(String(record.id));
      record.movementValue = null;

      if (record.latestRank == null) {
        record.movement = "Not currently charting";
      } else if (oldRank == null) {
        record.movement = record.firstChartDate >= state.currentSixMonthStart
          ? "New"
          : "No comparable rank";
      } else {
        record.movementValue = oldRank - record.latestRank;
        record.movement = record.movementValue > 0
          ? "Up"
          : record.movementValue < 0
            ? "Down"
            : "Unchanged";
      }
    });

    state.albumRecords.forEach(record => {
      const oldRank = oldAlbumRanks.get(String(record.id));
      record.movementValue = null;

      if (!record.officialDebuted) {
        record.movement = "Not debuted";
      } else if (record.latestRank == null) {
        record.movement = "Not currently ranked";
      } else if (oldRank == null) {
        record.movement = record.debutTs >= state.currentSixMonthStart
          ? "New"
          : "No comparable rank";
      } else {
        record.movementValue = oldRank - record.latestRank;
        record.movement = record.movementValue > 0
          ? "Up"
          : record.movementValue < 0
            ? "Down"
            : "Unchanged";
      }
    });
  }

  /* ---------------------------------------------------------------
     ARTIST CAREER AND PERIOD AGGREGATION
  ---------------------------------------------------------------- */

  function calculateArtistRecords() {
    const artistMap = new Map();

    function ensureArtist(id) {
      if (!id) return null;

      const key = String(id);

      if (!artistMap.has(key)) {
        artistMap.set(key, {
          id: key,
          type: "Artist",
          name: getArtistName(key),

          songUnitsSold: 0,
          albumUnitsSold: 0,
          unitsSold: 0,

          recentUnits: 0,
          previousUnits: 0,

          songIds: new Set(),
          songNo1Ids: new Set(),
          albumIds: new Set(),
          albumNo1Ids: new Set(),

          songAppearances: 0,
          albumAppearances: 0,
          songNo1Weeks: 0,
          albumNo1Weeks: 0,

          top10Weeks: new Set(),
          maxTop10SongsInWeek: 0,
          appearanceDates: []
        });
      }

      return artistMap.get(key);
    }

    for (const snapshot of state.snapshots) {
      const isRecent =
        snapshot.weekStart >= state.currentSixMonthStart &&
        snapshot.weekStart <= state.latestWeekStart;

      const isPrevious =
        snapshot.weekStart >= state.previousSixMonthStart &&
        snapshot.weekStart < state.currentSixMonthStart;

      const top10Counts = new Map();

      snapshot.songs.forEach(entry => {
        (entry.artistIds || []).forEach(id => {
          const artist = ensureArtist(id);
          if (!artist) return;

          const units = Number(entry.unitsSold || 0);

          artist.songUnitsSold += units;
          artist.songAppearances++;
          artist.songIds.add(String(entry.id));
          artist.appearanceDates.push(snapshot.weekStart);

          if (entry.rank === 1) {
            artist.songNo1Ids.add(String(entry.id));
            artist.songNo1Weeks++;
          }

          if (entry.rank <= 10) {
            top10Counts.set(
              String(id),
              (top10Counts.get(String(id)) || 0) + 1
            );
          }

          if (isRecent) artist.recentUnits += units;
          if (isPrevious) artist.previousUnits += units;
        });
      });

      top10Counts.forEach((count, id) => {
        const artist = ensureArtist(id);
        if (!artist) return;

        artist.maxTop10SongsInWeek = Math.max(
          artist.maxTop10SongsInWeek,
          count
        );
        artist.top10Weeks.add(snapshot.weekStart);
      });

      snapshot.albums.forEach(entry => {
        const leadId = entry.leadArtistId ||
          getLeadAlbumArtistId(state.albums.get(String(entry.id)));

        const artist = ensureArtist(leadId);
        if (!artist) return;

        const units = Number(entry.unitsSold || 0);

        artist.albumUnitsSold += units;
        artist.albumAppearances++;
        artist.albumIds.add(String(entry.id));
        artist.appearanceDates.push(snapshot.weekStart);

        if (entry.rank === 1) {
          artist.albumNo1Weeks++;
          artist.albumNo1Ids.add(String(entry.id));
        }

        if (isRecent) artist.recentUnits += units;
        if (isPrevious) artist.previousUnits += units;
      });
    }

    // Include valid unranked debut-week units only if not already ranked that week.
    state.albumDebuts.forEach((activation, albumId) => {
      if (activation.unitsSold == null) return;

      const rankedThatWeek = state.snapshots.some(snapshot =>
        snapshot.weekStart === activation.weekStart &&
        snapshot.albums.some(entry => String(entry.id) === String(albumId))
      );

      if (rankedThatWeek) return;

      const album = state.albums.get(String(albumId));
      const leadId = getLeadAlbumArtistId(album);
      const artist = ensureArtist(leadId);
      if (!artist) return;

      const units = Number(activation.unitsSold);

      artist.albumUnitsSold += units;
      artist.albumIds.add(String(albumId));
      artist.appearanceDates.push(activation.weekStart);

      if (activation.weekStart >= state.currentSixMonthStart) {
        artist.recentUnits += units;
      } else if (
        activation.weekStart >= state.previousSixMonthStart &&
        activation.weekStart < state.currentSixMonthStart
      ) {
        artist.previousUnits += units;
      }
    });

    const records = [...artistMap.values()].map(artist => {
      artist.unitsSold = artist.songUnitsSold + artist.albumUnitsSold;
      artist.songCount = artist.songIds.size;
      artist.songNo1Count = artist.songNo1Ids.size;
      artist.albumCount = artist.albumIds.size;
      artist.albumNo1Count = artist.albumNo1Ids.size;
      artist.top10WeeksCount = artist.top10Weeks.size;
      artist.no1Weeks = artist.songNo1Weeks + artist.albumNo1Weeks;

      artist.lastDateTs = artist.appearanceDates.length
        ? Math.max(...artist.appearanceDates)
        : null;

      if (artist.previousUnits === 0 && artist.recentUnits > 0) {
        artist.salesMovement = "New / no prior units";
        artist.salesMovementValue = null;
      } else if (artist.previousUnits === 0 && artist.recentUnits === 0) {
        artist.salesMovement = "No six-month activity";
        artist.salesMovementValue = null;
      } else {
        artist.salesMovementValue = artist.recentUnits - artist.previousUnits;
        artist.salesMovement = artist.salesMovementValue > 0
          ? "Up"
          : artist.salesMovementValue < 0
            ? "Down"
            : "Unchanged";
      }

      artist.appearanceDates = unique(artist.appearanceDates.map(String)).map(Number);
      return artist;
    });

    const currentBoard = records
      .filter(artist => artist.recentUnits > 0)
      .sort((a, b) =>
        b.recentUnits - a.recentUnits ||
        a.name.localeCompare(b.name)
      );

    const previousBoard = records
      .filter(artist => artist.previousUnits > 0)
      .sort((a, b) =>
        b.previousUnits - a.previousUnits ||
        a.name.localeCompare(b.name)
      );

    const currentPositions = new Map(
      currentBoard.map((artist, index) => [artist.id, index + 1])
    );

    const previousPositions = new Map(
      previousBoard.map((artist, index) => [artist.id, index + 1])
    );

    records.forEach(artist => {
      artist.currentSixMonthRank = currentPositions.get(artist.id) ?? null;
      artist.previousSixMonthRank = previousPositions.get(artist.id) ?? null;
      artist.rankMovementValue = null;

      if (artist.currentSixMonthRank == null) {
        artist.rankMovement = artist.previousSixMonthRank != null
          ? "Left recent leaderboard"
          : "No recent rank";
      } else if (artist.previousSixMonthRank == null) {
        artist.rankMovement = "New";
      } else {
        const change =
          artist.previousSixMonthRank - artist.currentSixMonthRank;

        artist.rankMovementValue = change;
        artist.rankMovement = change > 0
          ? "Up"
          : change < 0
            ? "Down"
            : "Unchanged";
      }
    });

    state.artistRecords = records;
  }

  /* ---------------------------------------------------------------
     YEARLY AND MONTHLY BREAKDOWNS
  ---------------------------------------------------------------- */

  function buildPeriodRecords(periodMode) {
    const records = new Map();

    state.snapshots.forEach(snapshot => {
      const date = new Date(snapshot.weekStart);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");

      const key = periodMode === "year" ? String(year) : `${year}-${month}`;

      const dateTs = periodMode === "year"
        ? Date.UTC(year, 0, 1)
        : Date.UTC(year, date.getUTCMonth(), 1);

      if (!records.has(key)) {
        records.set(key, {
          period: key,
          dateTs,
          chartWeeks: 0,
          songAppearances: 0,
          albumAppearances: 0,
          songNo1Weeks: 0,
          albumNo1Weeks: 0,
          songUnitsSold: 0,
          albumUnitsSold: 0,
          unitsSold: 0
        });
      }

      const record = records.get(key);

      record.chartWeeks++;
      record.songAppearances += snapshot.songs.length;
      record.albumAppearances += snapshot.albums.length;

      if (snapshot.songs.some(entry => entry.rank === 1)) record.songNo1Weeks++;
      if (snapshot.albums.some(entry => entry.rank === 1)) record.albumNo1Weeks++;

      snapshot.songs.forEach(entry => {
        record.songUnitsSold += Number(entry.unitsSold || 0);
      });

      snapshot.albums.forEach(entry => {
        record.albumUnitsSold += Number(entry.unitsSold || 0);
      });

      record.unitsSold = record.songUnitsSold + record.albumUnitsSold;
    });

    return [...records.values()].sort((a, b) => b.dateTs - a.dateTs);
  }

  /* ---------------------------------------------------------------
     RECORD BOOK
  ---------------------------------------------------------------- */

  function calculateRecordBook() {
    const records = [];

    const add = (name, value, title, detail, numeric, type, id) => {
      if (value == null || value === "" || value === "—") return;

      records.push({
        name,
        value: String(value),
        valueNumber: Number.isFinite(Number(numeric)) ? Number(numeric) : 0,
        title: title || "—",
        detail: detail || "",
        type: type || null,
        id: id == null ? null : String(id)
      });
    };

    const songs = state.songRecords;
    const albums = state.albumRecords.filter(
      album => album.officialDebuted || album.weeksOnChart > 0
    );
    const artists = state.artistRecords;

    const best = (collection, selector) =>
      [...collection]
        .filter(item => Number.isFinite(selector(item)))
        .sort((a, b) => selector(b) - selector(a))[0] || null;

    const longestSongNo1 = best(songs.filter(x => x.maxNo1Streak > 0), x => x.maxNo1Streak);
    const mostSongNo1Weeks = best(songs.filter(x => x.weeksAtNo1 > 0), x => x.weeksAtNo1);
    const longestSongRun = best(songs.filter(x => x.maxChartStreak > 0), x => x.maxChartStreak);
    const mostSongTop10 = best(songs.filter(x => x.weeksTop10 > 0), x => x.weeksTop10);
    const mostSongUnits = best(songs.filter(x => x.unitsSold != null), x => x.unitsSold);

    const longestAlbumNo1 = best(albums.filter(x => x.maxNo1Streak > 0), x => x.maxNo1Streak);
    const mostAlbumNo1Weeks = best(albums.filter(x => x.weeksAtNo1 > 0), x => x.weeksAtNo1);
    const longestAlbumRun = best(albums.filter(x => x.maxChartStreak > 0), x => x.maxChartStreak);
    const mostAlbumTop10 = best(albums.filter(x => x.weeksTop10 > 0), x => x.weeksTop10);
    const mostAlbumChartWeeks = best(albums.filter(x => x.weeksOnChart > 0), x => x.weeksOnChart);
    const mostAlbumReentries = best(albums.filter(x => x.reentryCount > 0), x => x.reentryCount);
    const highestAlbumPeak = best(
      albums.filter(x => x.weeksOnChart > 0 && Number.isFinite(x.peak)),
      x => CONFIG.HOT100_SIZE + 1 - x.peak
    );
    const mostAlbumDebutTracks = best(
      albums.filter(x => Number.isFinite(x.qualifyingTracksAtDebut)),
      x => x.qualifyingTracksAtDebut
    );
    const highestAlbumDebutUnits = best(
      albums.filter(x => x.debutUnits != null),
      x => x.debutUnits
    );
    const mostAlbumUnits = best(albums.filter(x => x.unitsSold != null), x => x.unitsSold);
    const mostAlbumTop20 = best(albums.filter(x => x.weeksTop20 > 0), x => x.weeksTop20);
    const mostAlbumTop40 = best(albums.filter(x => x.weeksTop40 > 0), x => x.weeksTop40);
    const mostAlbumTop50 = best(albums.filter(x => x.weeksTop50 > 0), x => x.weeksTop50);
    const highestAlbumWeeklyUnits = best(
      albums.filter(x => x.bestWeek && Number.isFinite(Number(x.bestWeek.unitsSold))),
      x => Number(x.bestWeek.unitsSold)
    );
    const fastestAlbumToNo1 = best(
      albums.filter(x => x.peak === 1 && Number.isFinite(x.weeksToPeak) && x.weeksToPeak > 0),
      x => -x.weeksToPeak
    );
    const highestAlbumDebutRank = best(
      albums.filter(x => x.debutRank != null && x.debutRank > 0),
      x => 101 - x.debutRank
    );
    const longestAlbumDebutToChart = best(
      albums.filter(x =>
        x.officialDebuted &&
        x.debutTs != null &&
        x.firstRankedTs != null &&
        x.firstRankedTs > x.debutTs
      ),
      x => (x.firstRankedTs - x.debutTs) / CONFIG.WEEK_MS
    );

    const artistMostSongNo1 = best(artists.filter(x => x.songNo1Count > 0), x => x.songNo1Count);
    const artistMostSongs = best(artists.filter(x => x.songCount > 0), x => x.songCount);
    const artistMostTop10 = best(artists.filter(x => x.maxTop10SongsInWeek > 0), x => x.maxTop10SongsInWeek);
    const artistMostAlbumNo1 = best(artists.filter(x => x.albumNo1Weeks > 0), x => x.albumNo1Weeks);
    const artistMostDistinctNo1Albums = best(artists.filter(x => x.albumNo1Count > 0), x => x.albumNo1Count);
    const artistMostUnits = best(artists.filter(x => x.unitsSold != null), x => x.unitsSold);

    if (longestSongNo1) add("Longest song No. 1 streak", `${longestSongNo1.maxNo1Streak} weeks`, longestSongNo1.title, longestSongNo1.artist, longestSongNo1.maxNo1Streak, "Song", longestSongNo1.id);
    if (mostSongNo1Weeks) add("Most song weeks at No. 1", `${mostSongNo1Weeks.weeksAtNo1} weeks`, mostSongNo1Weeks.title, mostSongNo1Weeks.artist, mostSongNo1Weeks.weeksAtNo1, "Song", mostSongNo1Weeks.id);
    if (longestSongRun) add("Longest song chart run", `${longestSongRun.maxChartStreak} weeks`, longestSongRun.title, longestSongRun.artist, longestSongRun.maxChartStreak, "Song", longestSongRun.id);
    if (mostSongTop10) add("Most song Top 10 weeks", `${mostSongTop10.weeksTop10} weeks`, mostSongTop10.title, mostSongTop10.artist, mostSongTop10.weeksTop10, "Song", mostSongTop10.id);
    if (mostSongUnits) add("Highest career song units sold", formatUnits(mostSongUnits.unitsSold), mostSongUnits.title, mostSongUnits.artist, mostSongUnits.unitsSold, "Song", mostSongUnits.id);

    if (longestAlbumNo1) add("Longest album No. 1 streak", `${longestAlbumNo1.maxNo1Streak} weeks`, longestAlbumNo1.title, longestAlbumNo1.artist, longestAlbumNo1.maxNo1Streak, "Album", longestAlbumNo1.id);
    if (mostAlbumNo1Weeks) add("Most album weeks at No. 1", `${mostAlbumNo1Weeks.weeksAtNo1} weeks`, mostAlbumNo1Weeks.title, mostAlbumNo1Weeks.artist, mostAlbumNo1Weeks.weeksAtNo1, "Album", mostAlbumNo1Weeks.id);
    if (longestAlbumRun) add("Longest album chart run", `${longestAlbumRun.maxChartStreak} weeks`, longestAlbumRun.title, longestAlbumRun.artist, longestAlbumRun.maxChartStreak, "Album", longestAlbumRun.id);
    if (mostAlbumTop10) add("Most album Top 10 weeks", `${mostAlbumTop10.weeksTop10} weeks`, mostAlbumTop10.title, mostAlbumTop10.artist, mostAlbumTop10.weeksTop10, "Album", mostAlbumTop10.id);
    if (mostAlbumChartWeeks) add("Most album chart weeks", `${mostAlbumChartWeeks.weeksOnChart} weeks`, mostAlbumChartWeeks.title, mostAlbumChartWeeks.artist, mostAlbumChartWeeks.weeksOnChart, "Album", mostAlbumChartWeeks.id);
    if (highestAlbumPeak) add("Highest album peak", formatPosition(highestAlbumPeak.peak), highestAlbumPeak.title, highestAlbumPeak.artist, CONFIG.HOT100_SIZE + 1 - highestAlbumPeak.peak, "Album", highestAlbumPeak.id);
    if (mostAlbumReentries) add("Most album re-entries", `${mostAlbumReentries.reentryCount} re-entries`, mostAlbumReentries.title, mostAlbumReentries.artist, mostAlbumReentries.reentryCount, "Album", mostAlbumReentries.id);
    if (highestAlbumDebutUnits) add("Highest album debut-week units sold", formatUnits(highestAlbumDebutUnits.debutUnits), highestAlbumDebutUnits.title, highestAlbumDebutUnits.artist, highestAlbumDebutUnits.debutUnits, "Album", highestAlbumDebutUnits.id);
    if (mostAlbumDebutTracks) add("Most Hot 100 tracks at album debut", `${mostAlbumDebutTracks.qualifyingTracksAtDebut} tracks`, mostAlbumDebutTracks.title, mostAlbumDebutTracks.artist, mostAlbumDebutTracks.qualifyingTracksAtDebut, "Album", mostAlbumDebutTracks.id);
    if (mostAlbumUnits) add("Highest career album units sold", formatUnits(mostAlbumUnits.unitsSold), mostAlbumUnits.title, mostAlbumUnits.artist, mostAlbumUnits.unitsSold, "Album", mostAlbumUnits.id);
    if (mostAlbumTop20) add("Most album Top 20 weeks", mostAlbumTop20.weeksTop20 + " weeks", mostAlbumTop20.title, mostAlbumTop20.artist, mostAlbumTop20.weeksTop20, "Album", mostAlbumTop20.id);
    if (mostAlbumTop40) add("Most album Top 40 weeks", mostAlbumTop40.weeksTop40 + " weeks", mostAlbumTop40.title, mostAlbumTop40.artist, mostAlbumTop40.weeksTop40, "Album", mostAlbumTop40.id);
    if (mostAlbumTop50) add("Most album Top 50 weeks", mostAlbumTop50.weeksTop50 + " weeks", mostAlbumTop50.title, mostAlbumTop50.artist, mostAlbumTop50.weeksTop50, "Album", mostAlbumTop50.id);
    if (highestAlbumWeeklyUnits) add("Highest single-week album units sold", formatUnits(highestAlbumWeeklyUnits.bestWeek.unitsSold), highestAlbumWeeklyUnits.title, highestAlbumWeeklyUnits.artist, highestAlbumWeeklyUnits.bestWeek.unitsSold, "Album", highestAlbumWeeklyUnits.id);
    if (fastestAlbumToNo1) add("Fastest album to reach No. 1", fastestAlbumToNo1.weeksToPeak + " chart weeks", fastestAlbumToNo1.title, fastestAlbumToNo1.artist, 1 / fastestAlbumToNo1.weeksToPeak, "Album", fastestAlbumToNo1.id);
    if (highestAlbumDebutRank) add("Highest official album debut position", formatPosition(highestAlbumDebutRank.debutRank), highestAlbumDebutRank.title, highestAlbumDebutRank.artist, 101 - highestAlbumDebutRank.debutRank, "Album", highestAlbumDebutRank.id);
    if (longestAlbumDebutToChart) {
      const delayWeeks = Math.round((longestAlbumDebutToChart.firstRankedTs - longestAlbumDebutToChart.debutTs) / CONFIG.WEEK_MS);
      add("Longest wait from album debut to Top 100", delayWeeks + " weeks", longestAlbumDebutToChart.title, longestAlbumDebutToChart.artist, delayWeeks, "Album", longestAlbumDebutToChart.id);
    }

    if (artistMostSongNo1) add("Most distinct No. 1 songs credited", `${artistMostSongNo1.songNo1Count} songs`, artistMostSongNo1.name, "Artist credits", artistMostSongNo1.songNo1Count, "Artist", artistMostSongNo1.id);
    if (artistMostSongs) add("Most distinct songs charted", `${artistMostSongs.songCount} songs`, artistMostSongs.name, "Artist", artistMostSongs.songCount, "Artist", artistMostSongs.id);
    if (artistMostTop10) add("Most Top 10 songs in one week", `${artistMostTop10.maxTop10SongsInWeek} songs`, artistMostTop10.name, "Artist", artistMostTop10.maxTop10SongsInWeek, "Artist", artistMostTop10.id);
    if (artistMostAlbumNo1) add("Most lead-album No. 1 weeks", `${artistMostAlbumNo1.albumNo1Weeks} weeks`, artistMostAlbumNo1.name, "Lead album artist", artistMostAlbumNo1.albumNo1Weeks, "Artist", artistMostAlbumNo1.id);
    if (artistMostDistinctNo1Albums) add("Most distinct No. 1 albums", `${artistMostDistinctNo1Albums.albumNo1Count} albums`, artistMostDistinctNo1Albums.name, "Lead album artist", artistMostDistinctNo1Albums.albumNo1Count, "Artist", artistMostDistinctNo1Albums.id);
    if (artistMostUnits) add("Highest combined artist units sold", formatUnits(artistMostUnits.unitsSold), artistMostUnits.name, "Song credits plus lead-album credits", artistMostUnits.unitsSold, "Artist", artistMostUnits.id);

    const debutsByYear = new Map();

    state.albumDebuts.forEach(activation => {
      const year = new Date(activation.weekStart).getUTCFullYear();
      debutsByYear.set(year, (debutsByYear.get(year) || 0) + 1);
    });

    const busiestDebutYear = [...debutsByYear.entries()]
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];

    if (busiestDebutYear) {
      add(
        "Most official album debuts in one year",
        `${busiestDebutYear[1]} albums`,
        String(busiestDebutYear[0]),
        "Albums counted by their official debut week",
        busiestDebutYear[1]
      );
    }

    const leadDebuts = new Map();

    albums.filter(album => album.officialDebuted).forEach(album => {
      if (!album.leadArtistId) return;
      const id = String(album.leadArtistId);
      leadDebuts.set(id, (leadDebuts.get(id) || 0) + 1);
    });

    const leadDebutLeader = [...leadDebuts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

    if (leadDebutLeader) {
      add(
        "Most official album debuts by one lead artist",
        `${leadDebutLeader[1]} albums`,
        getArtistName(leadDebutLeader[0]),
        "Official album debuts",
        leadDebutLeader[1],
        "Artist",
        leadDebutLeader[0]
      );
    }

    add("Observed chart weeks", formatNumber(state.snapshots.length), formatDate(state.earliestWeekStart), `Latest observed week: ${formatDate(state.latestWeekStart)}`, state.snapshots.length);
    add("Distinct songs charted", formatNumber(state.songRecords.length), "YourHot100 song archive", "Canonical song records", state.songRecords.length);
    add("Eligible catalogue albums", formatNumber(state.eligibleAlbumIds.size), "YourHot100 album archive", "At least three distinct canonical catalogue tracks", state.eligibleAlbumIds.size);
    add("Officially debuted albums", formatNumber(state.albumDebuts.size), "Official album debut archive", "First qualifying simultaneous three-track Hot 100 week", state.albumDebuts.size);

    state.allRecords = records;
  }

  /* ---------------------------------------------------------------
     FILTERS, PERIOD UNITS AND SORTING
  ---------------------------------------------------------------- */

  function getPeriodBounds() {
    const mode = ui.timeMode.value;

    if (mode === "all") {
      return {
        mode,
        from: state.earliestWeekStart ?? -Infinity,
        to: state.latestWeekStart ?? Infinity,
        valid: true
      };
    }

    if (mode === "year") {
      const year = Number(ui.year.value);
      if (!(year > 0)) return { mode, from: Infinity, to: -Infinity, valid: false };

      return {
        mode,
        from: Date.UTC(year, 0, 1),
        to: Date.UTC(year, 11, 31, 23, 59, 59, 999),
        valid: true
      };
    }

    if (mode === "custom") {
      const from = ui.dateFrom.value
        ? Date.parse(`${ui.dateFrom.value}T00:00:00Z`)
        : -Infinity;
      const to = ui.dateTo.value
        ? Date.parse(`${ui.dateTo.value}T23:59:59Z`)
        : Infinity;

      return { mode, from, to, valid: from <= to };
    }

    if (mode === "recent6") {
      return {
        mode,
        from: state.currentSixMonthStart,
        to: state.latestWeekStart,
        valid: true
      };
    }

    if (mode === "previous6") {
      return {
        mode,
        from: state.previousSixMonthStart,
        to: state.previousSixMonthEnd,
        valid: true
      };
    }

    return { mode, from: -Infinity, to: Infinity, valid: true };
  }

  function historyMatchesPeriod(history, from, to) {
    return (history || []).some(entry =>
      entry.weekStart >= from && entry.weekStart <= to
    );
  }

  /*
   * Build totals for the selected date window. Song units go in full to each
   * credited canonical artist. Album units go only to the lead album artist.
   */
  function buildPeriodUnitsIndex(from, to) {
    const songUnits = new Map();
    const albumUnits = new Map();
    const artistUnits = new Map();

    function addUnits(map, id, amount) {
      if (id == null) return;

      const key = String(id);

      if (map.has(key) && map.get(key) === null) return;

      if (amount == null || !Number.isFinite(Number(amount))) {
        map.set(key, null);
        return;
      }

      map.set(key, (map.get(key) || 0) + Number(amount));
    }

    const snapshotsByWeek = new Map(
      state.snapshots.map(snapshot => [snapshot.weekStart, snapshot])
    );

    state.snapshots.forEach(snapshot => {
      if (snapshot.weekStart < from || snapshot.weekStart > to) return;

      snapshot.songs.forEach(entry => {
        const units = Number(entry.unitsSold || 0);
        addUnits(songUnits, entry.id, units);

        (entry.artistIds || []).forEach(artistId => {
          addUnits(artistUnits, artistId, units);
        });
      });

      snapshot.albums.forEach(entry => {
        const units = Number(entry.unitsSold || 0);
        addUnits(albumUnits, entry.id, units);

        const leadArtistId = entry.leadArtistId ||
          getLeadAlbumArtistId(state.albums.get(String(entry.id)));

        if (leadArtistId) addUnits(artistUnits, leadArtistId, units);
      });
    });

    // Do not double-count a debut-week album already present in that chart.
    state.albumDebuts.forEach((activation, albumId) => {
      if (activation.weekStart < from || activation.weekStart > to) return;

      const snapshot = snapshotsByWeek.get(activation.weekStart);
      const rankedThatWeek = Boolean(
        snapshot?.albums.some(entry => String(entry.id) === String(albumId))
      );

      if (rankedThatWeek) return;

      addUnits(albumUnits, albumId, activation.unitsSold);

      const leadArtistId = getLeadAlbumArtistId(state.albums.get(String(albumId)));
      if (leadArtistId) addUnits(artistUnits, leadArtistId, activation.unitsSold);
    });

    return { songUnits, albumUnits, artistUnits };
  }

  function rowMatchesDate(row, bounds = getPeriodBounds()) {
    if (
      bounds.mode === "all" ||
      state.currentView === "overview" ||
      state.currentView === "records"
    ) return true;

    if (!bounds.valid) return false;

    const { from, to } = bounds;

    if (state.currentView === "songs") {
      return historyMatchesPeriod(row.history, from, to);
    }

    if (state.currentView === "albums") {
      const chartActivity = historyMatchesPeriod(row.history, from, to);

      const debutedInPeriod =
        row.officialDebuted &&
        Number.isFinite(row.debutTs) &&
        row.debutTs >= from &&
        row.debutTs <= to;

      // The Albums view can show chart activity in the selected period.
      // The Debuts view below is separately filtered by official event date.
      return chartActivity || debutedInPeriod;
    }

    if (state.currentView === "artists") {
      return (row.appearanceDates || []).some(timestamp =>
        timestamp >= from && timestamp <= to
      );
    }

    const timestamp = row.dateTs;
    return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
  }

  function currentViewRows() {
    switch (state.currentView) {
      case "songs": return state.songRecords;
      case "albums": return state.albumRecords;
      case "artists": return state.artistRecords;
      case "weeks": return state.weeklyRecords;
      case "numberones": return state.numberOneRecords;
      case "debuts": return state.debutRecords.filter(row => row.type === "Album");
      case "periods": return buildPeriodRecords(state.periodMode);
      case "records": return state.allRecords;
      default: return [];
    }
  }

  function getRowsForActivePeriod() {
    const bounds = getPeriodBounds();
    const baseRows = currentViewRows();

    if (!["songs", "albums", "artists"].includes(state.currentView)) {
      return baseRows.filter(row => rowMatchesDate(row, bounds));
    }

    const index = buildPeriodUnitsIndex(bounds.from, bounds.to);

    return baseRows.map(row => {
      const id = String(row.id);
      let periodUnitsSold;

      if (state.currentView === "songs") {
        periodUnitsSold = index.songUnits.has(id) ? index.songUnits.get(id) : 0;
      } else if (state.currentView === "albums") {
        if (index.albumUnits.has(id)) {
          periodUnitsSold = index.albumUnits.get(id);
        } else {
          // An eligible but inactive album has no sold units in this period.
          periodUnitsSold = row.officialDebuted || row.unitsSold != null ? 0 : null;
        }
      } else {
        periodUnitsSold = index.artistUnits.has(id) ? index.artistUnits.get(id) : 0;
      }

      return { ...row, periodUnitsSold };
    }).filter(row => rowMatchesDate(row, bounds));
  }

  function searchValue(row) {
    const fieldsByView = {
      songs: ["title", "artist", "debutDate", "peakDate", "lastDate", "id"],
      albums: [
        "title", "artist", "status", "debutDate", "firstRankedDate",
        "releaseDate", "importDate", "peakDate", "lastDate", "id"
      ],
      artists: ["name", "id"],
      weeks: ["date", "year"],
      numberones: ["date", "songTitle", "songArtist", "albumTitle", "albumArtist"],
      debuts: ["date", "status", "type", "title", "artist", "id"],
      periods: ["period"],
      records: ["name", "value", "title", "detail"]
    };

    return (fieldsByView[state.currentView] || [])
      .map(key => {
        const value = row[key];
        if (value && typeof value === "object") return value.title ?? value.name ?? "";
        return value ?? "";
      })
      .join(" ")
      .toLowerCase();
  }

  function defaultSortField() {
    const defaults = {
      songs: "periodUnitsSold",
      albums: "periodUnitsSold",
      artists: "periodUnitsSold",
      weeks: "dateTs",
      numberones: "dateTs",
      debuts: "dateTs",
      periods: "unitsSold",
      records: "valueNumber"
    };

    return defaults[state.currentView] || "title";
  }

  function configureSortMenu(forceDefault = false) {
    const options = SORT_OPTIONS[state.currentView] || [];
    const selected = ui.sort.value;

    ui.sort.innerHTML = options.map(([value, label]) =>
      `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`
    ).join("");

    const selectedIsValid = options.some(([value]) => value === selected);
    const desired = !forceDefault && selectedIsValid
      ? selected
      : defaultSortField();

    ui.sort.value = options.some(([value]) => value === desired)
      ? desired
      : options[0]?.[0] || "";
  }

  function getFilteredRows(periodRows = getRowsForActivePeriod()) {
    const query = ui.search.value.trim().toLowerCase();

    let rows = query
      ? periodRows.filter(row => searchValue(row).includes(query))
      : [...periodRows];

    const sortField = ui.sort.value || defaultSortField();
    const direction = ui.direction.value === "asc" ? 1 : -1;

    rows.sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];

      const aMissing = av == null || av === "";
      const bMissing = bv == null || bv === "";

      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;

      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * direction;
      }

      return String(av).localeCompare(
        String(bv),
        undefined,
        { numeric: true, sensitivity: "base" }
      ) * direction;
    });

    // Add a clear position within the table being viewed. This is separate
    // from latestRank/currentSixMonthRank, which describe the actual chart.
    rows = rows.map((row, index) => ({ ...row, listRank: index + 1 }));

    // Calculate on every available record first, then cap display/export.
    return rows.slice(0, CONFIG.TABLE_LIMIT);
  }

  function refreshYearOptions() {
    const selected = ui.year.value;

    state.years = [...new Set(state.snapshots.map(snapshot =>
      new Date(snapshot.weekStart).getUTCFullYear()
    ))].sort((a, b) => b - a);

    ui.year.innerHTML = [
      '<option value="">Choose year</option>',
      ...state.years.map(year => `<option value="${year}">${year}</option>`)
    ].join("");

    if (state.years.includes(Number(selected))) ui.year.value = selected;
  }

  function updateDateControls() {
    ui.year.disabled = ui.timeMode.value !== "year";
    ui.customDates.hidden = ui.timeMode.value !== "custom";

    if (!state.sortTouched) configureSortMenu(true);

    renderContent();
  }

  function resetFilters() {
    ui.search.value = "";
    ui.timeMode.value = "all";
    ui.year.value = "";
    ui.dateFrom.value = "";
    ui.dateTo.value = "";
    ui.direction.value = "desc";
    ui.customDates.hidden = true;
    ui.year.disabled = true;
    state.sortTouched = false;

    configureSortMenu(true);
    renderContent();
  }

  /* ---------------------------------------------------------------
     SUMMARY AND STATUS
  ---------------------------------------------------------------- */

  function setStatus(label, kind = "good") {
    ui.status.textContent = label;
    ui.status.className = `pill ${kind}`;
  }

  function showError(message) {
    ui.error.innerHTML = `
      <div class="error-box">
        <strong>Stats Paradise could not finish loading.</strong><br>
        ${escapeHTML(message)}
      </div>
    `;
  }

  function renderSummary() {
    const cards = [
      {
        label: "Observed Chart Weeks",
        value: formatNumber(state.snapshots.length),
        note: `${formatDate(state.earliestWeekStart)} – ${formatDate(state.latestWeekStart)}`
      },
      {
        label: "Distinct Songs Charted",
        value: formatNumber(state.songRecords.length),
        note: "Canonical song records"
      },
      {
        label: "Eligible Catalogue Albums",
        value: formatNumber(state.eligibleAlbumIds.size),
        note: "Three or more distinct canonical tracks"
      },
      {
        label: "Official Album Debuts",
        value: formatNumber(state.albumDebuts.size),
        note: "First qualifying three-track Hot 100 week"
      },
      {
        label: "Ranked Album Records",
        value: formatNumber(state.albumRecords.filter(album => album.weeksOnChart > 0).length),
        note: "At least one Top 100 album-chart appearance"
      },
      {
        label: "Artists Credited",
        value: formatNumber(state.artistRecords.length),
        note: "Song and lead-album credits"
      }
    ];

    ui.summary.innerHTML = cards.map(card => `
      <article class="stat-card">
        <div class="stat-label">${escapeHTML(card.label)}</div>
        <div class="stat-value">${escapeHTML(card.value)}</div>
        <div class="stat-note">${escapeHTML(card.note)}</div>
      </article>
    `).join("");

    ui.archiveDescription.textContent =
      `${formatDate(state.earliestWeekStart)} through ${formatDate(state.latestWeekStart)} · ` +
      `${state.events.length.toLocaleString("en-US")} source history records loaded`;

    setStatus(`Loaded · latest week ${formatDate(state.latestWeekStart)}`, "good");
  }

  /* ---------------------------------------------------------------
     LINKS, MOVEMENT INDICATORS AND TABLE COLUMNS
  ---------------------------------------------------------------- */

  function makePageLink(type, id, label) {
    const paths = {
      Song: "track.html",
      Album: "album.html",
      Artist: "artist.html"
    };

    const path = paths[type];
    const safeLabel = escapeHTML(label ?? "—");

    if (!path || id == null) return safeLabel;
    return `<a href="${path}?id=${encodeURIComponent(String(id))}">${safeLabel}</a>`;
  }

  function renderMovementIndicator(value, label) {
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
      const movement = Number(value);

      if (movement > 0) {
        return `<span class="rank-arrow trend-up" role="img" aria-label="Rank improved" title="Rank improved">↑</span>`;
      }

      if (movement < 0) {
        return `<span class="rank-arrow trend-down" role="img" aria-label="Rank declined" title="Rank declined">↓</span>`;
      }

      return `<span class="rank-arrow trend-neutral" role="img" aria-label="Rank unchanged" title="Rank unchanged">→</span>`;
    }

    const text = String(label || "").toLowerCase();

    if (text === "new" || text.startsWith("new /")) {
      return `<span class="rank-arrow trend-new" role="img" aria-label="New entry" title="New entry">•</span>`;
    }

    return `<span class="rank-arrow trend-neutral" role="img" aria-label="No comparable rank" title="No comparable rank">—</span>`;
  }

  function renderRankCell(rank, movementValue, movementLabel, isArtist = false) {
    const formatted = isArtist
      ? formatLeaderboardPosition(rank)
      : formatPosition(rank);

    if (rank == null) return `<span class="rank-cell"><span class="rank">—</span></span>`;

    return `
      <span class="rank-cell">
        <span class="rank">${escapeHTML(formatted)}</span>
        ${renderMovementIndicator(movementValue, movementLabel)}
      </span>`;
  }

  function getColumns(view) {
    const columns = {
      songs: [
        ["listRank", "List #"],
        ["latestRank", "Chart rank"],
        ["title", "Song"],
        ["artist", "Artist"],
        ["peak", "Peak"],
        ["weeksOnChart", "Weeks"],
        ["weeksAtNo1", "No. 1 weeks"],
        ["periodUnitsSold", "Units sold"],
        ["unitsSold", "Career units"]
      ],
      albums: [
        ["listRank", "List #"],
        ["status", "Album status"],
        ["title", "Album"],
        ["artist", "Lead artist"],
        ["trackCount", "Tracks"],
        ["importDate", "Imported"],
        ["releaseDate", "Released"],
        ["debutDate", "Official debut"],
        ["firstRankedDate", "First Top 100"],
        ["latestRank", "Latest rank"],
        ["numberOneTracks", "No. 1 tracks"],
        ["top10Tracks", "Top 10 tracks"],
        ["weeksAtNo1", "No. 1 weeks"],
        ["reentryCount", "Re-entries"],
        ["periodUnitsSold", "Units sold"],
        ["unitsSold", "Career units"]
      ],
      artists: [
        ["listRank", "List #"],
        ["currentSixMonthRank", "Leaderboard rank"],
        ["name", "Artist"],
        ["songCount", "Songs"],
        ["songNo1Count", "No. 1 songs"],
        ["albumCount", "Lead albums"],
        ["periodUnitsSold", "Units sold"],
        ["unitsSold", "Career units"]
      ],
      weeks: [
        ["date", "Chart week"],
        ["songCount", "Songs"],
        ["albumCount", "Albums"],
        ["newEntries", "New song entries"],
        ["reentries", "Song re-entries"],
        ["topSong", "Song No. 1"],
        ["topAlbum", "Album No. 1"]
      ],
      numberones: [
        ["date", "Chart week"],
        ["songTitle", "Song No. 1"],
        ["songArtist", "Song artist"],
        ["songUnits", "Song units sold"],
        ["albumTitle", "Album No. 1"],
        ["albumArtist", "Lead artist"],
        ["albumUnits", "Album units sold"]
      ],
      debuts: [
        ["date", "Official debut date"],
        ["status", "Debut status"],
        ["rank", "Debut position"],
        ["title", "Album"],
        ["artist", "Lead artist"],
        ["unitsSold", "Debut-week units"],
        ["simultaneousTracks", "Tracks at debut"]
      ],
      periods: [
        ["period", state.periodMode === "year" ? "Year" : "Month"],
        ["chartWeeks", "Observed chart weeks"],
        ["songAppearances", "Song appearances"],
        ["albumAppearances", "Album appearances"],
        ["songNo1Weeks", "Song No. 1 weeks"],
        ["albumNo1Weeks", "Album No. 1 weeks"],
        ["songUnitsSold", "Song units sold"],
        ["albumUnitsSold", "Album units sold"],
        ["unitsSold", "Combined units sold"]
      ],
      records: [
        ["name", "Record"],
        ["value", "Achievement"],
        ["title", "Record holder"],
        ["detail", "Notes"]
      ]
    };

    return (columns[view] || []).map(([key, label]) => ({ key, label }));
  }

  function columnWidth(view, key) {
    const widths = {
      songs: {
        listRank: 5, latestRank: 9, title: 20, artist: 17, peak: 6,
        weeksOnChart: 6, weeksAtNo1: 8, periodUnitsSold: 15, unitsSold: 14
      },
      albums: {
        listRank: 4, status: 9, title: 14, artist: 10, numberOneTracks: 7, top10Tracks: 7, trackCount: 4,
        importDate: 7, releaseDate: 7, debutDate: 8, firstRankedDate: 8,
        latestRank: 5, weeksAtNo1: 6, reentryCount: 5,
        periodUnitsSold: 7, unitsSold: 6
      },
      artists: {
        listRank: 5, currentSixMonthRank: 12, name: 24, songCount: 8,
        songNo1Count: 10, albumCount: 9, periodUnitsSold: 16, unitsSold: 16
      }
    };

    if (widths[view]?.[key]) return widths[view][key];

    const columns = getColumns(view);
    return columns.length ? 100 / columns.length : 100;
  }

  function renderCell(row, column) {
    const key = column.key;

    if (key === "listRank") {
      return `<span class="rank">${escapeHTML("#" + formatNumber(row.listRank))}</span>`;
    }

    if (key === "title") {
      return `<span class="cell-main">${makePageLink(row.type, row.id, row.title)}</span>`;
    }

    if (key === "name") {
      return `<span class="cell-main">${
        row.type === "Artist"
          ? makePageLink("Artist", row.id, row.name)
          : escapeHTML(row.name ?? "—")
      }</span>`;
    }

    if (key === "artist") {
      return row.type === "Album" && row.leadArtistId
        ? makePageLink("Artist", row.leadArtistId, row.artist)
        : escapeHTML(row.artist ?? "—");
    }

    if (key === "topSong") {
      const entry = row.topSong;

      return entry
        ? `<span class="cell-main">${makePageLink("Song", entry.id, entry.title)}</span>
           <span class="cell-sub">${escapeHTML(entry.artist)}</span>`
        : "—";
    }

    if (key === "topAlbum") {
      const entry = row.topAlbum;

      return entry
        ? `<span class="cell-main">${makePageLink("Album", entry.id, entry.title)}</span>
           <span class="cell-sub">${escapeHTML(entry.artist)}</span>`
        : "—";
    }

    if (key === "songTitle") {
      return row.songId != null
        ? makePageLink("Song", row.songId, row.songTitle)
        : escapeHTML(row.songTitle ?? "—");
    }

    if (key === "albumTitle") {
      return row.albumId != null
        ? makePageLink("Album", row.albumId, row.albumTitle)
        : escapeHTML(row.albumTitle ?? "—");
    }

    if (key === "latestRank") {
      return renderRankCell(row.latestRank, row.movementValue, row.movement);
    }

    if (key === "currentSixMonthRank") {
      return renderRankCell(
        row.currentSixMonthRank,
        row.rankMovementValue,
        row.rankMovement,
        true
      );
    }

    if (key === "rank" || key === "peak") {
      return `<span class="rank">${escapeHTML(formatPosition(row[key]))}</span>`;
    }

    if (
      key === "unitsSold" ||
      key === "periodUnitsSold" ||
      key === "debutUnits" ||
      key === "songUnits" ||
      key === "albumUnits" ||
      key === "recentUnits" ||
      key === "songUnitsSold" ||
      key === "albumUnitsSold"
    ) {
      return escapeHTML(formatUnits(row[key]));
    }

    if (
      key === "debutDate" || key === "firstRankedDate" ||
      key === "peakDate" || key === "firstNo1Date" ||
      key === "lastDate" || key === "releaseDate" || key === "importDate"
    ) {
      return escapeHTML(row[key] ?? "—");
    }

    if (key === "date") return escapeHTML(row.date ?? "—");

    return escapeHTML(
      row[key] === null || row[key] === undefined || row[key] === ""
        ? "—"
        : row[key]
    );
  }

  function renderTable() {
    const columns = getColumns(state.currentView);
    const periodRows = getRowsForActivePeriod();
    const rows = getFilteredRows(periodRows);

    state.visibleRows = rows;
    state.visibleColumns = columns;

    if (!columns.length) {
      ui.content.innerHTML = `<div class="empty">No table is configured for this section.</div>`;
      return;
    }

    if (!rows.length) {
      ui.content.innerHTML = `
        <div class="empty">
          No matching records. Try another search or date filter.
        </div>
      `;
      return;
    }

    const colgroup = columns.map(column =>
      `<col style="width:${columnWidth(state.currentView, column.key)}%">`
    ).join("");

    const head = columns.map(column =>
      `<th scope="col">${escapeHTML(column.label)}</th>`
    ).join("");

    const body = rows.map(row => `
      <tr>
        ${columns.map(column => `
          <td data-label="${escapeHTML(column.label)}">
            ${renderCell(row, column)}
          </td>
        `).join("")}
      </tr>
    `).join("");

    ui.content.innerHTML = `
      <div class="result-count">
        Showing ${formatNumber(rows.length)} of
        ${formatNumber(
          ui.search.value.trim()
            ? periodRows.filter(row => searchValue(row).includes(ui.search.value.trim().toLowerCase())).length
            : periodRows.length
        )}
        matching records. Maximum ${CONFIG.TABLE_LIMIT} rows displayed.
      </div>
      <div class="table-wrap">
        <table>
          <colgroup>${colgroup}</colgroup>
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
  }

  function renderOverview() {
    const latest = state.snapshots[state.snapshots.length - 1];
    const no1Song = latest?.songs.find(entry => entry.rank === 1) ?? null;
    const no1Album = latest?.albums.find(entry => entry.rank === 1) ?? null;

    const cards = [
      {
        label: "Latest Song No. 1",
        value: no1Song?.title ?? "No qualifying entry",
        detail: no1Song
          ? `${no1Song.artist} · ${formatUnits(no1Song.unitsSold)} units sold`
          : "No song entry in the latest snapshot."
      },
      {
        label: "Latest Album No. 1",
        value: no1Album?.title ?? "No qualifying entry",
        detail: no1Album
          ? `${no1Album.artist} · ${formatUnits(no1Album.unitsSold)} units sold`
          : "No ranked album entry in the latest snapshot."
      },
      {
        label: "Latest Six-Month Window",
        value: formatDate(state.currentSixMonthStart),
        detail: `Through ${formatDate(state.latestWeekStart)}`
      },
      {
        label: "Previous Six-Month Window",
        value: formatDate(state.previousSixMonthStart),
        detail: `Through ${formatDate(state.previousSixMonthEnd)}`
      },
      {
        label: "Eligible Albums",
        value: formatNumber(state.eligibleAlbumIds.size),
        detail: "At least three distinct canonical catalogue tracks."
      },
      {
        label: "Official Album Debuts",
        value: formatNumber(state.albumDebuts.size),
        detail: "First simultaneous three-track Hot 100 qualification."
      }
    ];

    const recordCards = state.allRecords.slice(0, CONFIG.TABLE_LIMIT);

    ui.content.innerHTML = `
      <div class="records-grid">
        ${cards.map(card => `
          <article class="record-card">
            <div class="record-label">${escapeHTML(card.label)}</div>
            <div class="record-value">${escapeHTML(card.value)}</div>
            <div class="record-detail">${escapeHTML(card.detail)}</div>
          </article>
        `).join("")}
      </div>

      <div class="section-heading">
        <div>
          <h2>All-time record book</h2>
          <p>Achievements calculated from the available chart history.</p>
        </div>
      </div>

      <div class="records-grid">
        ${recordCards.map(record => `
          <article class="record-card">
            <div class="record-label">${escapeHTML(record.name)}</div>
            <div class="record-value">${escapeHTML(record.value)}</div>
            <div class="record-detail">
              ${record.id != null && record.type
                ? makePageLink(record.type, record.id, record.title)
                : escapeHTML(record.title)}
              <span class="cell-sub">${escapeHTML(record.detail)}</span>
            </div>
          </article>
        `).join("")}
      </div>

      <div class="notice">
        Song collaborator credits can overlap: every credited artist receives
        the song's full derived units sold. Album units belong to the lead
        album artist only, so artist-level totals are not additive across
        credited collaborators.
      </div>
    `;

    state.visibleRows = cards.map(card => ({
      title: card.label,
      value: card.value,
      detail: card.detail
    }));

    state.visibleColumns = [
      { key: "title", label: "Highlight" },
      { key: "value", label: "Value" },
      { key: "detail", label: "Detail" }
    ];
  }

  function renderContent() {
    const info = VIEW_INFO[state.currentView] || VIEW_INFO.overview;

    ui.title.textContent = info.title;
    ui.description.textContent = info.description;

    const filterDisabled =
      state.currentView === "overview" ||
      state.currentView === "records";

    $("#browser-section").style.display = filterDisabled ? "none" : "";
    ui.periodSwitch.hidden = state.currentView !== "periods";

    ui.periodSwitch.querySelectorAll("[data-period]").forEach(button => {
      button.classList.toggle(
        "active",
        button.dataset.period === state.periodMode
      );
    });

    if (state.currentView === "overview") renderOverview();
    else renderTable();
  }

  function setView(view) {
    if (!VIEW_INFO[view]) return;

    state.currentView = view;
    state.sortTouched = false;

    ui.nav.querySelectorAll("[data-view]").forEach(button => {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });

    configureSortMenu(true);
    renderContent();
  }

  /* ---------------------------------------------------------------
     EXPORT — DISPLAYED COLUMNS ONLY
  ---------------------------------------------------------------- */

  function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function getExportValue(row, key) {
    if (key === "topSong") {
      return row.topSong ? `${row.topSong.title} — ${row.topSong.artist}` : "";
    }

    if (key === "topAlbum") {
      return row.topAlbum ? `${row.topAlbum.title} — ${row.topAlbum.artist}` : "";
    }

    if (key === "songTitle") return row.songTitle ?? "";
    if (key === "albumTitle") return row.albumTitle ?? "";

    if (
      key === "unitsSold" ||
      key === "periodUnitsSold" ||
      key === "debutUnits" ||
      key === "songUnits" ||
      key === "albumUnits" ||
      key === "recentUnits" ||
      key === "songUnitsSold" ||
      key === "albumUnitsSold"
    ) {
      return row[key] == null ? "" : row[key];
    }

    // Prevent the internal objects from entering CSV by accident.
    const value = row[key];
    if (value && typeof value === "object") return "";
    return value ?? "";
  }

  function exportVisibleRows() {
    if (!state.visibleRows.length) {
      alert("There are no visible rows to export.");
      return;
    }

    const columns = state.visibleColumns;

    const content = [
      columns.map(column => csvEscape(column.label)),
      ...state.visibleRows.map(row =>
        columns.map(column => csvEscape(getExportValue(row, column.key)))
      )
    ].map(row => row.join(",")).join("\r\n");

    const blob = new Blob(["\uFEFF" + content], {
      type: "text/csv;charset=utf-8;"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download =
      `stats-paradise-${state.currentView}-${dateKey(Date.now())}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------------------------------------------------------------
     EVENTS AND STARTUP
  ---------------------------------------------------------------- */

  function registerEvents() {
    ui.nav.addEventListener("click", event => {
      const button = event.target.closest("[data-view]");
      if (button) setView(button.dataset.view);
    });

    ui.periodSwitch.addEventListener("click", event => {
      const button = event.target.closest("[data-period]");
      if (!button) return;

      state.periodMode = button.dataset.period;
      configureSortMenu(true);
      renderContent();
    });

    ui.search.addEventListener("input", renderContent);

    ui.timeMode.addEventListener("change", updateDateControls);

    ui.year.addEventListener("change", () => {
      if (!state.sortTouched) configureSortMenu(true);
      renderContent();
    });

    ui.sort.addEventListener("change", () => {
      state.sortTouched = true;
      renderContent();
    });

    ui.direction.addEventListener("change", renderContent);

    ui.dateFrom.addEventListener("change", () => {
      if (!state.sortTouched) configureSortMenu(true);
      renderContent();
    });

    ui.dateTo.addEventListener("change", () => {
      if (!state.sortTouched) configureSortMenu(true);
      renderContent();
    });

    ui.reset.addEventListener("click", resetFilters);
    ui.export.addEventListener("click", exportVisibleRows);
  }

  async function init() {
    registerEvents();

    try {
      setStatus("Loading Music Vault…", "warn");

      await fetchVaultFiles();
      buildAlbumTrackMap();
      buildChartArchive();
      aggregateEntityRecords();
      refreshYearOptions();
      renderSummary();
      configureSortMenu(true);
      renderContent();
    } catch (error) {
      console.error("Stats Paradise failed to initialise:", error);

      setStatus("Could not load source data", "bad");
      showError(error?.message || "An unknown error occurred.");

      ui.content.innerHTML = `
        <div class="empty">
          Check the Music Vault paths and browser console, then reload Stats Paradise.
        </div>
      `;
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

