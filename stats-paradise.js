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
    // order before calculating derived units, then rank by the unit result.
    candidates.sort((a, b) =>
      b.activityCount - a.activityCount ||
      a.title.localeCompare(b.title)
    );

    const topCandidates = candidates.slice(0, CONFIG.HOT100_SIZE);

    topCandidates.forEach((entry, index) => {
      const internalRankScore = pointsForInternalRank(index + 1);
      const factor = type === "songs"
        ? CONFIG.SONG_UNIT_FACTOR
        : CONFIG.ALBUM_UNIT_FACTOR;

      entry.unitsSold =
        (entry.activityCount * factor) +
        (internalRankScore * CONFIG.RANK_UNIT_FACTOR);
    });

    topCandidates.sort((a, b) =>
      b.unitsSold - a.unitsSold ||
      b.activityCount - a.activityCount ||
      a.title.localeCompare(b.title)
    );

    return topCandidates.map((entry, index) => ({
      ...entry,
      rank: index + 1,
      type
    }));
  }

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
          "Check that Stats Paradise is hosted from your project root and that the vault/ files exist."
        );
      }
    }

    state.tracks = parseMap(await responses[0].json());
    state.albums = parseMap(await responses[1].json());
    state.artists = parseMap(await responses[2].json());

    const rawHistory = await responses[3].text();
    const lines = rawHistory.split(/\r?\n/).filter(Boolean);
    const events = [];

    for (let index = 0; index < lines.length; index++) {
      try {
        const event = JSON.parse(lines[index]);
        const seconds = timestampSeconds(
          event.timestamp ??
          event.uts ??
          event.played_at ??
          event.date ??
          event.datetime
        );

        const trackId = event.track_id ?? event.trackId ?? event.track;

        if (seconds == null || trackId == null) continue;

        events.push({
          trackId: String(
            typeof trackId === "object"
              ? trackId.id ?? trackId.track_id ?? ""
              : trackId
          ),
          timestamp: seconds,
          weekStart: getWeekStartMs(seconds)
        });
      } catch (error) {
        console.warn(`Stats Paradise skipped malformed history row ${index + 1}.`, error);
      }
    }

    state.events = events.filter(event => state.tracks.has(event.trackId));

    if (!state.events.length) {
      throw new Error("The listening-history file loaded, but no usable events matched tracks in the catalogue.");
    }
  }

  function buildAlbumTrackMap() {
    const albumTrackMap = new Map();
    const trackToAlbums = new Map();

    state.albums.forEach((album, albumId) => {
      const ids = new Set(getTrackIdsFromAlbum(album));
      albumTrackMap.set(String(albumId), ids);
    });

    state.tracks.forEach((track, trackId) => {
      getTrackAlbumIds(track).forEach(albumId => {
        if (!albumTrackMap.has(albumId)) albumTrackMap.set(albumId, new Set());
        albumTrackMap.get(albumId).add(String(trackId));
      });
    });

    albumTrackMap.forEach((trackIds, albumId) => {
      trackIds.forEach(trackId => {
        if (!trackToAlbums.has(trackId)) trackToAlbums.set(trackId, new Set());
        trackToAlbums.get(trackId).add(albumId);
      });
    });

    state.albumTrackMap = albumTrackMap;
    state.trackToAlbums = trackToAlbums;

    state.eligibleAlbumIds = new Set();

    albumTrackMap.forEach((trackIds, albumId) => {
      // Static eligibility is independent from official chart debut.
      if (trackIds.size >= CONFIG.MIN_ALBUM_TRACKS) {
        state.eligibleAlbumIds.add(String(albumId));
      }
    });
  }

  function buildChartArchive() {
    const groupedEvents = new Map();

    state.events.forEach(event => {
      if (!groupedEvents.has(event.weekStart)) groupedEvents.set(event.weekStart, []);
      groupedEvents.get(event.weekStart).push(event);
    });

    // Only weeks with source events are available chart snapshots.
    const weekStarts = [...groupedEvents.keys()].sort((a, b) => a - b);

    if (!weekStarts.length) throw new Error("No chart weeks could be constructed from the archive.");

    state.earliestWeekStart = weekStarts[0];
    state.latestWeekStart = weekStarts[weekStarts.length - 1];

    state.currentSixMonthStart = shiftMonthsUTC(state.latestWeekStart, -6);
    state.previousSixMonthEnd = state.currentSixMonthStart - 1;
    state.previousSixMonthStart = shiftMonthsUTC(state.latestWeekStart, -12);

    state.snapshots = [];
    state.albumDebuts = new Map();

    weekStarts.forEach(weekStart => {
      const events = groupedEvents.get(weekStart) || [];
      const trackCounts = new Map();
      const albumCounts = new Map();

      events.forEach(event => {
        const id = String(event.trackId);
        trackCounts.set(id, (trackCounts.get(id) || 0) + 1);

        const albumIds = state.trackToAlbums.get(id) || new Set();

        albumIds.forEach(albumId => {
          if (!state.eligibleAlbumIds.has(String(albumId))) return;
          albumCounts.set(albumId, (albumCounts.get(albumId) || 0) + 1);
        });
      });

      const songs = makeChartEntries(trackCounts, "songs");
      const chartingSongIds = new Set(songs.map(entry => String(entry.id)));

      const qualifyingAlbumIds = new Set();

      state.eligibleAlbumIds.forEach(albumId => {
        const trackIds = state.albumTrackMap.get(albumId) || new Set();

        let simultaneousTracks = 0;

        trackIds.forEach(trackId => {
          if (chartingSongIds.has(String(trackId))) simultaneousTracks++;
        });

        // Official album debut: first week with at least three distinct
        // album tracks simultaneously charting on the Hot 100.
        if (simultaneousTracks >= CONFIG.MIN_ALBUM_TRACKS) {
          qualifyingAlbumIds.add(String(albumId));

          if (!state.albumDebuts.has(String(albumId))) {
            state.albumDebuts.set(String(albumId), {
              weekStart,
              simultaneousTracks,
              unitsSold: null
            });
          }
        }
      });

      // Before debut, a release stays out of the album chart even if it is
      // already eligible in the catalogue. Following debut, it must still
      // satisfy the simultaneous three-track chart condition each week.
      const albums = makeChartEntries(
        albumCounts,
        "albums",
        qualifyingAlbumIds
      );

      albums.forEach(entry => {
        const debut = state.albumDebuts.get(String(entry.id));

        if (debut && debut.weekStart === weekStart && debut.unitsSold == null) {
          debut.unitsSold = entry.unitsSold;
        }
      });

      state.snapshots.push({
        weekStart,
        weekEnd: weekStart + CONFIG.WEEK_MS - 1,
        songs,
        albums,
        sourceEventCount: events.length
      });
    });

    // When a release qualified for debut but was not in the displayed album
    // top 100, preserve the calculated debut date. Its debut units remain
    // unavailable rather than being invented from a different week.
  }

  function emptyEntityRecord(entry, firstWeek) {
    return {
      id: String(entry.id),
      title: entry.title,
      artist: entry.artist,
      artistIds: entry.artistIds || [],
      leadArtistId: entry.leadArtistId || null,
      debutOffset: firstWeek,
      firstChartDate: firstWeek,
      lastOffset: firstWeek,
      latestRank: entry.rank,
      peak: entry.rank,
      peakOffset: firstWeek,
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
      unitsSold: 0,
      history: [],
      appearances: []
    };
  }

  function aggregateEntityRecords() {
    const songs = new Map();
    const albums = new Map();
    const weeklyRecords = [];
    const numberOneRecords = [];
    const debutRecords = [];
    const exitRecords = [];

    let previousSnapshot = null;

    for (const snapshot of state.snapshots) {
      const weekStart = snapshot.weekStart;
      const songIdsNow = new Set(snapshot.songs.map(entry => String(entry.id)));
      const albumIdsNow = new Set(snapshot.albums.map(entry => String(entry.id)));

      const songEntryStatus = new Map();
      const albumEntryStatus = new Map();

      function processEntity(entries, records, type, statusMap) {
        entries.forEach(entry => {
          const id = String(entry.id);
          let record = records.get(id);

          if (!record) {
            record = emptyEntityRecord(entry, weekStart);
            records.set(id, record);
            statusMap.set(id, "Debut");
          } else {
            const cameBackAfterConfirmedGap =
              previousSnapshot &&
              previousSnapshot.weekStart + CONFIG.WEEK_MS === weekStart &&
              !previousSnapshot[type].some(oldEntry => String(oldEntry.id) === id);

            if (cameBackAfterConfirmedGap) {
              statusMap.set(id, "Re-entry");
            }
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

          record.weeksOnChart += 1;
          record.lastOffset = weekStart;
          record.latestRank = entry.rank;
          record.unitsSold += Number(entry.unitsSold || 0);
          record.history.push({
            weekStart,
            rank: entry.rank,
            unitsSold: Number(entry.unitsSold || 0)
          });
          record.appearances.push(weekStart);

          record.peak = Math.min(record.peak, entry.rank);

          if (entry.rank < record.peak) {
            record.peak = entry.rank;
            record.peakOffset = weekStart;
          } else if (entry.rank === record.peak && record.peakOffset == null) {
            record.peakOffset = weekStart;
          }

          if (entry.rank === 1) {
            record.weeksAtNo1 += 1;
            record.currentNo1Streak = consecutive
              ? record.currentNo1Streak + 1
              : 1;
            record.maxNo1Streak = Math.max(
              record.maxNo1Streak,
              record.currentNo1Streak
            );
          } else {
            record.currentNo1Streak = 0;
          }

          if (entry.rank <= 10) record.weeksTop10++;
          if (entry.rank <= 20) record.weeksTop20++;
          if (entry.rank <= 40) record.weeksTop40++;
          if (entry.rank <= 50) record.weeksTop50++;
          if (entry.rank <= 100) record.weeksTop100++;
        });
      }

      processEntity(snapshot.songs, songs, "songs", songEntryStatus);
      processEntity(snapshot.albums, albums, "albums", albumEntryStatus);

      snapshot.songs.forEach(entry => {
        const id = String(entry.id);
        const status = songEntryStatus.get(id);

        if (status) {
          debutRecords.push({
            dateTs: weekStart,
            date: formatDate(weekStart),
            type: "Song",
            title: entry.title,
            artist: entry.artist,
            rank: entry.rank,
            status,
            unitsSold: entry.unitsSold,
            id
          });
        }
      });

      snapshot.albums.forEach(entry => {
        const id = String(entry.id);
        const status = albumEntryStatus.get(id);

        if (status) {
          debutRecords.push({
            dateTs: weekStart,
            date: formatDate(weekStart),
            type: "Album",
            title: entry.title,
            artist: entry.artist,
            rank: entry.rank,
            status,
            unitsSold: entry.unitsSold,
            id
          });
        }
      });

      if (previousSnapshot &&
          previousSnapshot.weekStart + CONFIG.WEEK_MS === weekStart) {
        const songIdsBefore = new Set(previousSnapshot.songs.map(entry => String(entry.id)));
        const albumIdsBefore = new Set(previousSnapshot.albums.map(entry => String(entry.id)));

        previousSnapshot.songs.forEach(entry => {
          const id = String(entry.id);
          if (!songIdsNow.has(id)) {
            exitRecords.push({
              dateTs: weekStart,
              date: formatDate(weekStart),
              type: "Song",
              title: entry.title,
              artist: entry.artist,
              rank: null,
              status: "Exit",
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
              title: entry.title,
              artist: entry.artist,
              rank: null,
              status: "Exit",
              unitsSold: entry.unitsSold,
              id
            });
          }
        });
      }

      const no1Song = snapshot.songs.find(entry => entry.rank === 1) || null;
      const no1Album = snapshot.albums.find(entry => entry.rank === 1) || null;

      weeklyRecords.push({
        dateTs: weekStart,
        date: formatDate(weekStart),
        year: new Date(weekStart).getUTCFullYear(),
        songCount: snapshot.songs.length,
        albumCount: snapshot.albums.length,
        newEntries: debutRecords.filter(entry =>
          entry.dateTs === weekStart && entry.status === "Debut"
        ).length,
        reentries: debutRecords.filter(entry =>
          entry.dateTs === weekStart && entry.status === "Re-entry"
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
          songUnits: no1Song?.unitsSold ?? null,
          albumTitle: no1Album?.title ?? "No qualifying album",
          albumArtist: no1Album?.artist ?? "—",
          albumUnits: no1Album?.unitsSold ?? null
        });
      }

      previousSnapshot = snapshot;
    }

    state.songRecords = [...songs.values()].map(record => {
      const currentEntry = lastHistoryItem(record.history);
      const track = state.tracks.get(record.id);

      return {
        ...record,
        type: "Song",
        artist: getTrackArtistNames(track).join(", ") || record.artist,
        debutDate: formatDate(record.firstChartDate),
        debutTs: record.firstChartDate,
        peakDate: formatDate(record.peakOffset),
        lastDate: formatDate(record.lastOffset),
        latestRank: currentEntry?.rank ?? null,
        currentChartStreak: calculateCurrentStreak(record.history),
        recentHistory: record.history
      };
    });

    state.albumRecords = [...albums.values()].map(record => {
      const album = state.albums.get(record.id);
      const activation = state.albumDebuts.get(record.id);
      const debutTs = activation?.weekStart ?? record.firstChartDate;

      return {
        ...record,
        type: "Album",
        artist: getArtistName(getLeadAlbumArtistId(album)),
        debutDate: formatDate(debutTs),
        debutTs,
        debutUnits: activation?.unitsSold ?? null,
        qualifyingTracksAtDebut: activation?.simultaneousTracks ?? null,
        trackCount: state.albumTrackMap.get(record.id)?.size ?? 0,
        peakDate: formatDate(record.peakOffset),
        lastDate: formatDate(record.lastOffset),
        currentChartStreak: calculateCurrentStreak(record.history),
        recentHistory: record.history
      };
    });

    state.weeklyRecords = weeklyRecords;
    state.numberOneRecords = numberOneRecords;
    state.debutRecords = debutRecords;
    state.exitRecords = exitRecords;

    calculateMovement();
    calculateArtistRecords();
    calculateRecordBook();
  }

  function lastHistoryItem(history) {
    return history.length ? history[history.length - 1] : null;
  }

  function calculateCurrentStreak(history) {
    if (!history.length) return 0;

    let streak = 1;

    for (let index = history.length - 1; index > 0; index--) {
      if (history[index].weekStart - history[index - 1].weekStart !== CONFIG.WEEK_MS) {
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

  function calculateMovement() {
    const latest = state.snapshots[state.snapshots.length - 1];
    if (!latest) return;

    const comparison = findSnapshotOnOrBefore(state.currentSixMonthStart);
    const previousSongRanks = new Map(
      (comparison?.songs || []).map(entry => [String(entry.id), entry.rank])
    );
    const previousAlbumRanks = new Map(
      (comparison?.albums || []).map(entry => [String(entry.id), entry.rank])
    );

    const everSongIds = new Set(state.songRecords.map(record => record.id));
    const everAlbumIds = new Set(state.albumRecords.map(record => record.id));

    state.songRecords.forEach(record => {
      const oldRank = previousSongRanks.get(record.id);

      if (record.latestRank == null) {
        record.movement = "Not in latest chart";
        record.movementValue = null;
      } else if (oldRank == null) {
        const appearedBefore =
          record.history.some(item => item.weekStart < state.currentSixMonthStart);

        record.movement = appearedBefore ? "Return / no comparison" : "New";
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
      const oldRank = previousAlbumRanks.get(record.id);

      if (record.latestRank == null) {
        record.movement = "Not in latest chart";
        record.movementValue = null;
      } else if (oldRank == null) {
        const appearedBefore =
          record.history.some(item => item.weekStart < state.currentSixMonthStart);

        record.movement = appearedBefore ? "Return / no comparison" : "New";
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

    // Keep explicit references to avoid accidental data-derived global state.
    void everSongIds;
    void everAlbumIds;
  }

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
          albumNo1Weeks: 0
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

      snapshot.songs.forEach(entry => {
        (entry.artistIds || []).forEach(id => {
          const artist = ensureArtist(id);
          if (!artist) return;

          artist.songUnitsSold += Number(entry.unitsSold || 0);
          artist.songAppearances++;
          artist.songIds.add(String(entry.id));

          if (entry.rank === 1) {
            artist.songNo1Ids.add(String(entry.id));
            artist.songNo1Weeks++;
          }

          if (isRecent) artist.recentUnits += Number(entry.unitsSold || 0);
          if (isPrevious) artist.previousUnits += Number(entry.unitsSold || 0);
        });
      });

      snapshot.albums.forEach(entry => {
        const leadId = entry.leadArtistId ||
          getLeadAlbumArtistId(state.albums.get(String(entry.id)));

        const artist = ensureArtist(leadId);
        if (!artist) return;

        artist.albumUnitsSold += Number(entry.unitsSold || 0);
        artist.albumAppearances++;
        artist.albumIds.add(String(entry.id));

        if (entry.rank === 1) artist.albumNo1Weeks++;

        if (isRecent) artist.recentUnits += Number(entry.unitsSold || 0);
        if (isPrevious) artist.previousUnits += Number(entry.unitsSold || 0);
      });
    }

    const records = [...artistMap.values()].map(artist => {
      artist.unitsSold = artist.songUnitsSold + artist.albumUnitsSold;
      artist.songCount = artist.songIds.size;
      artist.songNo1Count = artist.songNo1Ids.size;
      artist.albumCount = artist.albumIds.size;
      artist.no1Weeks = artist.songNo1Weeks + artist.albumNo1Weeks;

      if (artist.previousUnits === 0 && artist.recentUnits > 0) {
        artist.movement = "New / no prior sales";
        artist.movementValue = null;
      } else if (artist.previousUnits === 0 && artist.recentUnits === 0) {
        artist.movement = "No six-month activity";
        artist.movementValue = null;
      } else {
        artist.movementValue = artist.recentUnits - artist.previousUnits;

        artist.movement = artist.movementValue > 0
          ? `Up ${formatUnits(artist.movementValue)}`
          : artist.movementValue < 0
            ? `Down ${formatUnits(Math.abs(artist.movementValue))}`
            : "Unchanged";
      }

      artist.lastDateTs = state.latestWeekStart;

      return artist;
    });

    const currentBoard = [...records]
      .sort((a, b) => b.recentUnits - a.recentUnits || a.name.localeCompare(b.name));

    const previousBoard = [...records]
      .sort((a, b) => b.previousUnits - a.previousUnits || a.name.localeCompare(b.name));

    const previousPositions = new Map(
      previousBoard.map((artist, index) => [artist.id, index + 1])
    );

    currentBoard.forEach((artist, index) => {
      artist.currentSixMonthRank = index + 1;
      artist.previousSixMonthRank = previousPositions.get(artist.id) ?? null;

      if (artist.previousSixMonthRank == null || artist.previousUnits === 0) {
        artist.rankMovement = "New";
      } else {
        const change = artist.previousSixMonthRank - artist.currentSixMonthRank;

        artist.rankMovement = change > 0
          ? `Up ${change}`
          : change < 0
            ? `Down ${Math.abs(change)}`
            : "Unchanged";
      }
    });

    state.artistRecords = records;
  }

  function calculateRecordBook() {
    const records = [];
    const add = (name, value, title, detail, numeric = null) => {
      if (value == null || value === "" || value === "—") return;

      records.push({
        name,
        value: String(value),
        valueNumber: Number.isFinite(Number(numeric)) ? Number(numeric) : 0,
        title: title || "—",
        detail: detail || "",
        date: "",
        dateTs: null
      });
    };

    const songs = state.songRecords;
    const albums = state.albumRecords;
    const artists = state.artistRecords;

    const best = (collection, selector) =>
      [...collection].filter(item => Number.isFinite(selector(item)))
        .sort((a, b) => selector(b) - selector(a))[0] || null;

    const longestSongNo1 = best(songs, item => item.maxNo1Streak);
    const mostSongNo1Weeks = best(songs, item => item.weeksAtNo1);
    const longestSongRun = best(songs, item => item.maxChartStreak);
    const mostSongTop10Weeks = best(songs, item => item.weeksTop10);
    const mostSongUnits = best(songs, item => item.unitsSold);

    const longestAlbumNo1 = best(albums, item => item.maxNo1Streak);
    const mostAlbumNo1Weeks = best(albums, item => item.weeksAtNo1);
    const longestAlbumRun = best(albums, item => item.maxChartStreak);
    const mostAlbumUnits = best(albums, item => item.unitsSold);

    const artistMostSongNo1 = best(artists, item => item.songNo1Count);
    const artistMostSongs = best(artists, item => item.songCount);
    const artistMostAlbumNo1Weeks = best(artists, item => item.albumNo1Weeks);
    const artistMostUnits = best(artists, item => item.unitsSold);

    if (longestSongNo1) {
      add("Longest song No. 1 streak",
        `${longestSongNo1.maxNo1Streak} week(s)`,
        longestSongNo1.title,
        longestSongNo1.artist,
        longestSongNo1.maxNo1Streak);
    }

    if (mostSongNo1Weeks) {
      add("Most song weeks at No. 1",
        `${mostSongNo1Weeks.weeksAtNo1} week(s)`,
        mostSongNo1Weeks.title,
        mostSongNo1Weeks.artist,
        mostSongNo1Weeks.weeksAtNo1);
    }

    if (longestSongRun) {
      add("Longest song chart run",
        `${longestSongRun.maxChartStreak} consecutive week(s)`,
        longestSongRun.title,
        longestSongRun.artist,
        longestSongRun.maxChartStreak);
    }

    if (mostSongTop10Weeks) {
      add("Most song Top 10 weeks",
        `${mostSongTop10Weeks.weeksTop10} week(s)`,
        mostSongTop10Weeks.title,
        mostSongTop10Weeks.artist,
        mostSongTop10Weeks.weeksTop10);
    }

    if (mostSongUnits) {
      add("Highest career song units sold",
        formatUnits(mostSongUnits.unitsSold),
        mostSongUnits.title,
        mostSongUnits.artist,
        mostSongUnits.unitsSold);
    }

    if (longestAlbumNo1) {
      add("Longest album No. 1 streak",
        `${longestAlbumNo1.maxNo1Streak} week(s)`,
        longestAlbumNo1.title,
        longestAlbumNo1.artist,
        longestAlbumNo1.maxNo1Streak);
    }

    if (mostAlbumNo1Weeks) {
      add("Most album weeks at No. 1",
        `${mostAlbumNo1Weeks.weeksAtNo1} week(s)`,
        mostAlbumNo1Weeks.title,
        mostAlbumNo1Weeks.artist,
        mostAlbumNo1Weeks.weeksAtNo1);
    }

    if (longestAlbumRun) {
      add("Longest album chart run",
        `${longestAlbumRun.maxChartStreak} consecutive week(s)`,
        longestAlbumRun.title,
        longestAlbumRun.artist,
        longestAlbumRun.maxChartStreak);
    }

    if (mostAlbumUnits) {
      add("Highest career album units sold",
        formatUnits(mostAlbumUnits.unitsSold),
        mostAlbumUnits.title,
        mostAlbumUnits.artist,
        mostAlbumUnits.unitsSold);
    }

    if (artistMostSongNo1) {
      add("Most distinct No. 1 songs credited",
        `${artistMostSongNo1.songNo1Count} song(s)`,
        artistMostSongNo1.name,
        "Artist",
        artistMostSongNo1.songNo1Count);
    }

    if (artistMostSongs) {
      add("Most distinct songs charted",
        `${artistMostSongs.songCount} song(s)`,
        artistMostSongs.name,
        "Artist",
        artistMostSongs.songCount);
    }

    if (artistMostAlbumNo1Weeks) {
      add("Most album No. 1 weeks",
        `${artistMostAlbumNo1Weeks.albumNo1Weeks} week(s)`,
        artistMostAlbumNo1Weeks.name,
        "Lead-artist album credit",
        artistMostAlbumNo1Weeks.albumNo1Weeks);
    }

    if (artistMostUnits) {
      add("Highest combined career units sold",
        formatUnits(artistMostUnits.unitsSold),
        artistMostUnits.name,
        "Song credits plus lead-artist albums",
        artistMostUnits.unitsSold);
    }

    add("Observed chart weeks",
      formatNumber(state.snapshots.length),
      formatDate(state.earliestWeekStart),
      `Latest source week: ${formatDate(state.latestWeekStart)}`,
      state.snapshots.length);

    add("Distinct songs charted",
      formatNumber(state.songRecords.length),
      "YourHot100 song archive",
      "Distinct canonical track records",
      state.songRecords.length);

    add("Distinct albums charted",
      formatNumber(state.albumRecords.length),
      "YourHot100 album archive",
      "Albums with at least one recorded album-chart appearance",
      state.albumRecords.length);

    add("Artists credited",
      formatNumber(state.artistRecords.length),
      "YourHot100 artist archive",
      "Song credits and lead-album-artist credits",
      state.artistRecords.length);

    state.allRecords = records;
  }

  function currentViewRows() {
    switch (state.currentView) {
      case "songs": return state.songRecords;
      case "albums": return state.albumRecords;
      case "artists": return state.artistRecords;
      case "weeks": return state.weeklyRecords;
      case "numberones": return state.numberOneRecords;
      case "debuts": return [...state.debutRecords, ...state.exitRecords];
      case "records": return state.allRecords;
      default: return [];
    }
  }

  function dateForRow(row) {
    switch (state.currentView) {
      case "songs":
      case "albums":
        return row.debutTs;
      case "artists":
        return row.lastDateTs;
      case "weeks":
      case "numberones":
      case "debuts":
        return row.dateTs;
      default:
        return null;
    }
  }

  function rowMatchesDate(row) {
    const mode = ui.timeMode.value;
    if (mode === "all" || state.currentView === "overview" || state.currentView === "records") {
      return true;
    }

    const timestamp = dateForRow(row);
    if (!Number.isFinite(timestamp)) return mode === "all";

    if (mode === "year") {
      const year = Number(ui.year.value);
      return year > 0 && new Date(timestamp).getUTCFullYear() === year;
    }

    if (mode === "custom") {
      const from = ui.dateFrom.value ? Date.parse(`${ui.dateFrom.value}T00:00:00Z`) : -Infinity;
      const to = ui.dateTo.value ? Date.parse(`${ui.dateTo.value}T23:59:59Z`) : Infinity;
      return timestamp >= from && timestamp <= to;
    }

    if (mode === "recent6") return timestamp >= state.currentSixMonthStart &&
      timestamp <= state.latestWeekStart;

    if (mode === "previous6") return timestamp >= state.previousSixMonthStart &&
      timestamp < state.currentSixMonthStart;

    return true;
  }

  function searchValue(row) {
    return Object.values(row).filter(value =>
      typeof value === "string" || typeof value === "number"
    ).join(" ").toLowerCase();
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
      let av = a[sortField];
      let bv = b[sortField];

      if (av == null) av = typeof bv === "number" ? -Infinity : "";
      if (bv == null) bv = typeof av === "number" ? -Infinity : "";

      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * direction;
      }

      return String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: "base"
      }) * direction;
    });

    return rows.slice(0, CONFIG.TABLE_LIMIT);
  }

  function defaultSortField() {
    const defaults = {
      songs: "unitsSold",
      albums: "unitsSold",
      artists: "recentUnits",
      weeks: "dateTs",
      numberones: "dateTs",
      debuts: "dateTs",
      records: "valueNumber"
    };

    return defaults[state.currentView] || "dateTs";
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

  function refreshYearOptions() {
    const currentValue = ui.year.value;
    const years = [...new Set(state.snapshots.map(snapshot =>
      new Date(snapshot.weekStart).getUTCFullYear()
    ))].sort((a, b) => b - a);

    state.years = years;

    ui.year.innerHTML = [
      '<option value="">Choose a year</option>',
      ...years.map(year => `<option value="${year}">${year}</option>`)
    ].join("");

    if (years.includes(Number(currentValue))) ui.year.value = currentValue;
  }

  function setStatus(label, kind = "good") {
    ui.status.textContent = label;
    ui.status.className = `pill ${kind}`;
  }

  function showError(message) {
    ui.error.innerHTML = `<div class="error-box"><strong>Stats Paradise could not finish loading.</strong><br>${escapeHTML(message)}</div>`;
  }

  function renderSummary() {
    const latestSnapshot = state.snapshots[state.snapshots.length - 1];
    const cards = [
      {
        label: "Observed Chart Weeks",
        value: formatNumber(state.snapshots.length),
        note: `${formatDate(state.earliestWeekStart)} – ${formatDate(state.latestWeekStart)}`
      },
      {
        label: "Songs Charted",
        value: formatNumber(state.songRecords.length),
        note: "Distinct song records"
      },
      {
        label: "Albums Charted",
        value: formatNumber(state.albumRecords.length),
        note: "Distinct album records"
      },
      {
        label: "Artists Credited",
        value: formatNumber(state.artistRecords.length),
        note: "Song credits and lead-album-artist credits"
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
      `Loaded · latest week ${formatDate(latestSnapshot.weekStart)}`,
      "good"
    );
  }

  function renderOverview() {
    const latest = state.snapshots[state.snapshots.length - 1];
    const latestWeek = state.weeklyRecords[state.weeklyRecords.length - 1];

    const currentSongNo1 = latest?.songs.find(entry => entry.rank === 1);
    const currentAlbumNo1 = latest?.albums.find(entry => entry.rank === 1);

    const cards = [
      {
        label: "Latest Song No. 1",
        value: currentSongNo1?.title ?? "No qualifying entry",
        detail: currentSongNo1
          ? `${currentSongNo1.artist} · ${formatUnits(currentSongNo1.unitsSold)} units sold`
          : "No song entry is available for the latest source week."
      },
      {
        label: "Latest Album No. 1",
        value: currentAlbumNo1?.title ?? "No qualifying entry",
        detail: currentAlbumNo1
          ? `${currentAlbumNo1.artist} · ${formatUnits(currentAlbumNo1.unitsSold)} units sold`
          : "No album entry is available for the latest source week."
      },
      {
        label: "New Song Entries",
        value: formatNumber(latestWeek?.newEntries ?? 0),
        detail: "Confirmed first appearances in the latest observed week."
      },
      {
        label: "Album Debut Rule",
        value: "3 tracks",
        detail: "First simultaneous Hot 100 qualification activates an album debut."
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
      }
    ];

    const recordCards = state.allRecords.slice(0, 12);

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

      <div class="section-title">
        <div>
          <h2>All-time record book</h2>
          <p>Achievements calculated from the reconstructed archive.</p>
        </div>
      </div>

      <div class="records-grid">
        ${recordCards.map(record => `
          <article class="record-card">
            <div class="record-label">${escapeHTML(record.name)}</div>
            <div class="record-value">${escapeHTML(record.value)}</div>
            <div class="record-detail">
              <span class="cell-main">${escapeHTML(record.title)}</span>
              ${escapeHTML(record.detail)}
            </div>
          </article>
        `).join("")}
      </div>

      <div class="notice">
        Song collaborator credits can overlap: the same song's units sold are
        credited in full to every credited artist. Album units sold belong to
        the lead album artist only. These artist totals are not additive across
        all artists.
      </div>
    `;

    state.visibleRows = cards.map(card => ({
      label: card.label,
      value: card.value,
      detail: card.detail
    }));
    state.visibleColumns = [
      { key: "label", label: "Highlight" },
      { key: "value", label: "Value" },
      { key: "detail", label: "Detail" }
    ];
  }

  function trendClass(value) {
    const text = String(value ?? "").toLowerCase();

    if (text.startsWith("up")) return "trend-up";
    if (text.startsWith("down")) return "trend-down";
    if (text === "new" || text.startsWith("new /")) return "trend-new";

    return "trend-neutral";
  }

  function cellValue(row, key) {
    const positionFields = new Set(["rank", "latestRank", "peak"]);
    const unitFields = new Set(["unitsSold", "debutUnits", "songUnits", "albumUnits"]);
    const dateFields = new Set(["dateTs", "debutTs", "lastDateTs", "peakOffset"]);
    const setFields = new Set(["songIds", "songNo1Ids", "albumIds"]);

    if (positionFields.has(key)) return formatPosition(row[key]);
    if (unitFields.has(key)) return row[key] == null ? "—" : formatUnits(row[key]);
    if (dateFields.has(key)) return formatDate(row[key]);
    if (setFields.has(key)) return row[key]?.size ?? 0;

    if (key === "name") return row.name ?? "—";
    if (key === "title") return row.title ?? "—";

    return row[key] == null || row[key] === "" ? "—" : row[key];
  }

  function getColumns(view) {
    const columns = {
      songs: [
        ["latestRank", "Latest position"],
        ["title", "Song"],
        ["artist", "Artist"],
        ["peak", "Peak"],
        ["debutDate", "Debut date"],
        ["weeksOnChart", "Weeks charted"],
        ["weeksAtNo1", "No. 1 weeks"],
        ["weeksTop10", "Top 10 weeks"],
        ["unitsSold", "Career units sold"],
        ["movement", "Six-month movement"]
      ],
      albums: [
        ["latestRank", "Latest position"],
        ["title", "Album"],
        ["artist", "Lead artist"],
        ["trackCount", "Distinct tracks"],
        ["peak", "Peak"],
        ["debutDate", "Official debut"],
        ["weeksOnChart", "Weeks charted"],
        ["weeksAtNo1", "No. 1 weeks"],
        ["unitsSold", "Career units sold"],
        ["debutUnits", "Debut-week units sold"],
        ["movement", "Six-month movement"]
      ],
      artists: [
        ["currentSixMonthRank", "Recent rank"],
        ["name", "Artist"],
        ["songCount", "Songs charted"],
        ["songNo1Count", "Distinct No. 1 songs"],
        ["albumCount", "Lead albums charted"],
        ["songNo1Weeks", "Song No. 1 weeks"],
        ["albumNo1Weeks", "Album No. 1 weeks"],
        ["unitsSold", "Career units sold"],
        ["recentUnits", "Recent six-month units sold"],
        ["movement", "Sales movement"],
        ["rankMovement", "Leaderboard movement"]
      ],
      weeks: [
        ["date", "Chart week"],
        ["songCount", "Songs charted"],
        ["albumCount", "Albums charted"],
        ["newEntries", "New entries"],
        ["reentries", "Re-entries"],
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
        ["date", "Week"],
        ["type", "Chart"],
        ["status", "Event"],
        ["rank", "Position"],
        ["title", "Title"],
        ["artist", "Artist"],
        ["unitsSold", "Units sold"]
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

  function cellHTML(row, column) {
    const key = column.key;

    if (key === "title" || key === "name") {
      const value = row[key] ?? row.name ?? row.title ?? "—";
      const sub = key === "title" ? row.artist : row.detail;

      return `<span class="cell-main">${escapeHTML(value)}</span>` +
        (sub ? `<span class="cell-sub">${escapeHTML(sub)}</span>` : "");
    }

    if (key === "topSong") {
      const entry = row.topSong;
      return entry
        ? `<span class="cell-main">${escapeHTML(entry.title)}</span>
           <span class="cell-sub">${escapeHTML(entry.artist)}</span>`
        : "—";
    }

    if (key === "topAlbum") {
      const entry = row.topAlbum;
      return entry
        ? `<span class="cell-main">${escapeHTML(entry.title)}</span>
           <span class="cell-sub">${escapeHTML(entry.artist)}</span>`
        : "—";
    }

    if (key === "movement" || key === "rankMovement") {
      const value = row[key] ?? "—";
      return `<span class="${trendClass(value)}">${escapeHTML(value)}</span>`;
    }

    if (key === "latestRank" || key === "rank" || key === "peak") {
      return `<span class="rank">${escapeHTML(formatPosition(row[key]))}</span>`;
    }

    if (key === "unitsSold" || key === "debutUnits" ||
        key === "songUnits" || key === "albumUnits" ||
        key === "recentUnits") {
      return escapeHTML(row[key] == null ? "—" : formatUnits(row[key]));
    }

    if (key === "debutDate" || key === "peakDate" || key === "lastDate") {
      return escapeHTML(row[key] ?? "—");
    }

    if (key === "date") return escapeHTML(row.date ?? "—");

    return escapeHTML(cellValue(row, key));
  }

  function renderTable() {
    const columns = getColumns(state.currentView);
    let rows = getFilteredRows();

    if (state.currentView === "debuts") {
      rows = rows.map(row => ({
        ...row,
        status: row.status === "Exit" ? "Exit" : row.status
      }));
    }

    state.visibleRows = rows;
    state.visibleColumns = columns;

    if (!columns.length) {
      ui.content.innerHTML = `<div class="empty">No table is configured for this section.</div>`;
      return;
    }

    if (!rows.length) {
      ui.content.innerHTML = `<div class="empty">No matching records. Try a different search or date filter.</div>`;
      return;
    }

    const headerHTML = columns.map(column =>
      `<th scope="col">${escapeHTML(column.label)}</th>`
    ).join("");

    const bodyHTML = rows.map(row => `
      <tr>
        ${columns.map(column => `
          <td data-label="${escapeHTML(column.label)}">${cellHTML(row, column)}</td>
        `).join("")}
      </tr>
    `).join("");

    ui.content.innerHTML = `
      <div class="result-count">
        Showing ${formatNumber(rows.length)} of ${formatNumber(currentViewRows().length)} matching records.
        Tables are capped at ${CONFIG.TABLE_LIMIT} rows per view.
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${headerHTML}</tr></thead>
          <tbody>${bodyHTML}</tbody>
        </table>
      </div>
    `;
  }

  function renderContent() {
    const info = VIEW_INFO[state.currentView] || VIEW_INFO.overview;

    ui.title.textContent = info.title;
    ui.description.textContent = info.description;

    const filteringDisabled = state.currentView === "overview" ||
      state.currentView === "records";

    $("#browser-section").style.display = filteringDisabled ? "none" : "";

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

  function updateDateControls() {
    const mode = ui.timeMode.value;

    ui.year.disabled = mode !== "year";
    ui.customDates.hidden = mode !== "custom";

    renderContent();
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportVisibleRows() {
    if (!state.visibleRows.length) {
      alert("There are no visible rows to export.");
      return;
    }

    const columns = state.visibleColumns;

    const rows = [
      columns.map(column => csvEscape(column.label)),
      ...state.visibleRows.map(row => columns.map(column => {
        const key = column.key;

        if (key === "topSong") {
          return csvEscape(row.topSong
            ? `${row.topSong.title} — ${row.topSong.artist}`
            : "");
        }

        if (key === "topAlbum") {
          return csvEscape(row.topAlbum
            ? `${row.topAlbum.title} — ${row.topAlbum.artist}`
            : "");
        }

        if (key === "songUnits" || key === "albumUnits" ||
            key === "unitsSold" || key === "debutUnits" ||
            key === "recentUnits") {
          return csvEscape(row[key] == null ? "" : row[key]);
        }

        if (key === "dateTs") return csvEscape(formatDate(row.dateTs));
        if (key === "debutTs") return csvEscape(formatDate(row.debutTs));

        return csvEscape(row[key] ?? "");
      }))
    ];

    const csv = rows.map(row => row.join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], {
      type: "text/csv;charset=utf-8;"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `stats-paradise-${state.currentView}-${dateKey(Date.now())}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function registerEvents() {
    ui.nav.addEventListener("click", event => {
      const button = event.target.closest("[data-view]");
      if (button) setView(button.dataset.view);
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
          Check the Music Vault file paths and the browser console, then reload Stats Paradise.
        </div>
      `;
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
