
"""Import ZeroCharts scrobbles into normalized records."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from normalize_metadata import (
    display_text,
    generate_deterministic_id,
    normalize_text,
)


def _first_nonempty(
    item: dict[str, Any],
    keys: tuple[str, ...],
    fallback: str,
) -> str:
    for key in keys:
        value = item.get(key)

        if value is not None and str(value).strip():
            return display_text(value, fallback)

    return fallback


def ingest_zerocharts_file(filepath: str | Path):
    """
    Import one ZeroCharts file.

    Tracks are identified by normalized primary artist and title.
    A track may belong to multiple albums. The album_id field is
    retained for backward compatibility; album_ids stores all links.
    """
    filepath = Path(filepath)

    with filepath.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    if isinstance(data, list):
        scrobbles = data
    elif isinstance(data, dict):
        scrobbles = data.get("scrobbles", [])
    else:
        raise ValueError(
            f"Unsupported JSON structure in {filepath}"
        )

    if not isinstance(scrobbles, list):
        raise ValueError(
            f"'scrobbles' must be a list in {filepath}"
        )

    artists: dict[str, dict[str, Any]] = {}
    albums: dict[str, dict[str, Any]] = {}
    tracks: dict[str, dict[str, Any]] = {}
    events: list[dict[str, Any]] = []

    for index, item in enumerate(scrobbles):
        if not isinstance(item, dict):
            continue

        raw_artist = _first_nonempty(
            item,
            ("artist", "artist_name", "album_artist"),
            "Unknown Artist",
        )
        raw_album = _first_nonempty(
            item,
            ("album", "album_title", "release"),
            "Unknown Album",
        )
        raw_track = _first_nonempty(
            item,
            ("track", "track_name", "title"),
            "Unknown Track",
        )

        timestamp = item.get(
            "timestamp",
            item.get("played_at", item.get("date")),
        )

        # Artist
        artist_id = generate_deterministic_id(
            "artist", raw_artist
        )

        if artist_id not in artists:
            artists[artist_id] = {
                "id": artist_id,
                "name": raw_artist,
                "normalized_name": normalize_text(raw_artist),
                "aliases": [],
            }

        artist = artists[artist_id]

        if (
            raw_artist != artist["name"]
            and raw_artist not in artist["aliases"]
        ):
            artist["aliases"].append(raw_artist)

        # Album / release
        album_id = generate_deterministic_id(
            "album", raw_artist, raw_album
        )

        if album_id not in albums:
            albums[album_id] = {
                "id": album_id,
                "title": raw_album,
                "normalized_title": normalize_text(raw_album),
                "primary_artist_id": artist_id,
                "track_ids": [],
            }

        # Track
        track_id = generate_deterministic_id(
            "track", raw_artist, raw_track
        )

        if track_id not in tracks:
            tracks[track_id] = {
                "id": track_id,
                "title": raw_track,
                "normalized_title": normalize_text(raw_track),
                "primary_artist_id": artist_id,
                "album_id": album_id,
                "album_ids": [],
                "aliases": [],
            }

        track = tracks[track_id]

        if (
            raw_track != track["title"]
            and raw_track not in track["aliases"]
        ):
            track["aliases"].append(raw_track)

        # Keep track-to-album relationships in both directions.
        if album_id not in track["album_ids"]:
            track["album_ids"].append(album_id)

        if track_id not in albums[album_id]["track_ids"]:
            albums[album_id]["track_ids"].append(track_id)

        # Listening event
        # Missing timestamps get unique IDs so they aren't
        # accidentally collapsed into a single event.
        if timestamp is None or not str(timestamp).strip():
            event_id = generate_deterministic_id(
                "event_missing_timestamp",
                track_id,
                filepath.name,
                index,
            )
        else:
            event_id = generate_deterministic_id(
                "event",
                track_id,
                str(timestamp).strip(),
            )

        events.append({
            "event_id": event_id,
            "timestamp": timestamp,
            "track_id": track_id,
            "source_provenance": filepath.name,
        })

    return artists, albums, tracks, events
