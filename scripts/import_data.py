"""Import ZeroCharts scrobbles into normalized, deterministic records."""
# Rebuild after reverting the unsafe approved-track merge changes.
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from normalize_metadata import (
    canonical_album_title, display_text, generate_deterministic_id, normalize_text,
)


ARTIST_ALIASES = {"q": "Q Marsden"}


def _canonical_artist(value: str) -> str:
    """Apply explicitly confirmed artist-name corrections before IDs are generated."""
    return ARTIST_ALIASES.get(normalize_text(value), value)


def _metadata_text(value: Any, fallback: str) -> str:
    """Extract display text from plain values and ZeroCharts/Last.fm metadata objects."""
    if isinstance(value, dict):
        # ZeroCharts exports can encode values as {"#TEXT": "...", "MBID": "..."}.
        for key in ("#text", "#TEXT", "text", "name", "title", "value"):
            candidate = value.get(key)
            if candidate is not None:
                result = _metadata_text(candidate, "")
                if result:
                    return result
        # Some exports wrap the display value inside another metadata object.
        for candidate in value.values():
            if isinstance(candidate, (dict, list)):
                result = _metadata_text(candidate, "")
                if result:
                    return result
        return fallback
    if isinstance(value, list):
        for candidate in value:
            result = _metadata_text(candidate, "")
            if result:
                return result
        return fallback
    if value is None or isinstance(value, (dict, list)):
        return fallback
    return display_text(value, fallback)


def _first_nonempty(item: dict[str, Any], keys: tuple[str, ...], fallback: str) -> str:
    for key in keys:
        value = _metadata_text(item.get(key), "")
        if value:
            return value
    return fallback


def ingest_zerocharts_file(filepath: str | Path):
    """Return artists, albums, tracks, events dictionaries/lists.

    Canonical track identity is normalized primary artist + title. Album membership
    is many-to-many via track['album_ids']; track['album_id'] remains as a backwards-
    compatible first-album field for existing consumers.
    """
    filepath = Path(filepath)
    with filepath.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    if isinstance(data, list):
        scrobbles = data
    elif isinstance(data, dict):
        scrobbles = data.get("scrobbles", [])
    else:
        raise ValueError(f"Unsupported JSON structure in {filepath}: expected object or list")
    if not isinstance(scrobbles, list):
        raise ValueError(f"'scrobbles' must be a list in {filepath}")

    artists: dict[str, dict[str, Any]] = {}
    albums: dict[str, dict[str, Any]] = {}
    tracks: dict[str, dict[str, Any]] = {}
    events: list[dict[str, Any]] = []

    for index, item in enumerate(scrobbles):
        if not isinstance(item, dict):
            continue
        raw_artist = _canonical_artist(_first_nonempty(item, ("artist", "artist_name", "album_artist"), "Unknown Artist"))
        raw_album = _first_nonempty(item, ("album", "album_title", "release"), "Unknown Album")
        raw_track = _first_nonempty(item, ("track", "track_name", "title", "name"), "Unknown Track")
        timestamp = item.get("timestamp", item.get("played_at", item.get("date")))

        artist_id = generate_deterministic_id("artist", raw_artist)
        artist_key = normalize_text(raw_artist)
        if artist_id not in artists:
            artists[artist_id] = {
                "id": artist_id,
                "name": raw_artist,
                "normalized_name": artist_key,
                "aliases": [],
            }
        elif raw_artist != artists[artist_id]["name"] and raw_artist not in artists[artist_id]["aliases"]:
            artists[artist_id]["aliases"].append(raw_artist)

        # Remove bracketed/parenthesized album annotations for family matching.
        # Preserve original release names for auditability and bonus-track recovery.
        canonical_album = canonical_album_title(raw_album)
        album_id = generate_deterministic_id("album", raw_artist, canonical_album)
        if album_id not in albums:
            albums[album_id] = {
                "id": album_id,
                "title": canonical_album,
                "normalized_title": normalize_text(canonical_album),
                "primary_artist_id": artist_id,
                "track_ids": [],
                "source_titles": [],
                "edition_labels": [],
                "canonicalization_rule": "bracketed_album_family",
            }
        album = albums[album_id]
        if raw_album not in album["source_titles"]:
            album["source_titles"].append(raw_album)
        if raw_album != canonical_album and raw_album not in album["edition_labels"]:
            album["edition_labels"].append(raw_album)

        track_id = generate_deterministic_id("track", raw_artist, raw_track)
        if track_id not in tracks:
            tracks[track_id] = {
                "id": track_id,
                "title": raw_track,
                "normalized_title": normalize_text(raw_track),
                "primary_artist_id": artist_id,
                "album_id": album_id,  # backward compatibility
                "album_ids": [],
            }
        else:
            track = tracks[track_id]
            if raw_track != track["title"] and raw_track not in track.setdefault("aliases", []):
                track["aliases"].append(raw_track)

        track = tracks[track_id]
        if album_id not in track["album_ids"]:
            track["album_ids"].append(album_id)
        if track_id not in albums[album_id]["track_ids"]:
            albums[album_id]["track_ids"].append(track_id)

        # Keep events with missing timestamps, but give them a source/index identity so
        # they cannot accidentally collapse into one another.
        if timestamp is None or not str(timestamp).strip():
            event_id = generate_deterministic_id("event_missing_timestamp", track_id, filepath.name, index)
        else:
            event_id = generate_deterministic_id("event", track_id, str(timestamp).strip())
        events.append({
            "event_id": event_id,
            "timestamp": timestamp,
            "track_id": track_id,
            # Preserve the release attached to this specific scrobble. A track can
            # appear on multiple releases, but one play must not count for every one.
            "album_id": album_id,
            "source_provenance": filepath.name,
        })

    return artists, albums, tracks, events


