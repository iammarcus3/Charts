import os
import json
from import_data import ingest_zerocharts_file

# Setup paths
RAW_DIR = "raw/listening_history"
VAULT_DIR = "vault"
REPORTS_DIR = "reports"

os.makedirs(RAW_DIR, exist_ok=True)
os.makedirs(VAULT_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

# Configurable Threshold
MIN_ALBUM_TRACKS = 3

def build():
    all_artists, all_albums, all_tracks = {}, {}, {}
    all_events = []
    
    files = [os.path.join(RAW_DIR, f) for f in os.listdir(RAW_DIR) if f.endswith('.json')]
    
    for file in files:
        print(f"Processing {file}...")
        artists, albums, tracks, events = ingest_zerocharts_file(file)
        
        # Merge dictionaries safely
        all_artists.update(artists)
        all_albums.update(albums)
        all_tracks.update(tracks)
        all_events.extend(events)

    print("Evaluating album eligibility...")
    # 1. Count distinct canonical tracks per release
    album_track_sets = {album_id: set() for album_id in all_albums}
    for track_id, track in all_tracks.items():
        album_id = track.get("album_id")
        if album_id in album_track_sets:
            album_track_sets[album_id].add(track_id)

    # 2. Filter eligible and ineligible albums
    eligible_albums = {}
    ineligible_releases = []
    
    for album_id, album_data in all_albums.items():
        track_count = len(album_track_sets[album_id])
        if track_count >= MIN_ALBUM_TRACKS:
            eligible_albums[album_id] = album_data
        else:
            ineligible_releases.append({
                "id": album_id,
                "title": album_data["title"],
                "primary_artist_id": album_data.get("primary_artist_id"),
                "track_count": track_count,
                "exclusion_reason": f"Fewer than {MIN_ALBUM_TRACKS} distinct tracks"
            })

    print("Writing canonical datasets...")
    
    with open(f"{VAULT_DIR}/artists.json", "w", encoding="utf-8") as f:
        json.dump([all_artists[k] for k in sorted(all_artists.keys())], f, indent=2, ensure_ascii=False)
        
    with open(f"{VAULT_DIR}/albums.json", "w", encoding="utf-8") as f:
        json.dump([eligible_albums[k] for k in sorted(eligible_albums.keys())], f, indent=2, ensure_ascii=False)

    with open(f"{VAULT_DIR}/ineligible_releases.json", "w", encoding="utf-8") as f:
        # Sort by title for determinism
        ineligible_releases.sort(key=lambda x: x["title"])
        json.dump(ineligible_releases, f, indent=2, ensure_ascii=False)
        
    with open(f"{VAULT_DIR}/tracks.json", "w", encoding="utf-8") as f:
        json.dump([all_tracks[k] for k in sorted(all_tracks.keys())], f, indent=2, ensure_ascii=False)

    # JSONL for append-friendly large datasets
    all_events = sorted(all_events, key=lambda x: x['timestamp'])
    with open(f"{VAULT_DIR}/listening_history.jsonl", "w", encoding="utf-8") as f:
        for event in all_events:
            f.write(json.dumps(event) + "\n")

    # Generate Manifest
    manifest = {
        "settings": {
            "MIN_ALBUM_TRACKS": MIN_ALBUM_TRACKS
        },
        "record_counts": {
            "artists": len(all_artists),
            "eligible_albums": len(eligible_albums),
            "ineligible_releases": len(ineligible_releases),
            "tracks": len(all_tracks),
            "listening_events": len(all_events)
        },
        "build_status": "success"
    }
    with open(f"{VAULT_DIR}/manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

if __name__ == "__main__":
    build()
