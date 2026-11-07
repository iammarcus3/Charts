import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync("stats-paradise.js", "utf8");
const marker = '  document.addEventListener("DOMContentLoaded", init);';
if (!source.includes(marker)) throw new Error("Stats Paradise startup marker not found.");

const instrumented = source.replace(marker, `
  globalThis.__statsAudit = {
    state, fetchVaultFiles, buildAlbumTrackMap, buildChartArchive,
    aggregateEntityRecords, buildPeriodUnitsIndex, getTrackArtistIds,
    resolveArtistId, getArtistName, getLeadAlbumArtistId
  };
`);

const stub = { value: "", innerHTML: "", textContent: "", style: {}, dataset: {}, classList: { toggle() {} } };
const context = {
  console, Date, Map, Set, Math, Number, String, Array, Object, JSON, RegExp,
  Error, Promise, Intl,
  document: { querySelector: () => ({ ...stub }), addEventListener() {} },
  fetch: async (url) => {
    const file = path.resolve(String(url));
    const body = fs.readFileSync(file, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
};
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: "stats-paradise.js" });

const api = context.__statsAudit;
await api.fetchVaultFiles();
api.buildAlbumTrackMap();
api.buildChartArchive();
api.aggregateEntityRecords();

const state = api.state;
const artists = state.artistRecords;
const byName = name => artists.find(a => a.name.toLowerCase() === name.toLowerCase());
const mariahId = "2fc8ae64f34795cde74ada7e";
const tylaId = "494d8602729a7b9ee96c0ae6";
const weekndId = "f2ecd660a31b873f0547540a";
const yearIndex = api.buildPeriodUnitsIndex(Date.UTC(2026,0,1), Date.UTC(2026,11,31,23,59,59,999));
const allTimeIndex = api.buildPeriodUnitsIndex(state.earliestWeekStart, state.latestWeekStart);
const yearBoard = [...yearIndex.artistUnits.entries()]
  .map(([id, units]) => ({ id, name: api.getArtistName(id), units: Number(units || 0) }))
  .sort((a,b) => b.units-a.units || a.name.localeCompare(b.name));
const rank = (list,id) => { const i=list.findIndex(x=>x.id===id); return i<0?null:i+1; };

const chartTrackIds = new Set(state.snapshots.flatMap(s=>s.songs.map(e=>String(e.id))));
const chartedTracks = [...chartTrackIds].map(id=>state.tracks.get(id)).filter(Boolean);
const mariahLeadTracks = [...state.tracks.values()].filter(t=>String(t.primary_artist_id ?? t.artist_id ?? "")===mariahId);
const tylaLeadTracks = [...state.tracks.values()].filter(t=>String(t.primary_artist_id ?? t.artist_id ?? "")===tylaId);
const mariahLeadAlbums = [...state.albums.values()].filter(a=>String(a.primary_artist_id ?? a.artist_id ?? "")===mariahId);
const tylaLeadAlbums = [...state.albums.values()].filter(a=>String(a.primary_artist_id ?? a.artist_id ?? "")===tylaId);

const chartArtistIds = new Set(state.snapshots.flatMap(s=>[
  ...s.songs.flatMap(e=>e.artistIds||[]),
  ...s.albums.map(e=>e.leadArtistId).filter(Boolean)
]).map(String));
const missingIds = [...chartArtistIds].filter(id=>!artists.some(a=>a.id===id));
const nullDebutArtistIdsAllTime = new Set();
const nullDebutArtistIds2026 = new Set();
for (const [albumId, activation] of state.albumDebuts) {
  if (activation.unitsSold != null) continue;
  const leadId = api.getLeadAlbumArtistId(state.albums.get(String(albumId)));
  if (!leadId) continue;
  nullDebutArtistIdsAllTime.add(String(leadId));
  if (new Date(activation.weekStart).getUTCFullYear() === 2026) {
    nullDebutArtistIds2026.add(String(leadId));
  }
}
const unresolvedChartCredits = [];
for (const track of chartedTracks) {
  const ids = api.getTrackArtistIds(track);
  if (!ids.length || ids.some(id=>api.getArtistName(id)==="Unknown Artist")) {
    unresolvedChartCredits.push({track:track.title||track.name||track.id, raw:track.credited_artist_ids??track.artist_ids??track.primary_artist_id??track.artist_id});
  }
}

const tylaDirect2026 = { songUnits: 0, albumUnits: 0, songAppearances: 0, albumAppearances: 0, weeks: [] };
for (const snapshot of state.snapshots) {
  if (snapshot.weekStart < Date.UTC(2026,0,1) || snapshot.weekStart > Date.UTC(2026,11,31,23,59,59,999)) continue;
  let weekSongs = 0, weekAlbums = 0;
  for (const entry of snapshot.songs) if ((entry.artistIds || []).map(String).includes(tylaId)) {
    tylaDirect2026.songUnits += Number(entry.unitsSold || 0);
    tylaDirect2026.songAppearances++;
    weekSongs++;
  }
  for (const entry of snapshot.albums) if (String(entry.leadArtistId || "") === tylaId) {
    tylaDirect2026.albumUnits += Number(entry.unitsSold || 0);
    tylaDirect2026.albumAppearances++;
    weekAlbums++;
  }
  if (weekSongs || weekAlbums) tylaDirect2026.weeks.push({week:new Date(snapshot.weekStart).toISOString().slice(0,10),songs:weekSongs,albums:weekAlbums});
}
const tylaNullDebuts2026 = [...state.albumDebuts.entries()].filter(([albumId,a]) =>
  a.weekStart >= Date.UTC(2026,0,1) && a.weekStart <= Date.UTC(2026,11,31,23,59,59,999) &&
  String(api.getLeadAlbumArtistId(state.albums.get(String(albumId))) || "") === tylaId &&
  (a.unitsSold == null || !Number.isFinite(Number(a.unitsSold)))
).map(([albumId,a])=>({albumId,title:state.albums.get(String(albumId))?.title,week:new Date(a.weekStart).toISOString().slice(0,10),unitsSold:a.unitsSold}));
const mariahRelated = artists.filter(a=>a.name.toLowerCase().includes("mariah")).map(a=>({id:a.id,name:a.name,units:a.unitsSold}));
const summary = {
  source: {
    vaultArtists: state.artists.size, tracks: state.tracks.size, albums: state.albums.size,
    listeningEvents: state.events.length, observedWeeks: state.snapshots.length,
    firstWeek: new Date(state.earliestWeekStart).toISOString().slice(0,10),
    latestWeek: new Date(state.latestWeekStart).toISOString().slice(0,10)
  },
  artistArchive: {
    totalRows: artists.length,
    chartReferencedArtistIds: chartArtistIds.size,
    referencedButMissingRows: missingIds.length,
    missingIds,
    unresolvedChartCreditTrackCount: unresolvedChartCredits.length,
    unresolvedChartCredits: unresolvedChartCredits.slice(0,50),
    nullUnitDebutArtistsAffected: {
      allHistoryCount: nullDebutArtistIdsAllTime.size,
      allHistory: [...nullDebutArtistIdsAllTime].map(id=>api.getArtistName(id)).sort(),
      year2026Count: nullDebutArtistIds2026.size,
      year2026: [...nullDebutArtistIds2026].map(id=>api.getArtistName(id)).sort()
    }
  },
  mariah: {
    row: byName("Mariah Carey") ?? null,
    year2026: yearBoard.find(x=>x.id===mariahId) ?? null,
    careerRank: rank([...artists].sort((a,b)=>b.unitsSold-a.unitsSold),mariahId),
    periodUnitsAllTime: Number(allTimeIndex.artistUnits.get(mariahId) ?? 0),
    periodUnits2026: Number(yearIndex.artistUnits.get(mariahId) ?? 0),
    rank2026: rank(yearBoard,mariahId),
    leadTracksInVault: mariahLeadTracks.length,
    leadAlbumsInVault: mariahLeadAlbums.length,
    chartedLeadTracks: mariahLeadTracks.filter(t=>chartTrackIds.has(String(t.id))).length,
    chartedLeadAlbums: mariahLeadAlbums.filter(a=>state.albumRecords.some(r=>r.id===String(a.id)&&r.weeksOnChart>0)).length
  },
  tyla: {
    row: byName("Tyla") ?? null,
    year2026: yearBoard.find(x=>x.id===tylaId) ?? null,
    rawPeriodIndexValue: yearIndex.artistUnits.has(tylaId) ? yearIndex.artistUnits.get(tylaId) : "MISSING",
    direct2026: tylaDirect2026,
    nullDebuts2026: tylaNullDebuts2026,
    careerRank: rank([...artists].sort((a,b)=>b.unitsSold-a.unitsSold),tylaId),
    periodUnitsAllTime: Number(allTimeIndex.artistUnits.get(tylaId) ?? 0),
    periodUnits2026: Number(yearIndex.artistUnits.get(tylaId) ?? 0),
    yearrank2026: rank(yearBoard,tylaId),
    leadTracksInVault: tylaLeadTracks.length,
    leadAlbumsInVault: tylaLeadAlbums.length,
    chartedLeadTracks: tylaLeadTracks.filter(t=>chartTrackIds.has(String(t.id))).length,
    chartedLeadAlbums: tylaLeadAlbums.filter(a=>state.albumRecords.some(r=>r.id===String(a.id)&&r.weeksOnChart>0)).length
  },
  weeknd: {
    row: byName("The Weeknd") ?? null,
    year2026: yearBoard.find(x=>x.id===weekndId) ?? null,
    careerRank: rank([...artists].sort((a,b)=>b.unitsSold-a.unitsSold),weekndId),
    periodUnitsAllTime: Number(allTimeIndex.artistUnits.get(weekndId) ?? 0),
    periodUnits2026: Number(yearIndex.artistUnits.get(weekndId) ?? 0),
    yearrank2026: rank(yearBoard,weekndId)
  },
  mariahRelated,
  top20Career: [...artists].sort((a,b)=>b.unitsSold-a.unitsSold).slice(0,20).map(a=>({name:a.name,units:a.unitsSold,songs:a.songUnitsSold,albums:a.albumUnitsSold,id:a.id})),
  top20Year2026: yearBoard.slice(0,20)
};
if (!byName("Mariah Carey")) throw new Error("Mariah Carey is missing from the production artist archive.");
if (!byName("Tyla")) throw new Error("Tyla is missing from the production artist archive.");
if (!(Number(yearIndex.artistUnits.get(tylaId) ?? 0) > 0)) {
  throw new Error("Tyla has chart activity in 2026 but the production year filter still returns zero units.");
}
if (!(Number(allTimeIndex.artistUnits.get(mariahId) ?? 0) > 0)) {
  throw new Error("Mariah Carey is present in career records but the all-history period filter returns zero units.");
}
if (missingIds.length) throw new Error(`Artist archive is missing ${missingIds.length} chart-referenced artist identities.`);

fs.writeFileSync("stats-paradise-audit.json", JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
