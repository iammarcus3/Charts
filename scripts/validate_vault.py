
"""Validate the generated Music Vault and its canonical relationships."""

from __future__ import annotations

import json
from pathlib import Path

VAULT_DIR = Path("vault")
MIN_ALBUM_TRACKS = 3

REQUIRED_FILES = [
    "artists.json",
    "albums.json",
    "ineligible_releases.json",
    "tracks.json",
    "listening_history.jsonl",
    "manifest.json",
]


def load_json(path: Path):
    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON in {path}: line {exc.lineno}, "
            f"column {exc.colno}: {exc.msg}"
        ) from exc


def load_jsonl(path: Path):
    records = []

    with path.open("r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if not line.strip():
                continue

            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Invalid JSONL in {path}, line {line_number}: {exc.msg}"
                ) from exc

    return records


def index_records(records, filename):
    if not isinstance(records, list):
        raise ValueError(f"{filename} must contain a JSON array.")

    indexed = {}

    for record in records:
        if not isinstance(record, dict):
            raise ValueError(f"{filename} contains a non-object record.")

        record_id = record.get("id")

        if not record_id:
            raise ValueError(f"{filename} contains a record without an id.")

        if record_id in indexed:
            raise ValueError(
                f"{filename} contains duplicate ID: {record_id}"
            )

        indexed[record_id] = record

    return indexed


def validate():
    missing = [
        name for name in REQUIRED_FILES
        if not (VAULT_DIR / name).is_file()
    ]

    if missing:
        raise FileNotFoundError(
            "Validation failed. Missing vault files: "
            + ", ".join(missing)
        )

    artists_data = load_json(VAULT_DIR / "artists.json")
    albums_data = load_json(VAULT_DIR / "albums.json")
    ineligible_data = load_json(VAULT_DIR / "ineligible_releases.json")
    tracks_data = load_json(VAULT_DIR / "tracks.json")
    manifest = load_json(VAULT_DIR / "manifest.json")
    history = load_jsonl(VAULT_DIR / "listening_history.jsonl")

    artists = index_records(artists_data, "artists.json")
    albums = index_records(albums_data, "albums.json")
    ineligible = index_records(ineligible_data, "ineligible_releases.json")
    tracks = index_records(tracks_data, "tracks.json")

    # Eligible and ineligible releases are both real releases.
    overlapping_album_ids = set(albums) & set(ineligible)

    if overlapping_album_ids:
        raise ValueError(
            "Release IDs appear in both albums.json and "
            f"ineligible_releases.json: {sorted(overlapping_album_ids)[:10]}"
        )

    all_release_ids = set(albums) | set(ineligible)

    # Validate manifest settings.
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json must contain a JSON object.")

    settings = manifest.get("settings", {})

    if settings.get("MIN_ALBUM_TRACKS") != MIN_ALBUM_TRACKS:
        raise ValueError(
            f"Manifest MIN_ALBUM_TRACKS must be {MIN_ALBUM_TRACKS}."
        )

    # Check every track and its artist/release references.
    for track_id, track in tracks.items():
        artist_id = track.get("primary_artist_id")

        if artist_id not in artists:
            raise ValueError(
                f"Track {track_id} references missing artist {artist_id}."
            )

        album_ids = track.get("album_ids", [])

        if not isinstance(album_ids, list):
            raise ValueError(
                f"Track {track_id} has an invalid album_ids field."
            )

        if len(album_ids) != len(set(album_ids)):
            raise ValueError(
                f"Track {track_id} contains duplicate album IDs."
            )

        for album_id in album_ids:
            if album_id not in all_release_ids:
                raise ValueError(
                    f"Track {track_id} references missing release {album_id}. "
                    "The release is absent from both albums.json and "
                    "ineligible_releases.json."
                )

        # Backwards-compatible album_id must also be valid.
        legacy_album_id = track.get("album_id")

        if legacy_album_id is not None:
            if legacy_album_id not in all_release_ids:
                raise ValueError(
                    f"Track {track_id} has a dangling album_id "
                    f"{legacy_album_id}."
                )

            if album_ids and legacy_album_id not in album_ids:
                raise ValueError(
                    f"Track {track_id}: album_id is not included in album_ids."
                )

    # Validate eligible albums and reverse track associations.
    for album_id, album in albums.items():
        track_ids = album.get("track_ids", [])

        if not isinstance(track_ids, list):
            raise ValueError(
                f"Album {album_id} has an invalid track_ids field."
            )

        if len(track_ids) != len(set(track_ids)):
            raise ValueError(
                f"Album {album_id} contains duplicate track IDs."
            )

        if len(track_ids) < MIN_ALBUM_TRACKS:
            raise ValueError(
                f"Album {album_id} is listed as eligible but has only "
                f"{len(track_ids)} distinct tracks."
            )

        artist_id = album.get("primary_artist_id")

        if artist_id and artist_id not in artists:
            raise ValueError(
                f"Album {album_id} references missing artist {artist_id}."
            )

        for track_id in track_ids:
            if track_id not in tracks:
                raise ValueError(
                    f"Album {album_id} references missing track {track_id}."
                )

            track_album_ids = tracks[track_id].get("album_ids", [])

            if album_id not in track_album_ids:
                raise ValueError(
                    f"Relationship mismatch: album {album_id} lists track "
                    f"{track_id}, but the track does not list that album."
                )

    # Validate ineligible releases and their reverse relationships.
    for album_id, album in ineligible.items():
        track_ids = album.get("track_ids", [])

        if not isinstance(track_ids, list):
            raise ValueError(
                f"Ineligible release {album_id} has invalid track_ids."
            )

        if len(track_ids) != len(set(track_ids)):
            raise ValueError(
                f"Ineligible release {album_id} contains duplicate track IDs."
            )

        actual_count = len(track_ids)

        if album.get("track_count") != actual_count:
            raise ValueError(
                f"Ineligible release {album_id} has incorrect track_count."
            )

        if actual_count >= MIN_ALBUM_TRACKS:
            raise ValueError(
                f"Release {album_id} is marked ineligible despite having "
                f"{actual_count} distinct tracks."
            )

        for track_id in track_ids:
            if track_id not in tracks:
                raise ValueError(
                    f"Ineligible release {album_id} references missing "
                    f"track {track_id}."
                )

            track_album_ids = tracks[track_id].get("album_ids", [])

            if album_id not in track_album_ids:
                raise ValueError(
                    f"Relationship mismatch: ineligible release {album_id} "
                    f"lists track {track_id}, but the track does not list "
                    "that release."
                )

    # Every track-to-release link must also exist on the release record.
    for track_id, track in tracks.items():
        album_ids = track.get("album_ids", [])

        for album_id in album_ids:
            release = albums.get(album_id) or ineligible.get(album_id)

            if release is None:
                raise ValueError(
                    f"Track {track_id} references unknown release {album_id}."
                )

            if track_id not in release.get("track_ids", []):
                raise ValueError(
                    f"Relationship mismatch: track {track_id} lists release "
                    f"{album_id}, but the release does not list that track."
                )

    # Check listening history against canonical tracks and event IDs.
    seen_event_ids = set()

    for line_number, event in enumerate(history, start=1):
        if not isinstance(event, dict):
            raise ValueError(
                f"Listening history line {line_number} is not an object."
            )

        track_id = event.get("track_id")

        if track_id not in tracks:
            raise ValueError(
                f"Listening history line {line_number} references missing "
                f"track {track_id}."
            )

        event_id = event.get("event_id")

        if event_id:
            if event_id in seen_event_ids:
                raise ValueError(
                    f"Duplicate listening event ID: {event_id}"
                )
            seen_event_ids.add(event_id)

    # Check manifest counts when supplied.
    counts = manifest.get("record_counts", {})

    expected_counts = {
        "artists": len(artists),
        "eligible_albums": len(albums),
        "ineligible_releases": len(ineligible),
        "tracks": len(tracks),
        "listening_events": len(history),
    }

    for key, actual in expected_counts.items():
        if key in counts and counts[key] != actual:
            raise ValueError(
                f"Manifest count mismatch for {key}: "
                f"manifest={counts[key]}, actual={actual}."
            )

    if manifest.get("build_status") != "success":
        raise ValueError("Manifest build_status is not 'success'.")

    print("Vault validation passed.")
    print(f"Artists: {len(artists)}")
    print(f"Eligible albums: {len(albums)}")
    print(f"Ineligible releases: {len(ineligible)}")
    print(f"Tracks: {len(tracks)}")
    print(f"Listening events: {len(history)}")


if __name__ == "__main__":
    validate()
