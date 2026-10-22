import os
import json
from import_data import ingest_zerocharts_file

# Setup paths
RAW_DIR = "raw/listening_history"
VAULT_DIR = "vault"
REPORTS_DIR = "reports"

os.makedirs(VAULT_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

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

    # Sort deterministically to avoid unnecessary Git diffs
    print("Writing canonical datasets...")
    
    with open(f"{VAULT_DIR}/artists.json", "w", encoding="utf-8") as f:
        json.dump([all_artists[k] for k in sorted(all_artists.keys())], f, indent=2, ensure_ascii=False)
        
    with open(f"{VAULT_DIR}/albums.json", "w", encoding="utf-8") as f:
        json.dump([all_albums[k] for k in sorted(all_albums.keys())], f, indent=2, ensure_ascii=False)
        
    with open(f"{VAULT_DIR}/tracks.json", "w", encoding="utf-8") as f:
        json.dump([all_tracks[k] for k in sorted(all_tracks.keys())], f, indent=2, ensure_ascii=False)

    # JSONL for append-friendly large datasets (Listening History)
    all_events = sorted(all_events, key=lambda x: x['timestamp'])
    with open(f"{VAULT_DIR}/listening_history.jsonl", "w", encoding="utf-8") as f:
        for event in all_events:
            f.write(json.dumps(event) + "\n")

    # Generate Manifest
    manifest = {
        "record_counts": {
            "artists": len(all_artists),
            "albums": len(all_albums),
            "tracks": len(all_tracks),
            "listening_events": len(all_events)
        }
    }
    with open(f"{VAULT_DIR}/manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)

if __name__ == "__main__":
    build()
