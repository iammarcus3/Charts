import json
import glob
from pathlib import Path
from normalize_metadata import generate_deterministic_id

def ingest_zerocharts_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Matches the exact structure of your provided zerocharts export
    scrobbles = data.get('scrobbles', [])
    
    artists = {}
    albums = {}
    tracks = {}
    events = []

    for item in scrobbles:
        raw_artist = item.get('artist', 'Unknown Artist')
        raw_album = item.get('album', 'Unknown Album')
        raw_track = item.get('track', 'Unknown Track')
        timestamp = item.get('timestamp')

        # 1. Process Artist
        artist_id = generate_deterministic_id("artist", raw_artist)
        if artist_id not in artists:
            artists[artist_id] = {
                "id": artist_id,
                "name": raw_artist,
                "aliases": []
            }

        # 2. Process Album (ensuring primary artist credit only)
        album_id = generate_deterministic_id("album", raw_artist, raw_album)
        if album_id not in albums:
            albums[album_id] = {
                "id": album_id,
                "title": raw_album,
                "primary_artist_id": artist_id
            }

        # 3. Process Track
        track_id = generate_deterministic_id("track", raw_artist, raw_track)
        if track_id not in tracks:
            tracks[track_id] = {
                "id": track_id,
                "title": raw_track,
                "primary_artist_id": artist_id,
                "album_id": album_id
            }

        # 4. Process Listening Event
        event_id = generate_deterministic_id("event", track_id, timestamp)
        events.append({
            "event_id": event_id,
            "timestamp": timestamp,
            "track_id": track_id,
            "source_provenance": Path(filepath).name
        })

    return artists, albums, tracks, events
