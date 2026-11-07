"""Import ZeroCharts scrobbles into normalized, deterministic records."""
# Artist corrections are mirrored in the raw source by the build workflow.
# Rebuild after reverting the unsafe approved-track merge changes.
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from normalize_metadata import (
    canonical_album_title, canonical_track_title, display_text, featured_artists_in_title,
    generate_deterministic_id, normalize_text, split_featured_artist,
)


ARTIST_ALIASES = {"q": "Q Marsden"}

# Explicitly approved track-family corrections. These are intentionally narrow:
# only the Leon Thomas / Chris Brown MUTT metadata variants are consolidated.
# Other MUTT remixes (including the Freddie Gibbs remix) remain distinct.
MUTT_VARIANT_TITLES = {
    "mutt",
    "mutt cb remix",
    "mutt feat chris brown cb remix",
}
MUTT_SOURCE_ARTISTS = {
    "leon thomas",
    "leon thomas and chris brown",
    "leon thomas chris brown",
    "leon thomas feat chris brown",
}


def _canonical_artist(value: str) -> str:
    """Apply explicitly confirmed artist-name corrections before IDs are generated."""
    return ARTIST_ALIASES.get(normalize_text(value), value)


def _canonical_track_identity(raw_artist: str, raw_track: str) -> tuple[str, str]:
    """Return approved canonical track artist/title without changing album ownership."""
    if (
        normalize_text(raw_artist) in MUTT_SOURCE_ARTISTS
        and normalize_text(raw_track) in MUTT_VARIANT_TITLES
    ):
        return "Leon Thomas & Chris Brown", "MUTT"
    return raw_artist, raw_track


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
        album_artist_name, _ = split_featured_artist(raw_artist)
        raw_album = _first_nonempty(item, ("album", "album_title", "release"), "Unknown Album")
        raw_track = _first_nonempty(item, ("track", "track_name", "title", "name"), "Unknown Track")
        timestamp = item.get("timestamp", item.get("played_at", item.get("date")))

        artist_id = generate_deterministic_id("artist", album_artist_name)
        artist_key = normalize_text(album_artist_name)
        if artist_id not in artists:
            artists[artist_id] = {
                "id": artist_id,
                "name": album_artist_name,
                "normalized_name": artist_key,
                "aliases": [],
            }
        elif album_artist_name != artists[artist_id]["name"] and album_artist_name not in artists[artist_id]["aliases"]:
            artists[artist_id]["aliases"].append(album_artist_name)

        # Remove bracketed/parenthesized album annotations for family matching.
        # Preserve original release names for auditability and bonus-track recovery.
        canonical_album = canonical_album_title(raw_album)
        album_id = generate_deterministic_id("album", album_artist_name, canonical_album)
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

        # Canonical recording identity separates lead artist/title from featured credits.
        # Only explicit feat./ft. annotations are moved into credits; version labels
        # (Remix, Live, Radio Edit, Instrumental, Remaster, etc.) remain in the title.
        track_artist_name, track_title = _canonical_track_identity(raw_artist, raw_track)
        lead_artist_name, artist_featured_names = split_featured_artist(track_artist_name)
        canonical_title = canonical_track_title(track_title, lead_artist_name)
        featured_names = []
        for name in [*artist_featured_names, *featured_artists_in_title(track_title)]:
            if name and normalize_text(name) != normalize_text(lead_artist_name):
                if normalize_text(name) not in {normalize_text(x) for x in featured_names}:
                    featured_names.append(name)

        track_artist_id = generate_deterministic_id("artist", lead_artist_name)
        if track_artist_id not in artists:
            artists[track_artist_id] = {
                "id": track_artist_id,
                "name": lead_artist_name,
                "normalized_name": normalize_text(lead_artist_name),
                "aliases": [],
            }

        credited_artist_ids = [track_artist_id]
        for featured_name in featured_names:
            featured_id = generate_deterministic_id("artist", featured_name)
            if featured_id not in artists:
                artists[featured_id] = {
                    "id": featured_id,
                    "name": featured_name,
                    "normalized_name": normalize_text(featured_name),
                    "aliases": [],
                }
            if featured_id not in credited_artist_ids:
                credited_artist_ids.append(featured_id)

        track_id = generate_deterministic_id("track", lead_artist_name, canonical_title)
        if track_id not in tracks:
            tracks[track_id] = {
                "id": track_id,
                "title": canonical_title,
                "normalized_title": normalize_text(canonical_title),
                "primary_artist_id": track_artist_id,
                "credited_artist_ids": credited_artist_ids,
                "album_id": album_id,  # backward compatibility
                "album_ids": [],
            }
        else:
            track = tracks[track_id]
            if raw_track != track["title"] and raw_track not in track.setdefault("aliases", []):
                track["aliases"].append(raw_track)
            existing_credits = track.setdefault("credited_artist_ids", [track_artist_id])
            for credited_id in credited_artist_ids:
                if credited_id not in existing_credits:
                    existing_credits.append(credited_id)

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


    # Reconcile co-billed artist strings with an independently observed lead-artist
    # recording only when the lead record explicitly credits every additional artist.
    # This avoids guessing that all joint-billed acts are featured-artist variants.
    by_title: dict[str, list[str]] = {}
    for candidate_id, candidate in tracks.items():
        by_title.setdefault(candidate.get("normalized_title", ""), []).append(candidate_id)

    for candidate_id, candidate in list(tracks.items()):
        candidate_artist = artists.get(candidate.get("primary_artist_id"), {}).get("name", "")
        artist_parts = [
            part.strip()
            for part in __import__("re").split(r"\s*(?:,|&)\s*", candidate_artist)
            if part.strip()
        ]
        if len(artist_parts) < 2:
            continue

        lead_name, guest_names = artist_parts[0], artist_parts[1:]
        lead_id = generate_deterministic_id("artist", lead_name)
        guest_ids = [generate_deterministic_id("artist", name) for name in guest_names]
        if not all(guest_id in artists for guest_id in guest_ids):
            continue

        canonical_id = None
        for possible_id in by_title.get(candidate.get("normalized_title", ""), []):
            if possible_id == candidate_id:
                continue
            possible = tracks.get(possible_id)
            if not possible or possible.get("primary_artist_id") != lead_id:
                continue
            explicit_credits = set(possible.get("credited_artist_ids", []))
            if all(guest_id in explicit_credits for guest_id in guest_ids):
                canonical_id = possible_id
                break

        if not canonical_id:
            continue

        canonical = tracks[canonical_id]
        for guest_id in guest_ids:
            if guest_id not in canonical.setdefault("credited_artist_ids", [lead_id]):
                canonical["credited_artist_ids"].append(guest_id)
        for alias in [candidate.get("title"), *candidate.get("aliases", [])]:
            if alias and alias != canonical.get("title") and alias not in canonical.setdefault("aliases", []):
                canonical["aliases"].append(alias)
        for album_id in candidate.get("album_ids", []):
            if album_id not in canonical.setdefault("album_ids", []):
                canonical["album_ids"].append(album_id)
            album = albums.get(album_id)
            if album:
                album["track_ids"] = [
                    canonical_id if track_id == candidate_id else track_id
                    for track_id in album.get("track_ids", [])
                ]
                album["track_ids"] = list(dict.fromkeys(album["track_ids"]))

        for event in events:
            if event.get("track_id") == candidate_id:
                event["track_id"] = canonical_id
                timestamp_value = event.get("timestamp")
                if timestamp_value is not None and str(timestamp_value).strip():
                    event["event_id"] = generate_deterministic_id(
                        "event", canonical_id, str(timestamp_value).strip()
                    )

        del tracks[candidate_id]

    return artists, albums, tracks, events


