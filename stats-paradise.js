
// Stats Paradise — independent YourHot100 statistics engine.
// The UI never displays internal chart-ranking inputs.
// Visible performance measure: YourHot100 units sold.

"use strict";

const SP = (() => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const MIN_ALBUM_TRACKS = 3;

  // Preserve the existing YourHot100 methodology internally.
  // These intermediate ranking values are never displayed or exported.
  const songUnits = (activity, rankValue) =>
    activity * 50000 + rankValue * 500;
  const albumUnits = (activity, rankValue) =>
    activity * 5000 + rankValue * 500;

  const state = {
    view: "imports",
    period: "all",
    startDate: "",
    endDate: "",
    search: "",
    sortKey: "units",
    sortDirection: "desc",
    raw: { tracks: new Map(), albums: new Map(), artists: new Map(), events: [], manifest: null, ineligible: [] },
    weeks: [],
    songs: [],
    albums: [],
    artists: [],
    eligibleAlbumIds: new Set(),
    albumTrackSets: new Map(),
    importRows: [],
    issues: [],
    meta: {}
  };

  const $ = id => document.getElementById(id);
  const safe = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
  const fmt = n => Number(n || 0).toLocaleString("en-US");
  const dateFmt = ms => Number.isFinite(ms)
    ? new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "—";
  const dateISO = ms => Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
  const rankLabel = n => Number.isFinite(n) && n < 101 ? `#${n}` : "—";
  const unique = items => [...new Set(items.filter(Boolean).map(String))];

  function mapData(input) {
    if (Array.isArray(input)) {
      return new Map(input.filter(x => x && x.id !== undefined).map(x => [String(x.id), x]));
    }
    if (input && typeof input === "object") {
      return new Map(Object.entries(input).map(([id, x]) => [String(id), x]));
    }
    return new Map();
  }

  function timestampSeconds(value) {
    if (value && typeof value === "object") {
      value = value.uts ?? value.timestamp ?? value.played_at ?? value.date ?? value["#text"];
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
      const t = Date.parse(value);
      if (Number.isFinite(t)) return Math.floor(t / 1000);
    }
    return null;
  }

  function weekStartMs(timestamp) {
    const d = new Date(timestamp * 1000);
    d.setUTCHours(0, 0, 0, 0);
    const daysSinceFriday = (d.getUTCDay() + 2) % 7;
    d.setUTCDate(d.getUTCDate() - daysSinceFriday);
    return d.getTime();
  }

  function rankValue(rank) {
    if (rank === 1) return 100;
    if (rank === 2) return 98;
    return Math.max(1, Math.round(98 - ((rank - 2) * 97 / 98)));
  }

  function artistName(id) {
    const artist = state.raw.artists.get(String(id));
    return artist?.name || artist?.title || "Unknown Artist";
  }

  function resolveArtistId(value) {
    if (value && typeof value === "object") {
      value = value.id ?? value.artist_id ?? value.artistId ?? value.mbid ?? value.name;
    }
    if (value === null || value === undefined || value === "") return null;
    const v = String(value).trim();
    if (state.raw.artists.has(v)) return v;
    const found = [...state.raw.artists].find(([, a]) =>
      String(a?.name || a?.title || "").trim().toLowerCase() === v.toLowerCase());
    return found?.[0] || null;
  }

  function parseCredits(track) {
    if (!track) return [];
    let ids = track.artist_ids ?? track.artists_ids ?? track.artistIds ?? track.artist_id_list;
    if (typeof ids === "string" && ids.trim().startsWith("[")) {
      try { ids = JSON.parse(ids); } catch {}
    }
    const out = [];
    for (const value of Array.isArray(ids) ? ids : ids ? [ids] : []) {
      const id = resolveArtistId(value);
      if (id && !out.includes(id)) out.push(id);
    }
    let credits = track.artist_names ?? track.artists ?? track.artist_credits ?? track.artist;
    if (typeof credits === "string") {
      credits = credits.split(/,\s*|\s+(?:feat\.?|ft\.?|&|x)\s+/i).filter(Boolean);
    }
    if (!Array.isArray(credits)) credits = [];
    for (const value of credits) {
      const id = resolveArtistId(value);
      if (id && !out.includes(id)) out.push(id);
    }
    const lead = track.primary_artist_id ?? track.artist_id;
    if (lead && state.raw.artists.has(String(lead)) && !out.includes(String(lead))) {
      out.unshift(String(lead));
    }
    return out;
  }

  function trackArtistLabels(track) {
    const ids = parseCredits(track);
    return ids.length ? ids.map(artistName) : [artistName(track?.primary_artist_id || track?.artist_id)];
  }

  function trackAlbumIds(track) {
    const ids = Array.isArray(track?.album_ids) ? track.album_ids.map(String) : [];
    if (!ids.length && track?.album_id) ids.push(String(track.album_id));
    return unique(ids);
  }

  async function fetchJSON(path, optional = false) {
    const response = await fetch(path, { cache: "no-store" });
    if (optional && !response.ok) return null;
    if (!response.ok) throw new Error(`Could not load ${path} (HTTP ${response.status}).`);
    return response.json();
  }

  async function loadVault() {
    $("status").textContent = "Loading artists, tracks, albums and listening history…";
    const [tracks, albums, artists, historyResponse, manifest, ineligible, importManifest] =
      await Promise.all([
        fetchJSON("vault/tracks.json"),
        fetchJSON("vault/albums.json"),
        fetchJSON("vault/artists.json"),
        fetch("vault/listening_history.jsonl", { cache: "no-store" }),
        fetchJSON("vault/manifest.json", true),
        fetchJSON("vault/ineligible_releases.json", true),
        fetchJSON("vault/import_manifest.json", true)
      ]);

    if (!historyResponse.ok) {
      throw new Error(`Could not load vault/listening_history.jsonl (HTTP ${historyResponse.status}).`);
    }

    const historyText = await historyResponse.text();
    const lines = historyText.split(/\r?\n/).filter(Boolean);
    const parsed = [];
    let malformedLines = 0;

    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        malformedLines++;
      }
    }

    state.raw.tracks = mapData(tracks);
    state.raw.albums = mapData(albums);
    state.raw.artists = mapData(artists);
    state.raw.manifest = manifest || {};
    state.raw.importManifest = importManifest || {};
    state.raw.ineligible = Array.isArray(ineligible) ? ineligible : [];
    state.raw.events = parsed.map((event, index) => ({
      ...event,
      _sourceIndex: index,
      _timestamp: timestampSeconds(event.timestamp)
    }));

    state.meta = {
      historyLines: lines.length,
      parsedEvents: parsed.length,
      malformedLines,
      eventsWithoutTimestamp: parsed.filter(e => e._timestamp === null).length,
      duplicateTimestampCandidates: 0
    };

    state.raw.events = state.raw.events.filter(e => e.track_id && e._timestamp !== null)
      .sort((a, b) => a._timestamp - b._timestamp);

    if (!state.raw.events.length) {
      throw new Error("No valid timestamped listening events were found in the vault.");
    }

    buildAlbumMembership();
    buildSnapshots();
    buildImportInventory();
    buildIntegrityIssues();
    fillPeriodOptions();
    render();
  }

  function buildAlbumMembership() {
    const members = new Map();

    state.raw.albums.forEach((album, albumId) => {
      members.set(String(albumId), new Set(
        (Array.isArray(album.track_ids) ? album.track_ids : [])
          .map(String).filter(id => state.raw.tracks.has(id))
      ));
    });

    state.raw.tracks.forEach((track, trackId) => {
      for (const albumId of trackAlbumIds(track)) {
        if (!members.has(albumId)) continue;
        members.get(albumId).add(String(trackId));
      }
    });

    state.albumTrackSets = members;
    state.eligibleAlbumIds = new Set(
      [...members].filter(([, trackIds]) => trackIds.size >= MIN_ALBUM_TRACKS).map(([id]) => id)
    );
  }

  // Reconstruct each Friday–Thursday Top 100 using the existing chart methodology.
  // Only visible result fields are retained; intermediate inputs are not surfaced.
  function compileEntries(activityMap, type) {
    let rows = [];

    activityMap.forEach((activity, id) => {
      if (type === "songs") {
        const track = state.raw.tracks.get(String(id));
        if (!track) return;
        const credits = parseCredits(track);
        const leadId = String(track.primary_artist_id || track.artist_id || credits[0] || "");
        rows.push({
          id: String(id),
          title: track.title || "Unknown Track",
          artist_id: leadId || null,
          artist_ids: credits.length ? credits : leadId ? [leadId] : [],
          artist: trackArtistLabels(track).join(", "),
          _activity: activity
        });
      } else {
        const album = state.raw.albums.get(String(id));
        if (!album) return;
        const leadId = String(album.primary_artist_id || album.artist_id || "");
        rows.push({
          id: String(id),
          title: album.title || "Unknown Album",
          artist_id: leadId || null,
          artist_ids: leadId ? [leadId] : [],
          artist: artistName(leadId),
          track_count: state.albumTrackSets.get(String(id))?.size || 0,
          _activity: activity
        });
      }
    });

    rows.sort((a, b) => b._activity - a._activity || a.title.localeCompare(b.title));
    rows = rows.slice(0, 100).map((row, index) => ({
      ...row,
      units: type === "songs"
        ? songUnits(row._activity, rankValue(index + 1))
        : albumUnits(row._activity, rankValue(index + 1))
    }));

    rows.sort((a, b) => b.units - a.units || a.title.localeCompare(b.title));
    return rows.slice(0, 100).map((row, index) => {
      delete row._activity;
      return { ...row, rank: index + 1 };
    });
  }

  function buildSnapshots() {
    const eventsByWeek = new Map();
    for (const event of state.raw.events) {
      const week = weekStartMs(event._timestamp);
      if (!eventsByWeek.has(week)) eventsByWeek.set(week, []);
      eventsByWeek.get(week).push(event);
    }

    const dates = [...eventsByWeek.keys()].sort((a, b) => a - b);
    const weeks = [];
    const songHistory = new Map();
    const albumHistory = new Map();

    for (const start of dates) {
      const events = eventsByWeek.get(start);
      const activity = new Map();
      const albumActivity = new Map();

      for (const event of events) {
        const trackId = String(event.track_id);
        activity.set(trackId, (activity.get(trackId) || 0) + 1);
        const track = state.raw.tracks.get(trackId);
        if (!track) continue;

        for (const albumId of trackAlbumIds(track)) {
          if (!state.eligibleAlbumIds.has(albumId)) continue;
          albumActivity.set(albumId, (albumActivity.get(albumId) || 0) + 1);
        }
      }

      const songs = compileEntries(activity, "songs");
      const albums = compileEntries(albumActivity, "albums");
      updateHistory(songs, songHistory, start);
      updateHistory(albums, albumHistory, start);

      weeks.push({
        start,
        end: start + WEEK_MS - 1,
        year: new Date(start).getUTCFullYear(),
        songs,
        albums,
        newSongs: songs.filter(x => x.is_new).length,
        songReentries: songs.filter(x => x.is_reentry).length,
        newAlbums: albums.filter(x => x.is_new).length,
        albumReentries: albums.filter(x => x.is_reentry).length
      });
    }

    state.weeks = weeks;
    state.songs = [...songHistory.values()].map(finalizeRecord);
    state.albums = [...albumHistory.values()].map(finalizeRecord);
    state.artists = buildArtistRecords(weeks);
  }

  function updateHistory(rows, history, start) {
    const active = new Set(rows.map(row => row.id));

    for (const row of rows) {
      let record = history.get(row.id);
      if (!record) {
        record = {
          id: row.id, title: row.title, artist: row.artist,
          artist_id: row.artist_id, artist_ids: row.artist_ids || [],
          track_count: row.track_count || 0,
          peak: 101, debutMs: start, debutRank: row.rank,
          lastMs: start, weeks: [], weeksAtNo1: 0, maxNo1Streak: 0,
          currentNo1Streak: 0, maxChartStreak: 0, currentChartStreak: 0,
          top5: 0, top10: 0, top20: 0, top40: 0, top50: 0,
          reentries: 0, previousSeen: null
        };
        history.set(row.id, record);
        row.is_new = true;
        row.is_reentry = false;
      } else {
        row.is_new = false;
        row.is_reentry = record.lastMs < start - WEEK_MS;
        if (row.is_reentry) record.reentries++;
      }

      record.title = row.title || record.title;
      record.artist = row.artist || record.artist;
      record.artist_id = row.artist_id || record.artist_id;
      record.artist_ids = row.artist_ids || record.artist_ids;
      record.lastMs = start;
      record.peak = Math.min(record.peak, row.rank);
      record.weeks.push({
        start, year: new Date(start).getUTCFullYear(),
        rank: row.rank, units: row.units, is_new: row.is_new,
        is_reentry: row.is_reentry
      });

      if (row.rank === 1) {
        record.weeksAtNo1++;
        record.currentNo1Streak++;
        record.maxNo1Streak = Math.max(record.maxNo1Streak, record.currentNo1Streak);
      } else {
        record.currentNo1Streak = 0;
      }

      const priorWeek = record.previousSeen === start - WEEK_MS;
      record.currentChartStreak = priorWeek ? record.currentChartStreak + 1 : 1;
      record.maxChartStreak = Math.max(record.maxChartStreak, record.currentChartStreak);
      if (row.rank <= 5) record.top5++;
      if (row.rank <= 10) record.top10++;
      if (row.rank <= 20) record.top20++;
      if (row.rank <= 40) record.top40++;
      if (row.rank <= 50) record.top50++;
      record.previousSeen = start;
      row.debut_date = dateISO(record.debutMs);
    }

    // Expose original debut only once; a return is not another debut.
    for (const row of rows) {
      const record = history.get(row.id);
      row.debut_date = dateISO(record.debutMs);
      row.debut_rank = record.debutRank;
    }
  }

  function finalizeRecord(record) {
    const weeks = record.weeks;
    const firstNo1 = weeks.find(x => x.rank === 1);
    const peakWeek = weeks.reduce((best, row) => row.rank < best.rank ? row : best, weeks[0]);
    const units = weeks.reduce((sum, row) => sum + row.units, 0);
    const yearly = new Map();

    for (const row of weeks) {
      yearly.set(row.year, (yearly.get(row.year) || 0) + row.units);
    }

    return {
      ...record,
      units,
      weekCount: weeks.length,
      peakDate: dateFmt(peakWeek.start),
      peakMs: peakWeek.start,
      debutDate: dateFmt(record.debutMs),
      lastDate: dateFmt(record.lastMs),
      debutYear: new Date(record.debutMs).getUTCFullYear(),
      lastYear: new Date(record.lastMs).getUTCFullYear(),
      firstNo1Date: firstNo1 ? dateFmt(firstNo1.start) : "—",
      yearUnits: yearly,
      no1Weeks: weeks.filter(x => x.rank === 1).length,
      newEntryWeeks: weeks.filter(x => x.is_new).length,
      reentryWeeks: weeks.filter(x => x.is_reentry).length
    };
  }

  function buildArtistRecords(weeks) {
    const records = new Map();

    const ensure = id => {
      if (!id) return null;
      id = String(id);
      if (!records.has(id)) {
        records.set(id, {
          id, name: artistName(id),
          songUnits: 0, albumUnits: 0,
          songWeeks: 0, albumWeeks: 0,
          songIds: new Set(), albumIds: new Set(),
          no1Songs: new Set(), no1Albums: new Set(),
          songNo1Weeks: 0, albumNo1Weeks: 0,
          top10SongIds: new Set(), maxTop10InWeek: 0,
          firstDate: null, lastDate: null,
          chartWeeks: new Set(), yearUnits: new Map()
        });
      }
      return records.get(id);
    };

    for (const week of weeks) {
      const inTop10 = new Map();

      for (const song of week.songs) {
        for (const id of unique(song.artist_ids?.length ? song.artist_ids : [song.artist_id])) {
          const artist = ensure(id);
          if (!artist) continue;
          artist.songUnits += song.units;
          artist.songWeeks++;
          artist.songIds.add(song.id);
          if (song.rank === 1) {
            artist.no1Songs.add(song.id);
            artist.songNo1Weeks++;
          }
          if (song.rank <= 10) {
            artist.top10SongIds.add(song.id);
            inTop10.set(id, (inTop10.get(id) || 0) + 1);
          }
          artist.chartWeeks.add(week.start);
          artist.firstDate = artist.firstDate === null ? week.start : Math.min(artist.firstDate, week.start);
          artist.lastDate = artist.lastDate === null ? week.start : Math.max(artist.lastDate, week.start);
          artist.yearUnits.set(week.year, (artist.yearUnits.get(week.year) || 0) + song.units);
        }
      }

      inTop10.forEach((count, id) => {
        const artist = ensure(id);
        if (artist) artist.maxTop10InWeek = Math.max(artist.maxTop10InWeek, count);
      });

      for (const album of week.albums) {
        // Album credit belongs exclusively to the lead album artist.
        const artist = ensure(album.artist_id);
        if (!artist) continue;
        artist.albumUnits += album.units;
        artist.albumWeeks++;
        artist.albumIds.add(album.id);
        if (album.rank === 1) {
          artist.no1Albums.add(album.id);
          artist.albumNo1Weeks++;
        }
        artist.yearUnits.set(week.year, (artist.yearUnits.get(week.year) || 0) + album.units);
        artist.chartWeeks.add(week.start);
        artist.firstDate = artist.firstDate === null ? week.start : Math.min(artist.firstDate, week.start);
        artist.lastDate = artist.lastDate === null ? week.start : Math.max(artist.lastDate, week.start);
      }
    }

    return [...records.values()].map(a => ({
      ...a,
      songCount: a.songIds.size,
      albumCount: a.albumIds.size,
      no1SongCount: a.no1Songs.size,
      no1AlbumCount: a.no1Albums.size,
      top10SongCount: a.top10SongIds.size,
      activeWeeks: a.chartWeeks.size,
      combinedUnits: a.songUnits + a.albumUnits,
      careerStart: dateFmt(a.firstDate),
      careerLatest: dateFmt(a.lastDate),
      careerSpanDays: a.firstDate !== null ? Math.round((a.lastDate - a.firstDate) / 86400000) : 0
    }));
  }

  function buildImportInventory() {
    const bySource = new Map();

    for (const event of state.raw.events) {
      const source = event.source_provenance || "Source not recorded";
      if (!bySource.has(source)) bySource.set(source, {
        source, events: 0, earliest: null, latest: null, missingTrack: 0, missingSource: !event.source_provenance
      });
      const row = bySource.get(source);
      row.events++;
      row.earliest = row.earliest === null ? event._timestamp : Math.min(row.earliest, event._timestamp);
      row.latest = row.latest === null ? event._timestamp : Math.max(row.latest, event._timestamp);
      if (!state.raw.tracks.has(String(event.track_id))) row.missingTrack++;
    }

    state.importRows = [...bySource.values()].map(x => ({
      ...x,
      earliestDate: dateFmt(x.earliest * 1000),
      latestDate: dateFmt(x.latest * 1000),
      status: x.missingTrack ? "Review" : "Loaded"
    })).sort((a, b) => a.source.localeCompare(b.source));

    state.meta.earliest = state.weeks[0]?.start ?? null;
    state.meta.latest = state.weeks[state.weeks.length - 1]?.start ?? null;
    state.meta.chartWeeks = state.weeks.length;
    state.meta.uniqueTracks = state.raw.tracks.size;
    state.meta.uniqueAlbums = state.raw.albums.size;
    state.meta.eligibleAlbums = state.eligibleAlbumIds.size;
    state.meta.uniqueArtists = state.raw.artists.size;
    state.meta.validEvents = state.raw.events.length;
    state.meta.totalSources = state.importRows.length;
  }

  function buildIntegrityIssues() {
    const issues = [];
    const add = (severity, type, count, description) => {
      if (count > 0) issues.push({ severity, type, count, description });
    };

    const missingArtist = [...state.raw.tracks.values()]
      .filter(t => !state.raw.artists.has(String(t.primary_artist_id || t.artist_id || ""))).length;
    const missingAlbumTracks = [...state.raw.albums.values()].reduce((total, album) =>
      total + (album.track_ids || []).filter(id => !state.raw.tracks.has(String(id))).length, 0);
    const brokenEvents = state.raw.events.filter(e => !state.raw.tracks.has(String(e.track_id))).length;
    const noAlbums = [...state.raw.tracks.values()].filter(t => trackAlbumIds(t).length === 0).length;
    const lowTrackAlbums = [...state.albumTrackSets.values()].filter(set => set.size < MIN_ALBUM_TRACKS).length;

    add("warn", "Missing timestamps", state.meta.eventsWithoutTimestamp,
      "Imported event lines without a valid timestamp; excluded from historical chart reconstruction.");
    add("bad", "Malformed JSONL lines", state.meta.malformedLines,
      "History lines that could not be parsed as valid JSON.");
    add("bad", "Missing track artists", missingArtist,
      "Track records whose lead artist reference does not resolve in artists.json.");
    add("warn", "Broken album links", missingAlbumTracks,
      "Album-to-track references that point to absent canonical tracks.");
    add("bad", "Broken event links", brokenEvents,
      "Listening events whose track_id does not resolve in tracks.json.");
    add("warn", "Tracks without albums", noAlbums,
      "Canonical tracks with no linked release.");
    add("warn", "Ineligible releases", lowTrackAlbums,
      "Releases with fewer than three distinct canonical tracks.");

    state.issues = issues;
  }

  function fillPeriodOptions() {
    const years = [...new Set(state.weeks.map(w => w.year))].sort((a, b) => b - a);
    $("period-filter").innerHTML = `<option value="all">All available history</option>` +
      years.map(y => `<option value="${y}">${y}</option>`).join("");
  }

  function weekInPeriod(week) {
    const start = week.start;
    const end = week.end;

    if (state.period !== "all" && Number.isFinite(Number(state.period))) {
      if (week.year !== Number(state.period)) return false;
    }
    if (state.startDate) {
      const lo = Date.parse(`${state.startDate}T00:00:00Z`);
      if (end < lo) return false;
    }
    if (state.endDate) {
      const hi = Date.parse(`${state.endDate}T23:59:59.999Z`);
      if (start > hi) return false;
    }
    return true;
  }

  function scopedWeeks() {
    return state.weeks.filter(weekInPeriod);
  }

  function periodLabel() {
    if (state.startDate || state.endDate) {
      return `${state.startDate || "earliest"} – ${state.endDate || "latest"}`;
    }
    return state.period === "all" ? "All available history" : String(state.period);
  }

  function scopeRecord(record, type, weeks) {
    const weeklyRows = [];
    for (const week of weeks) {
      const row = (type === "songs" ? week.songs : week.albums).find(x => x.id === record.id);
      if (row) weeklyRows.push({ ...row, start: week.start, year: week.year });
    }

    if (!weeklyRows.length) return null;
    const sum = weeklyRows.reduce((n, x) => n + x.units, 0);
    const peak = Math.min(...weeklyRows.map(x => x.rank));
    const debut = weeklyRows[0];
    const peakWeek = weeklyRows.reduce((a, b) => b.rank < a.rank ? b : a);
    let maxStreak = 0, currentStreak = 0, currentChartRun = 0, maxChartRun = 0, lastStart = null;
    for (const row of weeklyRows) {
      currentChartRun = lastStart === row.start - WEEK_MS ? currentChartRun + 1 : 1;
      maxChartRun = Math.max(maxChartRun, currentChartRun);
      if (row.rank === 1) {
        currentStreak = lastStart === row.start - WEEK_MS ? currentStreak + 1 : 1;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else currentStreak = 0;
      lastStart = row.start;
    }

    return {
      ...record, periodUnits: sum, periodWeeks: weeklyRows.length,
      periodPeak: peak, periodPeakDate: dateFmt(peakWeek.start),
      periodDebutDate: dateFmt(debut.start), periodDebutRank: debut.rank,
      periodNo1Weeks: weeklyRows.filter(x => x.rank === 1).length,
      periodMaxNo1Streak: maxStreak, periodMaxChartRun: maxChartRun,
      periodHistory: weeklyRows
    };
  }

  function scopedEntities(type, weeks) {
    const all = type === "songs" ? state.songs : type === "albums" ? state.albums : state.artists;
    if (type === "artists") return scopedArtistRecords(weeks);
    return all.map(record => scopeRecord(record, type, weeks)).filter(Boolean);
  }

  function scopedArtistRecords(weeks) {
    return buildArtistRecords(weeks);
  }

  const titles = {
    imports: ["Import Centre", "Every source observed in the normalized vault, with coverage and processing health."],
    overview: ["All-Time Overview", "The size, scope and most important accomplishments of your chart archive."],
    songs: ["Song Records", "Every song record with lifetime and selected-period statistics."],
    albums: ["Album Records", "Every eligible release and its chart history, with album credit assigned to its lead artist."],
    artists: ["Artist Records", "Catalog performance across all credited songs and lead-artist albums."],
    debuts: ["Debuts & Returns", "First appearances, highest debuts, new entries and re-entries."],
    numberones: ["No. 1 Archive", "Every song and album that reached the summit, with each reign recorded."],
    records: ["The Record Book", "Longest runs, most No. 1s, biggest lifetime performances and historical records."],
    calendar: ["Calendar History", "Year-by-year and week-by-week leaders, debuts and units sold."],
    quality: ["Vault Integrity", "Missing data, broken relationships, eligibility and source coverage diagnostics."]
  };

  function metric(label, value, note = "") {
    return `<div class="metric"><div class="label">${safe(label)}</div><div class="value">${safe(value)}</div><p class="muted small">${safe(note)}</p></div>`;
  }

  function sectionHeading(title, note = "") {
    return `<div><h2>${safe(title)}</h2>${note ? `<p class="muted small">${safe(note)}</p>` : ""}</div>`;
  }

  function tableMarkup(rows, columns, tableId = "results-table") {
    const currentSort = state.sortKey;
    const headers = columns.map(col =>
      `<th class="${col.numeric ? "num" : ""}"><button data-sort="${safe(col.key)}">${safe(col.label)}${currentSort === col.key ? (state.sortDirection === "asc" ? " ↑" : " ↓") : ""}</button></th>`
    ).join("");

    if (!rows.length) {
      return `<div class="status">No matching records in the selected period.</div>`;
    }

    const body = rows.map((row, index) =>
      `<tr>${columns.map(col => {
        let value = row[col.key];
        if (col.format) value = col.format(row, value);
        else value = value === null || value === undefined ? "—" : value;
        return `<td class="${col.numeric ? "num" : ""}">${value}</td>`;
      }).join("")}</tr>`
    ).join("");

    return `<div class="table-wrap"><table id="${safe(tableId)}"><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div><p class="muted small">${fmt(rows.length)} record(s) in this result. Click a column heading to sort.</p>`;
  }

  function getSortValue(row, key) {
    const value = row[key];
    if (value instanceof Map) return 0;
    if (value instanceof Set) return value.size;
    if (value === null || value === undefined) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(value);
    return String(value).toLowerCase();
  }

  function searchableRows(rows) {
    const q = state.search.trim().toLowerCase();
    let out = rows;
    if (q) out = out.filter(row => Object.entries(row).some(([key, value]) => {
      if (["history", "weeks", "yearUnits", "artist_ids", "artistIds", "artistIds"].includes(key)) return false;
      if (value instanceof Map || value instanceof Set) return false;
      return String(value ?? "").toLowerCase().includes(q);
    }));

    out = [...out].sort((a, b) => {
      const av = getSortValue(a, state.sortKey);
      const bv = getSortValue(b, state.sortKey);
      let cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av).localeCompare(String(bv));
      return state.sortDirection === "asc" ? cmp : -cmp;
    });
    return out;
  }

  function unitsColumn(key = "periodUnits", label = "Units sold") {
    return { key, label, numeric: true, format: (_, value) => `<strong>${fmt(value)}</strong>` };
  }

  function entityLink(row, type) {
    const file = type === "songs" ? "track.html" : type === "albums" ? "album.html" : "artist.html";
    return `<a href="${file}?id=${encodeURIComponent(row.id)}">${safe(row.title || row.name)}</a>`;
  }

  function buildTable(type, weeks) {
    const scoped = scopedEntities(type, weeks);
    let rows = [];
    let cols = [];

    if (type === "songs") {
      rows = scoped.map(r => ({
        ...r,
        name: r.title, units: r.periodUnits, weeks: r.periodWeeks,
        no1weeks: r.periodNo1Weeks, peak: r.periodPeak,
        debut: r.periodDebutDate, run: r.periodMaxChartRun,
        streak: r.periodMaxNo1Streak, artistLabel: r.artist
      }));
      cols = [
        { key: "title", label: "Song", format: r => entityLink(r, "songs") },
        { key: "artistLabel", label: "Credited artists" },
        unitsColumn("units"),
        { key: "peak", label: "Peak", numeric: true, format: (_, v) => rankLabel(v) },
        { key: "no1weeks", label: "Weeks at #1", numeric: true, format: (_, v) => fmt(v) },
        { key: "weeks", label: "Weeks charted", numeric: true, format: (_, v) => fmt(v) },
        { key: "streak", label: "Longest #1 streak", numeric: true, format: (_, v) => fmt(v) },
        { key: "run", label: "Longest chart run", numeric: true, format: (_, v) => fmt(v) },
        { key: "debut", label: "First appearance" }
      ];
      state.sortKey = state.sortKey || "units";
    } else if (type === "albums") {
      rows = scoped.map(r => ({
        ...r, name: r.title, units: r.periodUnits, weeks: r.periodWeeks,
        no1weeks: r.periodNo1Weeks, peak: r.periodPeak, debut: r.periodDebutDate,
        streak: r.periodMaxNo1Streak, tracks: r.track_count || 0
      }));
      cols = [
        { key: "title", label: "Album", format: r => entityLink(r, "albums") },
        { key: "artist", label: "Lead album artist" },
        unitsColumn("units"),
        { key: "peak", label: "Peak", numeric: true, format: (_, v) => rankLabel(v) },
        { key: "no1weeks", label: "Weeks at #1", numeric: true, format: (_, v) => fmt(v) },
        { key: "weeks", label: "Weeks charted", numeric: true, format: (_, v) => fmt(v) },
        { key: "tracks", label: "Distinct tracks", numeric: true, format: (_, v) => fmt(v) },
        { key: "streak", label: "Longest #1 streak", numeric: true, format: (_, v) => fmt(v) },
        { key: "debut", label: "First appearance" }
      ];
    } else {
      rows = scoped.map(r => ({
        ...r, title: r.name, units: r.songUnits + r.albumUnits,
        songUnitsDisplay: r.songUnits, albumUnitsDisplay: r.albumUnits,
        songCount: r.songIds.size, albumCount: r.albumIds.size,
        no1SongCount: r.no1Songs.size, no1AlbumCount: r.no1Albums.size,
        songNo1WeeksDisplay: r.songNo1Weeks, albumNo1WeeksDisplay: r.albumNo1Weeks,
        top10SongCount: r.top10SongIds.size, weeks: r.activeWeeks,
        maxTop10: r.maxTop10InWeek
      }));
      cols = [
        { key: "name", label: "Artist", format: r => entityLink({ ...r, title: r.name }, "artists") },
        unitsColumn("units", "Combined units sold"),
        { key: "songUnitsDisplay", label: "Song units sold", numeric: true, format: (_, v) => fmt(v) },
        { key: "albumUnitsDisplay", label: "Album units sold", numeric: true, format: (_, v) => fmt(v) },
        { key: "songCount", label: "Songs charted", numeric: true, format: (_, v) => fmt(v) },
        { key: "albumCount", label: "Albums charted", numeric: true, format: (_, v) => fmt(v) },
        { key: "no1SongCount", label: "No. 1 songs", numeric: true, format: (_, v) => fmt(v) },
        { key: "no1AlbumCount", label: "No. 1 albums", numeric: true, format: (_, v) => fmt(v) },
        { key: "maxTop10", label: "Most simultaneous Top 10 songs", numeric: true, format: (_, v) => fmt(v) },
        { key: "weeks", label: "Active chart weeks", numeric: true, format: (_, v) => fmt(v) }
      ];
    }

    // Search and sorting act on the full matching table, not a fixed top 10.
    const visible = searchableRows(rows);
    return tableMarkup(visible, cols);
  }

  function overview(weeks) {
    const songs = state.songs.map(r => scopeRecord(r, "songs", weeks)).filter(Boolean);
    const albums = state.albums.map(r => scopeRecord(r, "albums", weeks)).filter(Boolean);
    const artists = buildArtistRecords(weeks);

    const songUnitsTotal = songs.reduce((s, r) => s + r.periodUnits, 0);
    const albumUnitsTotal = albums.reduce((s, r) => s + r.periodUnits, 0);
    const songNo1s = new Set(weeks.flatMap(w => w.songs.filter(x => x.rank === 1).map(x => x.id))).size;
    const albumNo1s = new Set(weeks.flatMap(w => w.albums.filter(x => x.rank === 1).map(x => x.id))).size;
    const peakSong = [...songs].sort((a, b) => b.periodUnits - a.periodUnits)[0];
    const peakAlbum = [...albums].sort((a, b) => b.periodUnits - a.periodUnits)[0];
    const topArtist = [...artists].sort((a, b) => b.combinedUnits - a.combinedUnits)[0];

    return `<div class="grid">
      ${metric("Chart weeks", fmt(weeks.length), periodLabel())}
      ${metric("Songs charted", fmt(songs.length), "Distinct songs active in this period")}
      ${metric("Eligible albums charted", fmt(albums.length), "Albums meeting the minimum-track rule")}
      ${metric("Artists represented", fmt(artists.length), "Credited song artists and lead album artists")}
      ${metric("Song units sold", fmt(songUnitsTotal), "Accumulated song-chart model units")}
      ${metric("Album units sold", fmt(albumUnitsTotal), "Accumulated album-chart model units")}
      ${metric("Distinct No. 1 songs", fmt(songNo1s), "Across selected chart weeks")}
      ${metric("Distinct No. 1 albums", fmt(albumNo1s), "Across selected chart weeks")}
    </div>
    <div class="grid three">
      <div class="panel"><div class="eyebrow">Top song by units sold</div>
        <h3 style="margin-top:8px">${peakSong ? entityLink({ ...peakSong, title: peakSong.title }, "songs") : "—"}</h3>
        <div class="value" style="font-size:26px;font-weight:900;margin-top:8px">${peakSong ? fmt(peakSong.periodUnits) : "—"}</div>
        <p class="muted small">Best peak in period: ${peakSong ? rankLabel(peakSong.periodPeak) : "—"}</p>
      </div>
      <div class="panel"><div class="eyebrow">Top album by units sold</div>
        <h3 style="margin-top:8px">${peakAlbum ? entityLink({ ...peakAlbum, title: peakAlbum.title }, "albums") : "—"}</h3>
        <div style="font-size:26px;font-weight:900;margin-top:8px">${peakAlbum ? fmt(peakAlbum.periodUnits) : "—"}</div>
        <p class="muted small">Best peak in period: ${peakAlbum ? rankLabel(peakAlbum.periodPeak) : "—"}</p>
      </div>
      <div class="panel"><div class="eyebrow">Top artist combined</div>
        <h3 style="margin-top:8px">${topArtist ? entityLink({ ...topArtist, title: topArtist.name }, "artists") : "—"}</h3>
        <div style="font-size:26px;font-weight:900;margin-top:8px">${topArtist ? fmt(topArtist.combinedUnits) : "—"}</div>
        <p class="muted small">Combined song and lead-album units sold; collaborator credits can overlap.</p>
      </div>
    </div>`;
  }

  function importsView() {
    const manifest = state.raw.manifest || {};
    const counts = manifest.record_counts || {};
    const rows = searchableRows(state.importRows.map(r => ({
      ...r, eventCount: r.events
    })));
    const columns = [
      { key: "source", label: "Recorded source file" },
      { key: "eventCount", label: "Valid vault events", numeric: true, format: (_, v) => fmt(v) },
      { key: "earliestDate", label: "Earliest event" },
      { key: "latestDate", label: "Latest event" },
      { key: "missingTrack", label: "Broken event links", numeric: true, format: (_, v) => fmt(v) },
      { key: "status", label: "Status", format: (_, v) => `<span class="pill ${v === "Loaded" ? "good" : "warn"}">${safe(v)}</span>` }
    ];

    return `<div class="grid">
      ${metric("Source files recorded", fmt(state.meta.totalSources), "Distinct source names found in event provenance")}
      ${metric("Valid timestamped events", fmt(state.meta.validEvents), "Used to reconstruct chart weeks")}
      ${metric("Unique canonical artists", fmt(state.raw.artists.size), "Current artists.json records")}
      ${metric("Unique canonical tracks", fmt(state.raw.tracks.size), "Current tracks.json records")}
      ${metric("All album records", fmt(state.raw.albums.size), "Including releases that may not qualify for the album chart")}
      ${metric("Eligible albums", fmt(state.eligibleAlbumIds.size), `Minimum ${MIN_ALBUM_TRACKS} distinct canonical tracks`)}
      ${metric("Imported lines without timestamps", fmt(state.meta.eventsWithoutTimestamp), "Not usable for historical chart week calculations")}
      ${metric("Malformed history lines", fmt(state.meta.malformedLines), "Could not be parsed from JSONL")}
    </div>
    <div class="panel">
      ${sectionHeading("Import inventory", "A source-level summary from event provenance retained in the normalized vault. This is not a raw-file byte-for-byte audit.")}
      <div class="toolbar" style="margin:13px 0"><input id="table-search" type="search" placeholder="Search file name or status…"></div>
      ${tableMarkup(rows, columns, "import-table")}
    </div>
    <div class="panel">
      ${sectionHeading("Builder manifest", "Counts reported by your vault builder, where available.")}
      <div class="grid three" style="margin-top:13px">
        ${metric("Artists in manifest", fmt(counts.artists ?? state.raw.artists.size))}
        ${metric("Tracks in manifest", fmt(counts.tracks ?? state.raw.tracks.size))}
        ${metric("Listening events in manifest", fmt(counts.listening_events ?? state.meta.parsedEvents))}
        ${metric("Eligible albums in manifest", fmt(counts.eligible_albums ?? state.eligibleAlbumIds.size))}
        ${metric("Ineligible releases", fmt(counts.ineligible_releases ?? state.raw.ineligible.length))}
        ${metric("Builder status", manifest.build_status || "Not recorded", "Source manifest field")}
      </div>
      <p class="muted small" style="margin-top:12px">Raw source totals cannot always be reconstructed from canonical vault records alone. Where the builder hasn't stored import-level accepted/rejected counts, this page reports that limitation rather than inventing them.</p>
    </div>`;
  }

  function debutsView(weeks) {
    const songs = state.songs.filter(s => {
      const w = weeks.find(w => w.start === s.debutMs);
      return !!w;
    }).map(s => ({
      ...s, name: s.title,
      units: s.weeks.filter(w => weeks.some(sw => sw.start === w.start)).reduce((n, w) => n + w.units, 0),
      debut: s.debutDate,
      peak: s.debutRank,
      periodPeak: Math.min(...s.weeks.filter(w => weeks.some(sw => sw.start === w.start)).map(w => w.rank)),
      type: "Song"
    }));
    const albums = state.albums.filter(a => weeks.some(w => w.start === a.debutMs)).map(a => ({
      ...a, name: a.title,
      units: a.weeks.filter(w => weeks.some(sw => sw.start === w.start)).reduce((n, w) => n + w.units, 0),
      debut: a.debutDate, peak: a.debutRank,
      periodPeak: Math.min(...a.weeks.filter(w => weeks.some(sw => sw.start === w.start)).map(w => w.rank)),
      type: "Album"
    }));

    const rows = searchableRows([
      ...songs.map(s => ({ ...s, recordType: "Song", artistLabel: s.artist })),
      ...albums.map(a => ({ ...a, recordType: "Album", artistLabel: a.artist }))
    ]);
    const cols = [
      { key: "recordType", label: "Type" },
      { key: "title", label: "Title", format: r => entityLink(r, r.recordType === "Song" ? "songs" : "albums") },
      { key: "artistLabel", label: "Artist(s)" },
      { key: "debut", label: "Original debut date" },
      { key: "debutRank", label: "Debut rank", numeric: true, format: (_, v) => rankLabel(v) },
      { key: "periodPeak", label: "Peak in selected period", numeric: true, format: (_, v) => rankLabel(v) },
      unitsColumn("units")
    ];
    return `<div class="panel">${sectionHeading("Original debuts", "An item appears here only in the period containing its original debut. Later returns remain re-entries.")}${tableMarkup(rows, cols)}</div>
    <div class="panel">${sectionHeading("Re-entry activity")}${tableMarkup(searchableRows(weeks.map(w => ({
      date: dateFmt(w.start), newSongs: w.newSongs, reentries: w.songReentries,
      newAlbums: w.newAlbums, albumReturns: w.albumReentries
    }))), [
      { key: "date", label: "Chart week" },
      { key: "newSongs", label: "New songs", numeric: true, format: (_, v) => fmt(v) },
      { key: "reentries", label: "Song re-entries", numeric: true, format: (_, v) => fmt(v) },
      { key: "newAlbums", label: "New albums", numeric: true, format: (_, v) => fmt(v) },
      { key: "albumReturns", label: "Album re-entries", numeric: true, format: (_, v) => fmt(v) }
    ])}</div>`;
  }

  function numberOneView(weeks) {
    const songMap = new Map(), albumMap = new Map();

    for (const w of weeks) {
      for (const e of w.songs.filter(x => x.rank === 1)) {
        if (!songMap.has(e.id)) songMap.set(e.id, {
          ...e, type: "Song", title: e.title, artistLabel: e.artist,
          units: 0, weeksAtNo1: 0, firstDate: dateFmt(w.start), lastDate: dateFmt(w.start)
        });
        const r = songMap.get(e.id);
        r.units += e.units; r.weeksAtNo1++; r.lastDate = dateFmt(w.start);
      }
      for (const e of w.albums.filter(x => x.rank === 1)) {
        if (!albumMap.has(e.id)) albumMap.set(e.id, {
          ...e, type: "Album", title: e.title, artistLabel: e.artist,
          units: 0, weeksAtNo1: 0, firstDate: dateFmt(w.start), lastDate: dateFmt(w.start)
        });
        const r = albumMap.get(e.id);
        r.units += e.units; r.weeksAtNo1++; r.lastDate = dateFmt(w.start);
      }
    }

    const rows = searchableRows([
      ...[...songMap.values()].map(r => ({ ...r, rowType: "Song" })),
      ...[...albumMap.values()].map(r => ({ ...r, rowType: "Album" }))
    ]);

    return `<div class="grid">
      ${metric("Distinct No. 1 songs", fmt(songMap.size), periodLabel())}
      ${metric("Distinct No. 1 albums", fmt(albumMap.size), periodLabel())}
      ${metric("Song No. 1 weeks", fmt([...songMap.values()].reduce((s, r) => s + r.weeksAtNo1, 0)))}
      ${metric("Album No. 1 weeks", fmt([...albumMap.values()].reduce((s, r) => s + r.weeksAtNo1, 0)))}
    </div>
    <div class="panel">${sectionHeading("Every No. 1 entry", "Lifetime first-debut data is retained separately; this table shows performance during the selected period.")}
      ${tableMarkup(rows, [
        { key: "rowType", label: "Type" },
        { key: "title", label: "Song or album", format: r => entityLink(r, r.rowType === "Song" ? "songs" : "albums") },
        { key: "artistLabel", label: "Artist(s)" },
        unitsColumn("units"),
        { key: "weeksAtNo1", label: "Weeks at #1", numeric: true, format: (_, v) => fmt(v) },
        { key: "firstDate", label: "First No. 1 week" },
        { key: "lastDate", label: "Latest No. 1 week" }
      ])}
    </div>`;
  }

  function recordBook(weeks) {
    const songs = state.songs.map(r => scopeRecord(r, "songs", weeks)).filter(Boolean);
    const albums = state.albums.map(r => scopeRecord(r, "albums", weeks)).filter(Boolean);
    const artists = buildArtistRecords(weeks);

    const best = (rows, metricKey) => [...rows].sort((a, b) => b[metricKey] - a[metricKey])[0];
    const mostSongUnits = best(songs, "periodUnits");
    const mostAlbumUnits = best(albums, "periodUnits");
    const songNo1s = new Map();

    for (const w of weeks) {
      for (const s of w.songs.filter(x => x.rank === 1)) {
        if (!songNo1s.has(s.id)) songNo1s.set(s.id, { ...s, weeks: 0, units: 0 });
        const r = songNo1s.get(s.id); r.weeks++; r.units += s.units;
      }
    }

    const mostNo1Weeks = [...songNo1s.values()].sort((a, b) => b.weeks - a.weeks)[0];
    const longestSongStreak = best(songs, "periodMaxNo1Streak");
    const longestAlbumStreak = best(albums, "periodMaxNo1Streak");
    const longestSongRun = best(songs, "periodMaxChartRun");
    const mostNo1Artist = [...artists].sort((a, b) => b.no1Songs.size - a.no1Songs.size)[0];
    const mostTop10Artist = [...artists].sort((a, b) => b.maxTop10InWeek - a.maxTop10InWeek)[0];
    const mostAlbumNo1 = best(albums, "periodNo1Weeks");
    const slowBurn = [...songs].filter(x => x.periodPeak < 101).sort((a, b) =>
      (b.peakMs - b.debutMs) - (a.peakMs - a.debutMs))[0];

    const items = [
      ["Most song units sold", mostSongUnits?.title, mostSongUnits?.periodUnits, "Song", mostSongUnits],
      ["Most album units sold", mostAlbumUnits?.title, mostAlbumUnits?.periodUnits, "Album", mostAlbumUnits],
      ["Most No. 1 weeks by song", mostNo1Weeks?.title, mostNo1Weeks?.weeks, "Song", mostNo1Weeks],
      ["Longest song No. 1 streak", longestSongStreak?.title, longestSongStreak?.periodMaxNo1Streak, "Song", longestSongStreak],
      ["Longest album No. 1 streak", longestAlbumStreak?.title, longestAlbumStreak?.periodMaxNo1Streak, "Album", longestAlbumStreak],
      ["Longest uninterrupted song chart run", longestSongRun?.title, longestSongRun?.periodMaxChartRun, "Song", longestSongRun],
      ["Most distinct No. 1 songs by artist", mostNo1Artist?.name, mostNo1Artist?.no1Songs.size, "Artist", mostNo1Artist],
      ["Most simultaneous Top 10 songs", mostTop10Artist?.name, mostTop10Artist?.maxTop10InWeek, "Artist", mostTop10Artist],
      ["Most album No. 1 weeks", mostAlbumNo1?.title, mostAlbumNo1?.periodNo1Weeks, "Album", mostAlbumNo1],
      ["Longest debut-to-peak journey", slowBurn?.title, slowBurn ? Math.max(1, Math.round((slowBurn.peakMs - slowBurn.debutMs) / WEEK_MS) + 1) : null, "Song", slowBurn]
    ];

    return `<div class="grid three">${items.map(([label, name, value, kind, row]) =>
      `<div class="panel"><div class="eyebrow">${safe(label)}</div>
        <h3 style="margin-top:9px">${row ? safe(name || row.title) : "—"}</h3>
        <div style="font-size:26px;font-weight:900;margin-top:9px">${value === null || value === undefined ? "—" : fmt(value)}</div>
        <p class="muted small">${safe(kind)} · ${safe(periodLabel())}</p></div>`
    ).join("")}</div>
    <div class="panel">${sectionHeading("Artist No. 1 rankings")}
      ${buildTable("artists", weeks)}
    </div>`;
  }

  function calendarView(weeks) {
    const yearMap = new Map();

    for (const w of weeks) {
      if (!yearMap.has(w.year)) yearMap.set(w.year, {
        year: w.year, weeks: 0, songUnits: 0, albumUnits: 0,
        newSongs: 0, reentries: 0, newAlbums: 0, albumReturns: 0,
        no1Songs: new Set(), no1Albums: new Set()
      });
      const y = yearMap.get(w.year);
      y.weeks++;
      y.newSongs += w.newSongs;
      y.reentries += w.songReentries;
      y.newAlbums += w.newAlbums;
      y.albumReturns += w.albumReentries;
      for (const s of w.songs) {
        y.songUnits += s.units;
        if (s.rank === 1) y.no1Songs.add(s.id);
      }
      for (const a of w.albums) {
        y.albumUnits += a.units;
        if (a.rank === 1) y.no1Albums.add(a.id);
      }
    }

    const rows = searchableRows([...yearMap.values()].map(y => ({
      ...y, yearLabel: String(y.year),
      songNo1Count: y.no1Songs.size, albumNo1Count: y.no1Albums.size
    })));

    return `<div class="panel">${sectionHeading("Year-by-year archive", "Calendar year is assigned by the Friday start date of the chart week. Each week is counted once.")}
      ${tableMarkup(rows, [
        { key: "yearLabel", label: "Year" },
        { key: "weeks", label: "Chart weeks", numeric: true, format: (_, v) => fmt(v) },
        unitsColumn("songUnits", "Song units sold"),
        unitsColumn("albumUnits", "Album units sold"),
        { key: "newSongs", label: "New song entries", numeric: true, format: (_, v) => fmt(v) },
        { key: "reentries", label: "Song re-entries", numeric: true, format: (_, v) => fmt(v) },
        { key: "newAlbums", label: "New albums", numeric: true, format: (_, v) => fmt(v) },
        { key: "songNo1Count", label: "Distinct No. 1 songs", numeric: true, format: (_, v) => fmt(v) },
        { key: "albumNo1Count", label: "Distinct No. 1 albums", numeric: true, format: (_, v) => fmt(v) }
      ])}
    </div>
    <div class="panel">${sectionHeading("Weekly history")}
      ${tableMarkup(searchableRows(weeks.map(w => ({
        date: dateFmt(w.start), year: w.year,
        songLeader: w.songs[0]?.title || "—",
        songArtist: w.songs[0]?.artist || "—",
        songUnits: w.songs[0]?.units || 0,
        albumLeader: w.albums[0]?.title || "—",
        albumArtist: w.albums[0]?.artist || "—",
        albumUnits: w.albums[0]?.units || 0,
        newSongs: w.newSongs, reentries: w.songReentries
      })).reverse()), [
        { key: "date", label: "Chart week" },
        { key: "year", label: "Year", numeric: true },
        { key: "songLeader", label: "No. 1 song" },
        { key: "songArtist", label: "Credited artists" },
        unitsColumn("songUnits", "Song units sold"),
        { key: "albumLeader", label: "No. 1 album" },
        { key: "albumArtist", label: "Lead album artist" },
        unitsColumn("albumUnits", "Album units sold"),
        { key: "newSongs", label: "New songs", numeric: true, format: (_, v) => fmt(v) },
        { key: "reentries", label: "Re-entries", numeric: true, format: (_, v) => fmt(v) }
      ])}
    </div>`;
  }

  function qualityView() {
    const manifest = state.raw.manifest || {};
    const counts = manifest.record_counts || {};
    return `<div class="grid">
      ${metric("Malformed history lines", fmt(state.meta.malformedLines))}
      ${metric("Events missing timestamps", fmt(state.meta.eventsWithoutTimestamp))}
      ${metric("Unresolved event tracks", fmt(state.raw.events.filter(e => !state.raw.tracks.has(String(e.track_id))).length))}
      ${metric("Releases under eligibility minimum", fmt(state.raw.ineligible.length))}
    </div>
    <div class="panel">${sectionHeading("Data-quality issues", "Counts are derived from the source material available to this page.")}
      ${tableMarkup(searchableRows(state.issues), [
        { key: "severity", label: "Severity", format: (_, v) => `<span class="pill ${v === "bad" ? "bad" : "warn"}">${safe(v)}</span>` },
        { key: "type", label: "Issue" },
        { key: "count", label: "Records", numeric: true, format: (_, v) => fmt(v) },
        { key: "description", label: "Meaning" }
      ])}
    </div>
    <div class="panel">${sectionHeading("Vault record reference")}
      ${tableMarkup([
        { type: "Artists", count: counts.artists ?? state.raw.artists.size },
        { type: "Tracks", count: counts.tracks ?? state.raw.tracks.size },
        { type: "All albums", count: counts.all_albums ?? state.raw.albums.size },
        { type: "Eligible albums", count: counts.eligible_albums ?? state.eligibleAlbumIds.size },
        { type: "Ineligible releases", count: counts.ineligible_releases ?? state.raw.ineligible.length },
        { type: "Listening events", count: counts.listening_events ?? state.meta.parsedEvents }
      ], [
        { key: "type", label: "Entity" },
        { key: "count", label: "Records", numeric: true, format: (_, v) => fmt(v) }
      ])}
      <p class="muted small">For complete import acceptance/rejection counts, the importer must persist those counts in an import manifest. The page does not infer raw record counts from canonical counts.</p>
    </div>`;
  }

  function selectedContent(weeks) {
    switch (state.view) {
      case "imports": return importsView();
      case "overview": return overview(weeks);
      case "songs": return `<div class="panel">${sectionHeading("All song records", "Sort by units sold, peak, debut, No. 1 weeks, chart runs or any other available column.")}<div class="toolbar" style="margin:13px 0"><input id="table-search" type="search" placeholder="Search every song or credited artist…"></div>${buildTable("songs", weeks)}</div>`;
      case "albums": return `<div class="panel">${sectionHeading("All album records", "Lead album artist receives the album-level credit.")}<div class="toolbar" style="margin:13px 0"><input id="table-search" type="search" placeholder="Search albums or lead artists…"></div>${buildTable("albums", weeks)}</div>`;
      case "artists": return `<div class="panel">${sectionHeading("All artist records", "Song credit is shared across valid collaborators. Album credit belongs only to each lead album artist.")}<div class="toolbar" style="margin:13px 0"><input id="table-search" type="search" placeholder="Search artists…"></div>${buildTable("artists", weeks)}</div>`;
      case "debuts": return debutsView(weeks);
      case "numberones": return numberOneView(weeks);
      case "records": return recordBook(weeks);
      case "calendar": return calendarView(weeks);
      case "quality": return qualityView();
      default: return overview(weeks);
    }
  }

  function render() {
    const [title, subtitle] = titles[state.view] || titles.imports;
    $("page-title").textContent = title;
    $("page-subtitle").textContent = subtitle;
    document.querySelectorAll(".nav-button").forEach(button =>
      button.classList.toggle("active", button.dataset.view === state.view));

    const weeks = scopedWeeks();
    const first = state.weeks[0], last = state.weeks[state.weeks.length - 1];
    $("coverage-note").textContent = `Archive coverage: ${dateFmt(first?.start)} – ${dateFmt(last?.start)} · ${fmt(state.weeks.length)} reconstructed chart weeks · Current view: ${periodLabel()}`;

    $("status").classList.toggle("hidden", !!state.weeks.length);
    $("content").innerHTML = selectedContent(weeks);

    const search = $("table-search");
    if (search) {
      search.value = state.search;
      search.addEventListener("input", () => {
        state.search = search.value;
        // Re-rendering recreates the input; preserve its position by focusing it.
        render();
        const replacement = $("table-search");
        if (replacement) {
          replacement.focus();
          replacement.setSelectionRange(replacement.value.length, replacement.value.length);
        }
      }, { once: true });
    }

    $("content").querySelectorAll("[data-sort]").forEach(button => {
      button.addEventListener("click", () => {
        const key = button.dataset.sort;
        if (state.sortKey === key) {
          state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          state.sortDirection = ["title", "name", "artist", "debut", "date", "source"].includes(key) ? "asc" : "desc";
        }
        render();
      });
    });
  }

  function setView(view) {
    state.view = view;
    state.search = "";
    state.sortKey = view === "artists" ? "combinedUnits" : "units";
    state.sortDirection = "desc";
    render();
  }

  function exportVisibleTable() {
    const table = $("content").querySelector("table");
    if (!table) {
      $("status").textContent = "There is no table to export in this view.";
      $("status").classList.remove("hidden");
      return;
    }

    const rows = [...table.querySelectorAll("tr")].map(tr =>
      [...tr.querySelectorAll("th,td")].map(cell =>
        cell.innerText.trim().replace(/\s+/g, " ")
      )
    );

    const csv = rows.map(row => row.map(value =>
      `"${value.replace(/"/g, '""')}"`
    ).join(",")).join("\r\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `stats-paradise-${state.view}-${state.period}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function bindControls() {
    $("navigation").addEventListener("click", event => {
      const button = event.target.closest("[data-view]");
      if (button) setView(button.dataset.view);
    });
    $("reload-button").addEventListener("click", async () => {
      try {
        $("status").classList.remove("hidden");
        await loadVault();
      } catch (error) {
        $("status").textContent = error.message;
      }
    });
    $("export-button").addEventListener("click", exportVisibleTable);
    $("period-filter").addEventListener("change", event => {
      state.period = event.target.value;
      state.startDate = "";
      state.endDate = "";
      $("start-date").value = "";
      $("end-date").value = "";
      render();
    });
    $("apply-dates").addEventListener("click", () => {
      state.startDate = $("start-date").value;
      state.endDate = $("end-date").value;
      render();
    });
    $("clear-dates").addEventListener("click", () => {
      state.startDate = "";
      state.endDate = "";
      $("start-date").value = "";
      $("end-date").value = "";
      state.period = "all";
      $("period-filter").value = "all";
      render();
    });
  }

  async function init() {
    bindControls();
    try {
      await loadVault();
    } catch (error) {
      console.error(error);
      $("status").textContent = `Unable to load Stats Paradise: ${error.message}`;
      $("status").classList.remove("hidden");
      $("content").innerHTML = "";
    }
  }

  // Public module interface.
  return { init };
})();

document.addEventListener("DOMContentLoaded", SP.init);
