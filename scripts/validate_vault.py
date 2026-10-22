
import json
from pathlib import Path

VAULT_DIR = Path("vault")

REQUIRED_FILES = [
    "artists.json",
    "albums.json",
    "ineligible_releases.json",
    "tracks.json",
    "listening_history.jsonl",
    "manifest.json",
]

MIN_ALBUM_TRACKS = 3


def load_json(filepath):
    try:
        with filepath.open("r", encoding="utf-8") as file:
            return json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON in {filepath}: line {exc.lineno}, "
            f"column {exc.colno}: {exc.msg}"
        ) from exc


def load_jsonl(filepath):
    records = []

    with filepath.open("r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if not line.strip():
                continue

            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Invalid JSONL in {filepath}, line {line_number}: "
                    f"{exc.msg}"
                ) from exc

    return records


def get_records(data, filename):
    """Accept either a list or a dictionary containing a records list."""
    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for key in ("artists", "albums", "tracks", "releases"):
            if key in data and isinstance(data[key], list):
                return data[key]

    raise ValueError(
        f"Unexpected data structure in {filename}; expected a list "
        "or a dictionary containing its records list."
    )


def validate():
    # 1. Check all required files.
    missing = [
        name for name in REQUIRED_FILES
        if not (VAULT_DIR / name).is_file()
    ]

    if missing:
        raise FileNotFoundError(
            "Validation failed. Missing vault files: "
            + ", ".join(missing)
        )

    # 2. Parse all JSON files.
    artists_data = load_json(VAULT_DIR / "artists.json")
    albums_data = load_json(VAULT_DIR / "albums.json")
    tracks_data = load_json(VAULT_DIR / "tracks.json")
    ineligible_data = load_json(VAULT_DIR / "ineligible_releases.json")
    manifest = load_json(VAULT_DIR / "manifest.json")
    history = load_jsonl(VAULT_DIR / "listening_history.jsonl")

    artists = get_records(artists_data, "artists.json")
    albums = get_records(albums_data, "albums.json")
    tracks = get_records(tracks_data, "tracks.json")

    # 3. Validate the manifest setting.
    settings = manifest.get("settings", {}) if isinstance(manifest, dict) else {}

    if settings.get("MIN_ALBUM_TRACKS") != MIN_ALBUM_TRACKS:
        raise ValueError(
            f"Manifest MIN_ALBUM_TRACKS must be {MIN_ALBUM_TRACKS}."
        )

    # 4. Check record IDs and duplicate IDs.
    def index_records(records, filename):
        indexed = {}

        for record in records:
            if not isinstance(record, dict):
                raise ValueError(
                    f"{filename} contains a record that is not an object."
                )

            record_id = record.get("id")

            if not record_id:
                raise ValueError(f"{filename} contains a record without an ID.")

            if record_id in indexed:
                raise ValueError(
                    f"{filename} contains duplicate ID: {record_id}"
                )

            indexed[record_id] = record

        return indexed

    artist_by_id = index_records(artists, "artists.json")
    album_by_id = index_records(albums, "albums.json")
    track_by_id = index_records(tracks, "tracks.json")

    # 5. Check track-to-album and track-to-artist references.
    for track_id, track in track_by_id.items():
        artist_id = track.get("artist_id")

        if artist_id and artist_id not in artist_by_id:
            raise ValueError(
                f"Track {track_id} references missing artist {artist_id}."
            )

        album_ids = track.get("album_ids", [])

        # Support older records that only have album_id.
        if not album_ids and track.get("album_id"):
            album_ids = [track["album_id"]]

        if not isinstance(album_ids, list):
            raise ValueError(
                f"Track {track_id} has an invalid album_ids field."
            )

        for album_id in album_ids:
            if album_id not in album_by_id:
                raise ValueError(
                    f"Track {track_id} references missing album {album_id}."
                )

    # 6. Check album track references and eligibility.
    for album_id, album in album_by_id.items():
        track_ids = album.get("track_ids", [])

        if not isinstance(track_ids, list):
            raise ValueError(
                f"Album {album_id} has an invalid track_ids field."
            )

        if len(track_ids) != len(set(track_ids)):
            raise ValueError(
                f"Album {album_id} contains duplicate track IDs."
            )

        for track_id in track_ids:
            if track_id not in track_by_id:
                raise ValueError(
                    f"Album {album_id} references missing track {track_id}."
                )

        # Eligibility must count distinct canonical tracks, not plays.
        eligible = len(set(track_ids)) >= MIN_ALBUM_TRACKS

        if "eligible" in album and album["eligible"] != eligible:
            raise ValueError(
                f"Album {album_id} has incorrect eligibility status."
            )

    # 7. Validate listening-history records and track references.
    seen_events = set()

    for line_number, event in enumerate(history, start=1):
        if not isinstance(event, dict):
            raise ValueError(
                f"Listening history line {line_number} is not an object."
            )

        track_id = event.get("track_id")

        if not track_id:
            raise ValueError(
                f"Listening history line {line_number} has no track_id."
            )

        if track_id not in track_by_id:
            raise ValueError(
                f"Listening history line {line_number} references "
                f"missing track {track_id}."
            )

        event_id = event.get("id")

        if event_id:
            if event_id in seen_events:
                raise ValueError(
                    f"Duplicate listening-history event ID: {event_id}"
                )
            seen_events.add(event_id)

    print("Vault validation passed.")
    print(f"Artists: {len(artists)}")
    print(f"Albums: {len(albums)}")
    print(f"Tracks: {len(tracks)}")
    print(f"Listening events: {len(history)}")


if __name__ == "__main__":
    validate()
