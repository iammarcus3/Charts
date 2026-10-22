(() => {
  "use strict";

  /*
   * STATS PARADISE — YOURHOT100
   * Standalone chart-history application.
   *
   * Expected source files:
   *   vault/tracks.json
   *   vault/albums.json
   *   vault/artists.json
   *   vault/listening_history.jsonl
   *
   * The sales figures are derived model values. Activity counts and rank
   * scores are used privately to reconstruct the chart; they are never
   * rendered in the interface or included in CSV exports.
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

  const $ = (selector) => document.querySelector(selector);

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
    export: $("#export-csv")
  };

  const state = {
    currentView: "overview",
    tracks: new Map(),
    albums: new Map(),
    artists: new Map(),
    events: [],
    snapshots: [],
    songRecords: [],
    albumRecords: [],
    artistRecords: [],
    weeklyRecords: [],
    numberOneRecords: [],
    debutRecords: [],
    exitRecords: [],
    allRecords: [],
    albumDebuts: new Map(),
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
      description: "Every distinct song that has appeared on your reconstructed Hot 100."
    },
    albums: {
      title: "Album Archive",
      description: "Eligible releases, simultaneous song qualifications and album-chart records."
    },
    artists: {
      title: "Artist Archive",
      description: "Artist achievements, credited song records and lead-artist album records."
    },
    weeks: {
      title: "Weekly History",
      description: "Observed Friday–Thursday chart weeks. Missing source weeks are not manufactured."
    },
    numberones: {
      title: "No. 1 Archive",
      description: "Every available week at the top of the song chart and album chart."
    },
    debuts: {
      title: "Debuts & Returns",
      description: "First chart appearances, confirmed re-entries and confirmed exits."
    },
    records: {
      title: "The Record Book",
      description: "The strongest runs, longest reigns and biggest career achievements."
    }
  };

  const SORT_OPTIONS = {
    overview: [
      ["date", "Date"],
      ["title", "Title"]
    ],
    songs: [
      ["unitsSold", "Total units sold"],
      ["latestRank", "Latest chart position"],
      ["peak", "Peak position"],
      ["weeksOnChart", "Weeks on chart"],
      ["weeksAtNo1", "Weeks at No. 1"],
      ["weeksTop10", "Top 10 weeks"],
      ["debutTs", "Debut date"],
      ["title", "Song title"],
      ["artist", "Artist"]
    ],
    albums: [
      ["unitsSold", "Total units sold"],
      ["latestRank", "Latest album-chart position"],
      ["peak", "Peak position"],
      ["weeksOnChart", "Weeks on chart"],
      ["weeksAtNo1", "Weeks at No. 1"],
      ["weeksTop10", "Top 10 weeks"],
      ["trackCount", "Distinct tracks"],
      ["debutTs", "Official debut date"],
      ["title", "Album title"],
      ["artist", "Lead artist"]
    ],
    artists: [
      ["recentUnits", "Latest six-month units sold"],
      ["unitsSold", "Career units sold"],
      ["songNo1Count", "Distinct No. 1 songs"],
      ["songCount", "Distinct songs charted"],
      ["albumCount", "Lead albums charted"],
      ["no1Weeks", "Combined No. 1 weeks"],
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
      ["songUnits", "No. 1 song units sold"],
      ["albumUnits", "No. 1 album units sold"],
      ["songTitle", "Song title"],
      ["albumTitle", "Album title"]
    ],
    debuts: [
      ["dateTs", "Date"],
      ["type", "Chart type"],
      ["status", "Event"],
      ["rank", "Position"],
      ["unitsSold", "Units sold"],
      ["title", "Title"],
      ["artist", "Artist"]
    ],
    records: [
      ["valueNumber", "Record value"],
      ["name", "Record"],
      ["title", "Title"]
    ]
  };

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);
  }

  function safeString(value, fallback = "Unknown") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function unique(values) {
    return [...new Set(values.filter(value => value !== null && value !== undefined)
      .map(value => String(value)))];
  }

  function asArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    return [value];
  }

  function idsFrom(value) {
    return unique(asArray(value).map(item => {
      if (item == null) return null;
      if (typeof item === "object") {
        return item.id ?? item.artist_id ?? item.track_id ?? item.album_id ?? null;
      }
      return item;
    }));
  }

  function parseMap(data) {
    if (Array.isArray(data)) {
      return new Map(
        data.filter(item => item && item.id != null)
          .map(item => [String(item.id), item])
      );
    }

    if (data && typeof data === "object") {
      return new Map(Object.entries(data).map(([id, item]) => [
        String(id),
        item && typeof item === "object" ? { id: String(item.id ?? id), ...item } : { id, value: item }
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

    // Friday is day zero of each chart week.
    const daysSinceFriday = (date.getUTCDay() + 2) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceFriday);

    return date.getTime();
  }

  function shiftMonthsUTC(timestamp, months) {
    const date = new Date(timestamp);
    const targetDay = date.getUTCDate();

    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);

    const endOfMonth = new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      0
    )).getUTCDate();

    date.setUTCDate(Math.min(targetDay, endOfMonth));
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

  function dateKey(timestamp) {
    if (!Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  function formatNumber(value) {
    if (!Number.isFinite(Number(value))) return "—";
    return Math.round(Number(value)).toLocaleString("en-US");
  }

  function formatUnits(value) {
    return formatNumber(value);
  }

  function formatPosition(value) {
    return Number.isFinite(Number(value)) && Number(value) <= CONFIG.HOT100_SIZE
      ? `#${Number(value)}`
      : "—";
  }

  function dateForOffset(timestamp) {
    return formatDate(timestamp);
  }

  function monthLabel(timestamp) {
    if (!Number.isFinite(timestamp)) return "—";
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC"
    });
  }

  function getName(item) {
    if (!item || typeof item !== "object") return "Unknown";
    return safeString(item.name ?? item.title ?? item.artist_name ?? item.track_title);
  }

  function getTrackTitle(track) {
    return safeString(track?.title ?? track?.name ?? track?.track_title, "Unknown Song");
  }

  function getAlbumTitle(album) {
    return safeString(album?.title ?? album?.name ?? album?.album_title, "Unknown Album");
  }

  function getArtistName(id) {
    if (id == null) return "Unknown Artist";
    const artist = state.artists.get(String(id));
    if (artist) return getName(artist);
    return "Unknown Artist";
  }

  function getTrackArtistIds(track) {
    if (!track) return [];

    const candidateLists = [
      track.artist_ids,
      track.credited_artist_ids,
      track.artists,
      track.artist_credits
    ];

    for (const candidate of candidateLists) {
      const ids = idsFrom(candidate);
      if (ids.length) return ids;
    }

    const fallback = track.primary_artist_id ?? track.artist_id;
    return fallback != null ? [String(fallback)] : [];
  }

  function getTrackArtistNames(track) {
    if (!track) return ["Unknown Artist"];

    const ids = getTrackArtistIds(track);
    if (ids.length) return ids.map(getArtistName);

    const supplied = track.artist_name ?? track.artist;
    if (typeof supplied === "string" && supplied.trim()) return [supplied.trim()];

    return ["Unknown Artist"];
  }

  function getLeadAlbumArtistId(album) {
    if (!album) return null;

    const candidate = album.primary_artist_id ?? album.artist_id;
    if (candidate != null) return String(candidate);

    const ids = idsFrom(album.artist_ids ?? album.artists);
    return ids[0] ?? null;
  }

  function getTrackAlbumIds(track) {
    if (!track) return [];

    return unique([
      ...idsFrom(track.album_ids),
      ...idsFrom(track.albums),
      track.album_id,
      track.primary_album_id
    ]);
  }

  function getTrackIdsFromAlbum(album) {
    if (!album) return [];

    return unique([
      ...idsFrom(album.track_ids),
      ...idsFrom(album.tracks)
    ]);
  }

  function pointsForInternalRank(rank) {
    if (rank <= 1) return 100;
    if (rank === 2) return 98;

    return Math.max(1, Math.round(98 - ((rank - 2) * 97 / 98)));
  }

  function makeChartEntries(countMap, type, allowedIds = null) {
    const candidates = [];

    countMap.forEach((activityCount, id) => {
      const key = String(id);

      if (allowedIds && !allowedIds.has(key)) return;
      if (!(activityCount > 0)) return;

      if (type === "songs") {
        const track = state.tracks.get(key);
        if (!track) return;

        candidates.push({
          id: key,
          title: getTrackTitle(track),
          artist: getTrackArtistNames(track).join(", "),
          artistIds: getTrackArtistIds(track),
          activityCount,
          trackCount: 1
        });
      } else {
        const album = state.albums.get(key);
        if (!album) return;

        const leadId = getLeadAlbumArtistId(album);
        candidates.push({
          id: key,
          title: getAlbumTitle(album),
          artist: getArtistName(leadId),
          artistIds: leadId ? [leadId] : [],
          leadArtistId: leadId,
          activityCount,
          trackCount: state.albumTrackMap.get(key)?.size ?? 0
        });
      }
    });

    // Preserve the historical methodology: establish the internal activity
    // order before calculating derived
