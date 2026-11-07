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
const unresolvedChartCredits = [];
for (const track of chartedTracks) {
  const ids = api.getTrackArtistIds(track);
  if (!ids.length || ids.some(id=>api.getArtistName(id)==="Unknown Artist")) {
    unresolvedChartCredits.push({track:track.title||track.name||track.id, raw:track.credited_artist_ids??track.artist_ids??track.primary_artist_id??track.artist_id});
  }
}

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
    unresolvedChartCredits: unresolvedChartCredits.slice(0,50)
  },
  mariah: {
    row: byName("Mariah Carey") ?? null,
    year2026: yearBoard.find(x=>x.id===mariahId) ?? null,
    careerRank: rank([...artists].sort((a,b)=>b.unitsSold-a.unitsSold),mariahId),
    2026Rank: rank(yearBoard,mariahId),
    leadTracksInVault: mariahLeadTracks.length,
    leadAlbumsInVault: mariahLeadAlbums.length,
    chartedLeadTracks: mariahLeadTracks.filter(t=>chartTrackIds.has(String(t.id))).length,
    chartedLeadAlbums: mariahLeadAlbums.filter(a=>state.albumRecords.some(r=>r.id===String(a.id)&&r.weeksOnChart>0)).length
  },
  tyla: {
    row: byName("Tyla") ?? null,
    year2026: yearBoard.find(x=>x.id===tylaId) ?? null,
    careerRank: rank([...artists].sort((a,b)=>b.unitsSold-a.unitsSold),tylaId),
    year2026Rank: rank(yearBoard,tylaId),
    leadTracksInVault: tylaLeadTracks.length,
    leadAlbumsInVault: tylaLeadAlbums.length,
    chartedLeadTracks: tylaLeadTracks.filter(t=>chartTrackIds.has(String(t.id))).length,
    chartedLeadAlbums: tylaLeadAlbums.filter(a=>state.albumRecords.some(r=>r.id===String(a.id)&&r.weeksOnChart>0)).length
  },
  weeknd: {
    row: byName("The Weeknd") ?? null,
    year2026: yearBoard.find(x=>x.id===weekndId) ?? null,
    careerRank: rank([...artists].sort((a,b)=>b.unitsSold-a.unitsSold),weekndId),
    year2026Rank: rank(yearBoard,weekndId)
  },
  top20Career: [...artists].sort((a,b)=>b.unitsSold-a.unitsSold).slice(0,20).map(a=>({name:a.name,units:a.unitsSold,songs:a.songUnitsSold,albums:a.albumUnitsSold,id:a.id})),
  top20Year2026: yearBoard.slice(0,20)
};
fs.writeFileSync("stats-paradise-audit.json", JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
