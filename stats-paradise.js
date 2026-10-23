(() => {
  "use strict";

  /*
   * YOURHOT100 — STATS PARADISE
   *
   * Standalone historical statistics engine.
   *
   * Album rules:
   * 1. Catalogue eligibility requires 3 distinct canonical tracks.
   * 2. First official debut requires 3 distinct tracks simultaneously on
   *    the Hot 100, and this is a ONE-TIME activation.
   * 3. AFTER that activation, the normal album calculation applies every
   *    week. The album does not need 3 tracks on the Hot 100 again.
   *
   * Weeks are Friday–Thursday.
   * Only observed source weeks are constructed.
   * Tables are capped at 200 displayed rows; calculations use the full data.
   * Source activity and rank-score inputs are never displayed or exported.
   */

  const CONFIG = Object.freeze({
    MIN_ALBUM_TRACKS: 3,
    HOT100_SIZE: 100,
    TABLE_LIMIT: 200,
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
      description: "Song careers, chart peaks, No. 1 runs and lifetime derived units sold."
    },
    albums: {
      title: "Album Archive",
      description: "Catalogue eligibility, official debut records and album-chart careers."
    },
    artists: {
      title: "Artist Archive",
      description: "Artist achievements, credited songs, lead albums and six-month movement."
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
      title: "Debuts & Returns",
      description: "First appearances, official album debuts, re-entries and confirmed exits."
    },
    periods: {
      title: "Yearly & Monthly Performance",
      description: "Units sold and chart achievements aggregated over observed chart weeks."
    },
    records: {
      title: "The Record Book",
      description: "Dynamically calculated all-time achievements."
    }
  };

  const SORT_OPTIONS = {
    overview: [
      ["title", "Title"]
    ],
    songs: [
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
      ["unitsSold", "Career units sold"],
      ["latestRank", "Latest position"],
      ["peak", "Peak position"],
      ["weeksOnChart", "Weeks charted"],
      ["weeksAtNo1", "No. 1 weeks"],
      ["trackCount", "Distinct tracks"],
      ["debutTs", "Official debut date"],
      ["firstRankedTs", "First Top 100 appearance"],
      ["title", "Album title"],
      ["artist", "Lead artist"]
    ],
    artists: [
      ["recentUnits", "Latest six-month units"],
      ["unitsSold", "Career units sold"],
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
      ["dateTs", "Event date"],
      ["status", "Event"],
      ["type", "Chart"],
      ["rank", "Position"],
      ["unitsSold", "Units sold"],
      ["title", "Title"],
      ["artist", "Artist"]
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

    // Friday is day zero of a chart week.
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

    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > CONFIG.HOT100_SIZE
    ) {
      return "—";
    }

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

  /* ---------------------------------------------------------------
     CANONICAL ARTIST AND ALBUM RELATIONSHIPS
  ---------------------------------------------------------------- */

  function getArtistName(id) {
    if (id == null) return "Unknown Artist";

    const artist = state.artists.get(String(id));
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

    if (state.artists.has(key)) return key;

    const lower = key.toLowerCase();

    for (const [id, artist] of state.artists) {
      const name = String(artist?.name ?? artist?.title ?? "")
        .trim()
        .toLowerCase();

      if (name && name === lower) return String(id);
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
        // Continue with the source value; this is handled below.
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

    if (leadId && !ids.includes(leadId)) {
      ids.unshift(leadId);
    }

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

    // Follow the existing vault's track-to-album relationship.
    const listed = Array.isArray(track.album_ids)
      ? track.album_ids
      : [];

    if (listed.length) {
      return unique(listed);
    }

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
      albumTrackMap.set(
        String(albumId),
        new Set(getTrackIdsFromAlbum(album))
      );
    });

    // Include the reverse relationship from each canonical track as well.
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

    // Catalogue eligibility only. No chart debut is implied here.
    state.eligibleAlbumIds = new Set();

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

  /*
   * Keep the existing operation sequence:
   * 1. Sort candidates by weekly activity.
   * 2. Keep the activity-ranked Top 100.
   * 3. Calculate the established derived units using that rank score.
   * 4. Sort the selected Top 100 by derived units and assign displayed rank.
   *
   * The activity counts and rank scores remain internal.
   */
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

  /*
   * If the debuting album cannot receive modelled units under the existing
   * activity-ranked Top 100 calculation, return null rather than inventing
   * a score or rank outside the established model.
   */
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

    if (
      activityIndex < 0 ||
      activityIndex >= CONFIG.HOT100_SIZE
    ) {
      return null;
    }

    return (
      candidates[activityIndex].activityCount *
        CONFIG.ALBUM_UNIT_FACTOR +
      rankScoreForRank(activityIndex + 1) *
        CONFIG.RANK_UNIT_FACTOR
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
          "Check the paths and make sure the page is served from the project root."
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

    // Do not construct artificial snapshots for missing source weeks.
    const weekStarts = [...groupedEvents.keys()].sort((a, b) => a - b);

    if (!weekStarts.length) {
      throw new Error("No chart weeks could be constructed from the source history.");
    }

    state.earliestWeekStart = weekStarts[0];
    state.latestWeekStart = weekStarts[weekStarts.length - 1];

    state.currentSixMonthStart =
      shiftMonthsUTC(state.latestWeekStart, -6);

    state.previousSixMonthEnd = state.currentSixMonthStart - 1;

    state.previousSixMonthStart =
      shiftMonthsUTC(state.latestWeekStart, -12);

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

        const albumIds = state.trackToAlbums.get(trackId) || new Set();

        albumIds.forEach(albumId => {
          if (!state.eligibleAlbumIds.has(String(albumId))) return;

          albumCounts.set(
            String(albumId),
            (albumCounts.get(String(albumId)) || 0) + 1
          );
        });
      });

      // Build this week's Hot 100 using the established song model.
      const songs = makeChartEntries(trackCounts, "songs");

      const chartingSongIds = new Set(
        songs.map(entry => String(entry.id))
      );

      /*
       * ONE-TIME DEBUT ACTIVATION.
       *
       * Catalogue eligibility was calculated separately and is static.
       * An eligible album now officially debuts if this is the first
       * snapshot with 3 or more distinct album tracks in the Hot 100.
       */
      state.eligibleAlbumIds.forEach(albumId => {
        const id = String(albumId);

        if (state.debutedAlbumIds.has(id)) return;

        const trackIds = state.albumTrackMap.get(id) || new Set();

        let simultaneousTracks = 0;

        trackIds.forEach(trackId => {
          if (chartingSongIds.has(String(trackId))) {
            simultaneousTracks++;
          }
        });

        if (simultaneousTracks < CONFIG.MIN_ALBUM_TRACKS) return;

        state.debutedAlbumIds.add(id);

        state.albumDebuts.set(id, {
          weekStart,
          simultaneousTracks,
          unitsSold: null,
          rank: null
        });
      });

      /*
       * IMPORTANT:
       * The album chart is filtered by albums that have ALREADY debuted.
       * There is deliberately NO recurring three-track Hot 100 test here.
       *
       * Once an album is activated, it follows the normal YourHot100 album
       * activity, derived-units and Top 100 ranking calculation every week.
       * The album can chart even if only one or zero of its tracks appear
       * on the Hot 100 that week, provided the normal album calculation
       * produces an eligible ranked result.
       */
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
     RECORD AGGREGATION
  ---------------------------------------------------------------- */

  function newEntityRecord(entry, firstWeek) {
    return {
      id: String(entry.id),
      title: entry.title,
      artist: entry.artist,
      artistIds: entry.artistIds || [],
      leadArtistId: entry.leadArtistId || null,

      firstChartDate: firstWeek,
      firstRankedOffset: firstWeek,
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
      if (snapshot.weekStart <= timestamp) {
        result = snapshot;
      } else {
        break;
      }
    }

    return result;
  }

  function aggregateEntityRecords() {
    const songs = new Map();
    const albumChartRecords = new Map();

    const weeklyRecords = [];
    const numberOneRecords = [];
    const songEvents = [];
    const albumReentryEvents = [];
    const exitRecords = [];

    let previousSnapshot = null;

    for (const snapshot of state.snapshots) {
      const weekStart = snapshot.weekStart;

      const songIdsNow = new Set(
        snapshot.songs.map(entry => String(entry.id))
      );

      const albumIdsNow = new Set(
        snapshot.albums.map(entry => String(entry.id))
      );

      const currentSongIds = new Set();

      snapshot.songs.forEach(entry => {
        const id = String(entry.id);
        currentSongIds.add(id);

        let record = songs.get(id);
        let entryStatus = null;

        if (!record) {
          record = newEntityRecord(entry, weekStart);
          songs.set(id, record);
          entryStatus = "Debut";
        } else if (
          previousSnapshot &&
          previousSnapshot.weekStart + CONFIG.WEEK_MS === weekStart &&
          !previousSnapshot.songs.some(
            oldEntry => String(oldEntry.id) === id
          )
        ) {
          entryStatus = "Re-entry";
        }

        const consecutive =
          record.lastOffset + CONFIG.WEEK_MS === weekStart;

        record.currentChartStreak = consecutive
          ? record.currentChartStreak + 1
          : 1;

        record.maxChartStreak = Math.max(
          record.maxChartStreak,
          record.currentChartStreak
        );

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

        // Keep the first date the all-time best position was achieved.
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
          record.maxNo1Streak = Math.max(
            record.maxNo1Streak,
            record.currentNo1Streak
          );

          if (record.firstNo1Date == null) {
            record.firstNo1Date = weekStart;
          }
        } else {
          record.currentNo1Streak = 0;
          record.lastNo1Offset = null;
        }

        if (entry.rank <= 10) record.weeksTop10++;
        if (entry.rank <= 20) record.weeksTop20++;
        if (entry.rank <= 40) record.weeksTop40++;
        if (entry.rank <= 50) record.weeksTop50++;
        if (entry.rank <= 100) record.weeksTop100++;

        if (
          !record.bestWeek ||
          Number(entry.unitsSold || 0) > record.bestWeek.unitsSold
        ) {
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
          albumChartRecords.set(id, record);
          entryStatus = "First Top 100 appearance";
        } else if (
          previousSnapshot &&
          previousSnapshot.weekStart + CONFIG.WEEK_MS === weekStart &&
          !previousSnapshot.albums.some(
            oldEntry => String(oldEntry.id) === id
          )
        ) {
          entryStatus = "Re-entry";
        }

        const consecutive =
          record.lastOffset + CONFIG.WEEK_MS === weekStart;

        record.currentChartStreak = consecutive
          ? record.currentChartStreak + 1
          : 1;

        record.maxChartStreak = Math.max(
          record.maxChartStreak,
          record.currentChartStreak
        );

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
          record.maxNo1Streak = Math.max(
            record.maxNo1Streak,
            record.currentNo1Streak
          );

          if (record.firstNo1Date == null) {
            record.firstNo1Date = weekStart;
          }
        } else {
          record.currentNo1Streak = 0;
          record.lastNo1Offset = null;
        }

        if (entry.rank <= 10) record.weeksTop10++;
        if (entry.rank <= 20) record.weeksTop20++;
        if (entry.rank <= 40) record.weeksTop40++;
        if (entry.rank <= 50) record.weeksTop50++;
        if (entry.rank <= 100) record.weeksTop100++;

        if (
          !record.bestWeek ||
          Number(entry.unitsSold || 0) > record.bestWeek.unitsSold
        ) {
          record.bestWeek = {
            weekStart,
            rank: entry.rank,
            unitsSold: Number(entry.unitsSold || 0)
          };
        }

        if (entryStatus === "Re-entry") {
          albumReentryEvents.push({
            dateTs: weekStart,
            date: formatDate(weekStart),
            type: "Album",
            status: entryStatus,
            title: entry.title,
            artist: entry.artist,
            rank: entry.rank,
            unitsSold: entry.unitsSold,
            id
          });
        }
      });

      // Confirm exits only between adjacent observed calendar weeks.
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

      const no1Song =
        snapshot.songs.find(entry => entry.rank === 1) || null;

      const no1Album =
        snapshot.albums.find(entry => entry.rank === 1) || null;

      const songEntryEventsThisWeek = songEvents.filter(
        event => event.dateTs === weekStart
      );

      weeklyRecords.push({
        dateTs: weekStart,
        date: formatDate(weekStart),
        year: new Date(weekStart).getUTCFullYear(),
        songCount: snapshot.songs.length,
        albumCount: snapshot.albums.length,
        newEntries: songEntryEventsThisWeek.filter(
          event => event.status === "Debut"
        ).length,
        reentries: songEntryEventsThisWeek.filter(
          event => event.status === "Re-entry"
        ).length,
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
      (latestSnapshot?.songs || []).map(entry => [
        String(entry.id),
        entry
      ])
    );

    const latestAlbumEntries = new Map(
      (latestSnapshot?.albums || []).map(entry => [
        String(entry.id),
        entry
      ])
    );

    state.songRecords = [...songs.values()].map(record => {
      const track = state.tracks.get(String(record.id));

      const firstPeakIndex = record.history.findIndex(
        entry => entry.rank === record.peak
      );

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
        weeksToPeak: firstPeakIndex >= 0 ? firstPeakIndex + 1 : null,
        currentChartStreak: calculateCurrentStreak(record.history),
        officialDebuted: true,
        recentHistory: record.history
      };
    });

    /*
     * Include every statically eligible album, including releases that have
     * not yet officially debuted or have never ranked in the album Top 100.
     */
    state.albumRecords = [...state.eligibleAlbumIds].map(albumId => {
      const id = String(albumId);
      const album = state.albums.get(id);
      const chartRecord = albumChartRecords.get(id) || null;
      const activation = state.albumDebuts.get(id) || null;

      const albumHistory = chartRecord?.history || [];
      const hasRankedDebutWeek = activation
        ? albumHistory.some(item => item.weekStart === activation.weekStart)
        : false;

      const rankedUnits = chartRecord?.unitsSold ?? 0;

      // If a valid debut-week units figure was calculated outside a ranked
      // album-chart appearance, include it once, never twice.
      const extraDebutUnits =
        activation && !hasRankedDebutWeek
          ? Number(activation.unitsSold || 0)
          : 0;

      const careerUnits = chartRecord
        ? rankedUnits + extraDebutUnits
        : activation?.unitsSold ?? null;

      const trackCount =
        state.albumTrackMap.get(id)?.size ?? 0;

      const latestEntry = latestAlbumEntries.get(id) || null;

      const officialDebutDate = activation
        ? formatDate(activation.weekStart)
        : "Not debuted";

      const firstRankedTs = chartRecord?.firstChartDate ?? null;

      let status;

      if (!activation) {
        status = "Eligible · not debuted";
      } else if (latestEntry) {
        status = "Debuted · currently ranked";
      } else if (chartRecord) {
        status = "Debuted · not currently ranked";
      } else {
        status = "Debuted · no Top 100 appearance";
      }

      const firstPeakIndex = chartRecord
        ? chartRecord.history.findIndex(
            item => item.rank === chartRecord.peak
          )
        : -1;

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

        debutDate: officialDebutDate,
        debutTs: activation?.weekStart ?? null,
        debutUnits: activation?.unitsSold ?? null,
        qualifyingTracksAtDebut: activation?.simultaneousTracks ?? null,

        firstRankedDate: firstRankedTs == null
          ? "—"
          : formatDate(firstRankedTs),
        firstRankedTs,

        latestRank: latestEntry?.rank ?? null,
        peak: chartRecord?.weeksOnChart ? chartRecord.peak : null,
        peakOffset: chartRecord?.peakOffset ?? null,
        peakDate: chartRecord?.peakOffset == null
          ? "—"
          : formatDate(chartRecord.peakOffset),
        firstNo1Date: chartRecord?.firstNo1Date == null
          ? "—"
          : formatDate(chartRecord.firstNo1Date),
        firstNo1Ts: chartRecord?.firstNo1Date ?? null,

        lastOffset: chartRecord?.lastOffset ?? null,
        lastDate: chartRecord?.lastOffset == null
          ? "—"
          : formatDate(chartRecord.lastOffset),

        weeksOnChart: chartRecord?.weeksOnChart ?? 0,
        weeksAtNo1: chartRecord?.weeksAtNo1 ?? 0,
        weeksTop10: chartRecord?.weeksTop10 ?? 0,
        weeksTop20: chartRecord?.weeksTop20 ?? 0,
        weeksTop40: chartRecord?.weeksTop40 ?? 0,
        weeksTop50: chartRecord?.weeksTop50 ?? 0,
        weeksTop100: chartRecord?.weeksTop100 ?? 0,

        maxNo1Streak: chartRecord?.maxNo1Streak ?? 0,
        maxChartStreak: chartRecord?.maxChartStreak ?? 0,
        currentChartStreak: chartRecord
          ? calculateCurrentStreak(chartRecord.history)
          : 0,

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

    /*
     * Official album debuts are separate from first ranked album Top 100
     * appearances. When both occur in the same week, one event describes both.
     */
    const officialAlbumEvents = [];

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

      const record = state.albumRecords.find(item => item.id === id);

      if (
        record &&
        record.firstRankedTs != null &&
        record.firstRankedTs !== activation.weekStart
      ) {
        officialAlbumEvents.push({
          dateTs: record.firstRankedTs,
          date: formatDate(record.firstRankedTs),
          type: "Album",
          status: "First Top 100 appearance",
          title: record.title,
          artist: record.artist,
          rank: record.history[0]?.rank ?? null,
          unitsSold: record.history[0]?.unitsSold ?? null,
          id
        });
      }
    });

    state.debutRecords = [
      ...songEvents,
      ...officialAlbumEvents,
      ...albumReentryEvents
    ].sort((a, b) => b.dateTs - a.dateTs);

    state.exitRecords = exitRecords;

    calculateMovement();
    calculateArtistRecords();
    calculateRecordBook();
  }

  /* ---------------------------------------------------------------
     SIX-MONTH SONG AND ALBUM MOVEMENT
  ---------------------------------------------------------------- */

  function calculateMovement() {
    const latest = state.snapshots[state.snapshots.length - 1];
    if (!latest) return;

    const comparison = findSnapshotOnOrBefore(
      state.currentSixMonthStart
    );

    const oldSongRanks = new Map(
      (comparison?.songs || []).map(entry => [
        String(entry.id),
        entry.rank
      ])
    );

    const oldAlbumRanks = new Map(
      (comparison?.albums || []).map(entry => [
        String(entry.id),
        entry.rank
      ])
    );

    state.songRecords.forEach(record => {
      const oldRank = oldSongRanks.get(String(record.id));

      if (record.latestRank == null) {
        record.movement = "Not currently charting";
        record.movementValue = null;
      } else if (oldRank == null) {
        record.movement = record.firstChartDate >= state.currentSixMonthStart
          ? "New"
          : "No comparable rank";
        record.movementValue = null;
      } else {
        record.movementValue = oldRank - record.latestRank;
        record.movement = record.movementValue > 0
          ? `Up ${record.movementValue}`
          : record.movementValue < 0
            ? `Down ${Math.abs(record.movementValue)}`
            : "Unchanged";
      }
    });

    state.albumRecords.forEach(record => {
      const oldRank = oldAlbumRanks.get(String(record.id));

      if (!record.officialDebuted) {
        record.movement = "Not debuted";
        record.movementValue = null;
      } else if (record.latestRank == null) {
        record.movement = "Not currently ranked";
        record.movementValue = null;
      } else if (oldRank == null) {
        record.movement = record.debutTs >= state.currentSixMonthStart
          ? "New"
          : "No comparable rank";
        record.movementValue = null;
      } else {
        record.movementValue = oldRank - record.latestRank;
        record.movement = record.movementValue > 0
          ? `Up ${record.movementValue}`
          : record.movementValue < 0
            ? `Down ${Math.abs(record.movementValue)}`
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
          name: getArtistName(key),

          songUnitsSold: 0,
          albumUnitsSold: 0,
          unitsSold: 0,

          recentUnits: 0,
          previousUnits: 0,

          songIds: new Set(),
          songNo1Ids: new Set(),
          albumIds: new Set(),

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

        if (entry.rank === 1) artist.albumNo1Weeks++;

        if (isRecent) artist.recentUnits += units;
        if (isPrevious) artist.previousUnits += units;
      });
    }

    /*
     * Include a valid official album debut units result only if the album
     * was not already counted as a ranked entry in that exact week.
     */
    state.albumDebuts.forEach((activation, albumId) => {
      if (activation.unitsSold == null) return;

      const rankedThatWeek = state.snapshots.some(snapshot =>
        snapshot.weekStart === activation.weekStart &&
        snapshot.albums.some(entry =>
          String(entry.id) === String(albumId)
        )
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
      artist.top10WeeksCount = artist.top10Weeks.size;
      artist.no1Weeks = artist.songNo1Weeks + artist.albumNo1Weeks;
      artist.lastDateTs = artist.appearanceDates.length
        ? Math.max(...artist.appearanceDates)
        : null;

      if (artist.previousUnits === 0 && artist.recentUnits > 0) {
        artist.movement = "New / no prior units";
        artist.movementValue = null;
      } else if (artist.previousUnits === 0 && artist.recentUnits === 0) {
        artist.movement = "No six-month activity";
        artist.movementValue = null;
      } else {
        artist.movementValue =
          artist.recentUnits - artist.previousUnits;

        artist.movement = artist.movementValue > 0
          ? `Up ${formatUnits(artist.movementValue)}`
          : artist.movementValue < 0
            ? `Down ${formatUnits(Math.abs(artist.movementValue))}`
            : "Unchanged";
      }

      artist.appearanceDates = unique(artist.appearanceDates.map(String))
        .map(Number);

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

      if (artist.currentSixMonthRank == null) {
        artist.rankMovement = artist.previousSixMonthRank != null
          ? "Left recent leaderboard"
          : "No recent rank";
      } else if (artist.previousSixMonthRank == null) {
        artist.rankMovement = "New";
      } else {
        const change =
          artist.previousSixMonthRank - artist.currentSixMonthRank;

        artist.rankMovement = change > 0
          ? `Up ${change}`
          : change < 0
            ? `Down ${Math.abs(change)}`
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

      const key = periodMode === "year"
        ? String(year)
        : `${year}-${month}`;

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

      const songNo1 = snapshot.songs.find(entry => entry.rank === 1);
      const albumNo1 = snapshot.albums.find(entry => entry.rank === 1);

      if (songNo1) record.songNo1Weeks++;
      if (albumNo1) record.albumNo1Weeks++;

      snapshot.songs.forEach(entry => {
        record.songUnitsSold += Number(entry.unitsSold || 0);
      });

      snapshot.albums.forEach(entry => {
        record.albumUnitsSold += Number(entry.unitsSold || 0);
      });

      record.unitsSold =
        record.songUnitsSold + record.albumUnitsSold;
    });

    return [...records.values()].sort(
      (a, b) => b.dateTs - a.dateTs
    );
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
        valueNumber: Number.isFinite(Number(numeric))
          ? Number(numeric)
          : 0,
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

    const longestSongNo1 = best(songs, item => item.maxNo1Streak);
    const mostSongNo1Weeks = best(songs, item => item.weeksAtNo1);
    const longestSongRun = best(songs, item => item.maxChartStreak);
    const mostSongTop10 = best(songs, item => item.weeksTop10);
    const mostSongUnits = best(songs, item => item.unitsSold);
    const longestSongRunNo1 = best(songs, item => item.weeksAtNo1);

   const longestAlbumNo1 = best(albums, item => item.maxNo1Streak);
const mostAlbumNo1Weeks = best(albums, item => item.weeksAtNo1);
const mostAlbumNo1 = mostAlbumNo1Weeks;
const longestAlbumRun = best(albums, item => item.maxChartStreak);
const mostAlbumUnits = best(albums, item => item.unitsSold);

    const artistMostSongNo1 = best(artists, item => item.songNo1Count);
    const artistMostSongs = best(artists, item => item.songCount);
    const artistMostTop10 = best(artists, item => item.maxTop10SongsInWeek);
    const artistMostAlbumNo1 = best(artists, item => item.albumNo1Weeks);
    const artistMostUnits = best(artists, item => item.unitsSold);

    if (longestSongNo1) {
      add(
        "Longest song No. 1 streak",
        `${longestSongNo1.maxNo1Streak} weeks`,
        longestSongNo1.title,
        longestSongNo1.artist,
        longestSongNo1.maxNo1Streak,
        "Song",
        longestSongNo1.id
      );
    }

    if (mostSongNo1Weeks) {
      add(
        "Most song weeks at No. 1",
        `${mostSongNo1Weeks.weeksAtNo1} weeks`,
        mostSongNo1Weeks.title,
        mostSongNo1Weeks.artist,
        mostSongNo1Weeks.weeksAtNo1,
        "Song",
        mostSongNo1Weeks.id
      );
    }

    if (longestSongRun) {
      add(
        "Longest song chart run",
        `${longestSongRun.maxChartStreak} weeks`,
        longestSongRun.title,
        longestSongRun.artist,
        longestSongRun.maxChartStreak,
        "Song",
        longestSongRun.id
      );
    }

    if (mostSongTop10) {
      add(
        "Most song Top 10 weeks",
        `${mostSongTop10.weeksTop10} weeks`,
        mostSongTop10.title,
        mostSongTop10.artist,
        mostSongTop10.weeksTop10,
        "Song",
        mostSongTop10.id
      );
    }

    if (mostSongUnits) {
      add(
        "Highest career song units sold",
        formatUnits(mostSongUnits.unitsSold),
        mostSongUnits.title,
        mostSongUnits.artist,
        mostSongUnits.unitsSold,
        "Song",
        mostSongUnits.id
      );
    }

    if (longestAlbumNo1) {
      add(
        "Longest album No. 1 streak",
        `${longestAlbumNo1.maxNo1Streak} weeks`,
        longestAlbumNo1.title,
        longestAlbumNo1.artist,
        longestAlbumNo1.maxNo1Streak,
        "Album",
        longestAlbumNo1.id
      );
    }

    if (mostAlbumNo1Weeks) {
      add(
        "Most album weeks at No. 1",
        `${mostAlbumNo1Weeks.weeksAtNo1} weeks`,
        mostAlbumNo1.title,
        mostAlbumNo1.artist,
        mostAlbumNo1.weeksAtNo1,
        "Album",
        mostAlbumNo1.id
      );
    }

    if (longestAlbumRun) {
      add(
        "Longest album chart run",
        `${longestAlbumRun.maxChartStreak} weeks`,
        longestAlbumRun.title,
        longestAlbumRun.artist,
        longestAlbumRun.maxChartStreak,
        "Album",
        longestAlbumRun.id
      );
    }

    if (mostAlbumUnits) {
      add(
        "Highest career album units sold",
        formatUnits(mostAlbumUnits.unitsSold),
        mostAlbumUnits.title,
        mostAlbumUnits.artist,
        mostAlbumUnits.unitsSold,
        "Album",
        mostAlbumUnits.id
      );
    }

    if (artistMostSongNo1) {
      add(
        "Most distinct No. 1 songs credited",
        `${artistMostSongNo1.songNo1Count} songs`,
        artistMostSongNo1.name,
        "Artist credits",
        artistMostSongNo1.songNo1Count,
        "Artist",
        artistMostSongNo1.id
      );
    }

    if (artistMostSongs) {
      add(
        "Most distinct songs charted",
        `${artistMostSongs.songCount} songs`,
        artistMostSongs.name,
        "Artist",
        artistMostSongs.songCount,
        "Artist",
        artistMostSongs.id
      );
    }

    if (artistMostTop10) {
      add(
        "Most Top 10 songs in one week",
        `${artistMostTop10.maxTop10SongsInWeek} songs`,
        artistMostTop10.name,
        "Artist",
        artistMostTop10.maxTop10SongsInWeek,
        "Artist",
        artistMostTop10.id
      );
    }

    if (artistMostAlbumNo1) {
      add(
        "Most lead-album No. 1 weeks",
        `${artistMostAlbumNo1.albumNo1Weeks} weeks`,
        artistMostAlbumNo1.name,
        "Lead album artist",
        artistMostAlbumNo1.albumNo1Weeks,
        "Artist",
        artistMostAlbumNo1.id
      );
    }

    if (artistMostUnits) {
      add(
        "Highest combined artist units sold",
        formatUnits(artistMostUnits.unitsSold),
        artistMostUnits.name,
        "Song credits plus lead-album credits",
        artistMostUnits.unitsSold,
        "Artist",
        artistMostUnits.id
      );
    }

    add(
      "Observed chart weeks",
      formatNumber(state.snapshots.length),
      formatDate(state.earliestWeekStart),
      `Latest observed week: ${formatDate(state.latestWeekStart)}`,
      state.snapshots.length
    );

    add(
      "Distinct songs charted",
      formatNumber(state.songRecords.length),
      "YourHot100 song archive",
      "Canonical song records",
      state.songRecords.length
    );

    add(
      "Eligible catalogue albums",
      formatNumber(state.eligibleAlbumIds.size),
      "YourHot100 album archive",
      "At least three distinct canonical catalogue tracks",
      state.eligibleAlbumIds.size
    );

    add(
      "Officially debuted albums",
      formatNumber(state.albumDebuts.size),
      "Official album debut archive",
      "First qualifying simultaneous three-track Hot 100 week",
      state.albumDebuts.size
    );

    state.allRecords = records;
  }

  /* ---------------------------------------------------------------
     FILTERS, SORTING AND VIEW DATA
  ---------------------------------------------------------------- */

  function currentViewRows() {
    switch (state.currentView) {
      case "songs": return state.songRecords;
      case "albums": return state.albumRecords;
      case "artists": return state.artistRecords;
      case "weeks": return state.weeklyRecords;
      case "numberones": return state.numberOneRecords;
      case "debuts": return [...state.debutRecords, ...state.exitRecords];
      case "periods": return buildPeriodRecords(state.periodMode);
      case "records": return state.allRecords;
      default: return [];
    }
  }

  function historyMatchesPeriod(history, from, to) {
    return (history || []).some(entry =>
      entry.weekStart >= from && entry.weekStart <= to
    );
  }

  function rowMatchesDate(row) {
    const mode = ui.timeMode.value;

    if (
      mode === "all" ||
      state.currentView === "overview" ||
      state.currentView === "records"
    ) {
      return true;
    }

    let from = -Infinity;
    let to = Infinity;

    if (mode === "year") {
      const year = Number(ui.year.value);
      if (!(year > 0)) return false;

      from = Date.UTC(year, 0, 1);
      to = Date.UTC(year, 11, 31, 23, 59, 59, 999);
    } else if (mode === "custom") {
      from = ui.dateFrom.value
        ? Date.parse(`${ui.dateFrom.value}T00:00:00Z`)
        : -Infinity;

      to = ui.dateTo.value
        ? Date.parse(`${ui.dateTo.value}T23:59:59Z`)
        : Infinity;

      if (from > to) return false;
    } else if (mode === "recent6") {
      from = state.currentSixMonthStart;
      to = state.latestWeekStart;
    } else if (mode === "previous6") {
      from = state.previousSixMonthStart;
      to = state.currentSixMonthStart - 1;
    }

    if (state.currentView === "songs" || state.currentView === "albums") {
      const history = row.history || [];

      if (historyMatchesPeriod(history, from, to)) return true;

      // Official album debut can exist even without a ranked Top 100 entry.
      return state.currentView === "albums" &&
        row.officialDebuted &&
        Number.isFinite(row.debutTs) &&
        row.debutTs >= from &&
        row.debutTs <= to;
    }

    if (state.currentView === "artists") {
      return historyMatchesPeriod(
        (row.appearanceDates || []).map(weekStart => ({ weekStart })),
        from,
        to
      );
    }

    const timestamp = row.dateTs;
    return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
  }

  function searchValue(row) {
    // Search only approved display fields. Do not traverse internal history,
    // count maps or the private source-data structures.
    const fieldsByView = {
      songs: [
        "title", "artist", "debutDate", "peakDate", "lastDate", "movement", "id"
      ],
      albums: [
        "title", "artist", "status", "debutDate", "firstRankedDate",
        "peakDate", "lastDate", "movement", "id"
      ],
      artists: [
        "name", "movement", "rankMovement", "id"
      ],
      weeks: [
        "date", "year"
      ],
      numberones: [
        "date", "songTitle", "songArtist", "albumTitle", "albumArtist"
      ],
      debuts: [
        "date", "status", "type", "title", "artist", "id"
      ],
      periods: [
        "period"
      ],
      records: [
        "name", "value", "title", "detail"
      ]
    };

    const fields = fieldsByView[state.currentView] || [];

    return fields
      .map(key => {
        const value = row[key];

        if (value && typeof value === "object") {
          return value.title ?? value.name ?? "";
        }

        return value ?? "";
      })
      .join(" ")
      .toLowerCase();
  }

  function defaultSortField() {
    const defaults = {
      songs: "unitsSold",
      albums: "unitsSold",
      artists: "recentUnits",
      weeks: "dateTs",
      numberones: "dateTs",
      debuts: "dateTs",
      periods: "unitsSold",
      records: "valueNumber"
    };

    return defaults[state.currentView] || "title";
  }

  function configureSortMenu() {
    const options = SORT_OPTIONS[state.currentView] || [];
    const selected = ui.sort.value;

    ui.sort.innerHTML = options.map(([value, label]) =>
      `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`
    ).join("");

    const desired = options.some(([value]) => value === selected)
      ? selected
      : defaultSortField();

    ui.sort.value = options.some(([value]) => value === desired)
      ? desired
      : options[0]?.[0] || "";
  }

  function getFilteredRows() {
    const query = ui.search.value.trim().toLowerCase();

    let rows = currentViewRows().filter(row => rowMatchesDate(row));

    if (query) {
      rows = rows.filter(row => searchValue(row).includes(query));
    }

    const sortField = ui.sort.value || defaultSortField();
    const direction = ui.direction.value === "asc" ? 1 : -1;

    rows = [...rows].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];

      const aMissing = av == null || av === "";
      const bMissing = bv == null || bv === "";

      // Unavailable values stay last in either sort direction.
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

    return rows.slice(0, CONFIG.TABLE_LIMIT);
  }

  function refreshYearOptions() {
    const selected = ui.year.value;

    state.years = [...new Set(state.snapshots.map(snapshot =>
      new Date(snapshot.weekStart).getUTCFullYear()
    ))].sort((a, b) => b - a);

    ui.year.innerHTML = [
      '<option value="">Choose year</option>',
      ...state.years.map(year =>
        `<option value="${year}">${year}</option>`
      )
    ].join("");

    if (state.years.includes(Number(selected))) {
      ui.year.value = selected;
    }
  }

  function updateDateControls() {
    ui.year.disabled = ui.timeMode.value !== "year";
    ui.customDates.hidden = ui.timeMode.value !== "custom";
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

    configureSortMenu();
    renderContent();
  }

  /* ---------------------------------------------------------------
     RENDERING
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
        note: "First simultaneous three-track Hot 100 week"
      },
      {
        label: "Ranked Album Records",
        value: formatNumber(
          state.albumRecords.filter(album => album.weeksOnChart > 0).length
        ),
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

    setStatus(
      `Loaded · latest week ${formatDate(state.latestWeekStart)}`,
      "good"
    );
  }

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

  function trendClass(value) {
    const text = String(value ?? "").toLowerCase();

    if (text.startsWith("up")) return "trend-up";
    if (text.startsWith("down")) return "trend-down";
    if (text === "new" || text.startsWith("new /")) return "trend-new";

    return "trend-neutral";
  }

  function getColumns(view) {
    const columns = {
      songs: [
        ["latestRank", "Latest position"],
        ["title", "Song"],
        ["artist", "Artist"],
        ["peak", "Peak"],
        ["debutDate", "Debut date"],
        ["firstNo1Date", "First No. 1"],
        ["weeksOnChart", "Weeks charted"],
        ["weeksAtNo1", "No. 1 weeks"],
        ["weeksTop10", "Top 10 weeks"],
        ["unitsSold", "Career units sold"],
        ["movement", "Six-month movement"]
      ],
      albums: [
        ["status", "Album status"],
        ["title", "Album"],
        ["artist", "Lead artist"],
        ["trackCount", "Catalogue tracks"],
        ["qualifyingTracksAtDebut", "Tracks at debut"],
        ["debutDate", "Official debut"],
        ["debutUnits", "Debut-week units sold"],
        ["firstRankedDate", "First Top 100"],
        ["latestRank", "Latest position"],
        ["peak", "Peak"],
        ["weeksOnChart", "Weeks charted"],
        ["weeksAtNo1", "No. 1 weeks"],
        ["unitsSold", "Career units sold"],
        ["movement", "Six-month movement"]
      ],
      artists: [
        ["currentSixMonthRank", "Recent rank"],
        ["name", "Artist"],
        ["songCount", "Songs charted"],
        ["songNo1Count", "No. 1 songs"],
        ["albumCount", "Lead albums"],
        ["songNo1Weeks", "Song No. 1 weeks"],
        ["albumNo1Weeks", "Album No. 1 weeks"],
        ["unitsSold", "Career units sold"],
        ["recentUnits", "Recent six-month units"],
        ["movement", "Sales movement"],
        ["rankMovement", "Rank movement"]
      ],
      weeks: [
        ["date", "Chart week"],
        ["songCount", "Songs charted"],
        ["albumCount", "Albums charted"],
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
        ["date", "Event date"],
        ["type", "Chart"],
        ["status", "Event"],
        ["rank", "Position"],
        ["title", "Title"],
        ["artist", "Artist"],
        ["unitsSold", "Units sold"],
        ["simultaneousTracks", "Tracks at album debut"]
      ],
      periods: state.periodMode === "year"
        ? [
            ["period", "Year"],
            ["chartWeeks", "Observed chart weeks"],
            ["songAppearances", "Song appearances"],
            ["albumAppearances", "Album appearances"],
            ["songNo1Weeks", "Song No. 1 weeks"],
            ["albumNo1Weeks", "Album No. 1 weeks"],
            ["songUnitsSold", "Song units sold"],
            ["albumUnitsSold", "Album units sold"],
            ["unitsSold", "Combined units sold"]
          ]
        : [
            ["period", "Month"],
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

  function renderCell(row, column) {
    const key = column.key;

    if (key === "title") {
      const type = row.type;
      return `<span class="cell-main">${makePageLink(type, row.id, row.title)}</span>`;
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

    if (key === "movement" || key === "rankMovement") {
      const value = row[key] ?? "—";
      return `<span class="${trendClass(value)}">${escapeHTML(value)}</span>`;
    }

    if (key === "latestRank" || key === "rank" || key === "peak") {
      return `<span class="rank">${escapeHTML(formatPosition(row[key]))}</span>`;
    }

    if (
      key === "unitsSold" ||
      key === "debutUnits" ||
      key === "songUnits" ||
      key === "albumUnits" ||
      key === "recentUnits" ||
      key === "songUnitsSold" ||
      key === "albumUnitsSold"
    ) {
      return escapeHTML(formatUnits(row[key]));
    }

    if (key === "debutDate" || key === "firstRankedDate" ||
        key === "peakDate" || key === "firstNo1Date" ||
        key === "lastDate") {
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
    const rows = getFilteredRows();

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
        ${formatNumber(currentViewRows().filter(rowMatchesDate).length)}
        matching records. Maximum ${CONFIG.TABLE_LIMIT} rows per view.
      </div>
      <div class="table-wrap">
        <table>
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

    const records = state.allRecords.slice(0, CONFIG.TABLE_LIMIT);

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
        ${records.map(record => `
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

    if (state.currentView === "overview") {
      renderOverview();
    } else {
      renderTable();
    }
  }

  function setView(view) {
    if (!VIEW_INFO[view]) return;

    state.currentView = view;

    ui.nav.querySelectorAll("[data-view]").forEach(button => {
      const active = button.dataset.view === view;

      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });

    configureSortMenu();
    renderContent();
  }

  /* ---------------------------------------------------------------
     EXPORT — ONLY EXPLICIT DISPLAY COLUMNS
  ---------------------------------------------------------------- */

  function csvEscape(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function getExportValue(row, key) {
    if (key === "topSong") {
      return row.topSong
        ? `${row.topSong.title} — ${row.topSong.artist}`
        : "";
    }

    if (key === "topAlbum") {
      return row.topAlbum
        ? `${row.topAlbum.title} — ${row.topAlbum.artist}`
        : "";
    }

    if (key === "songTitle") return row.songTitle ?? "";
    if (key === "albumTitle") return row.albumTitle ?? "";

    if (
      key === "unitsSold" ||
      key === "debutUnits" ||
      key === "songUnits" ||
      key === "albumUnits" ||
      key === "recentUnits" ||
      key === "songUnitsSold" ||
      key === "albumUnitsSold"
    ) {
      return row[key] == null ? "" : row[key];
    }

    return row[key] ?? "";
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
        columns.map(column =>
          csvEscape(getExportValue(row, column.key))
        )
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
      configureSortMenu();
      renderContent();
    });

    ui.search.addEventListener("input", renderContent);
    ui.timeMode.addEventListener("change", updateDateControls);
    ui.year.addEventListener("change", renderContent);
    ui.sort.addEventListener("change", renderContent);
    ui.direction.addEventListener("change", renderContent);
    ui.dateFrom.addEventListener("change", renderContent);
    ui.dateTo.addEventListener("change", renderContent);
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
      configureSortMenu();
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
