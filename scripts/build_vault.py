
"""Build a normalized Music Vault from raw listening-history exports.

Exact normalized identities are canonicalized.
Fuzzy title matches are reported for review, never automatically merged.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from import_data import ingest_zerocharts_file

RAW_DIR = Path("raw/listening_history")
VAULT_DIR = Path("vault")
REPORTS_DIR = Path("reports")

MIN_ALBUM_TRACKS = 3
FUZZY_REVIEW_THRESHOLD = 0.80


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as file:
            json.dump(data, file, indent=2, ensure_ascii=False)
            file.write("\n")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def atomic_write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )

    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as file:
            for record in records:
                file.write(
                    json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n"
                )
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def deduplicate_events(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    """Remove exact duplicate plays by canonical track and nonempty timestamp."""
    result = []
    seen = set()
    removed = 0

    for event in events:
        timestamp = event.get("timestamp")
        track_id = event.get("track_id")

        if timestamp is None or not str(timestamp).strip():
            result.append(event)
            continue

        key = (str(track_id), str(timestamp).strip())

        if key in seen:
            removed += 1
            continue

        seen.add(key)
        result.append(event)

    result.sort(
        key=lambda event: (
            str(event.get("timestamp") or ""),
            str(event.get("event_id") or ""),
        )
    )

    return result, removed


def fuzzy_track_candidates(
    tracks: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Create review-only suggestions for similar titles by the same artist."""
    by_artist = defaultdict(list)

    for track in tracks.values():
        by_artist[str(track.get("primary_artist_id", ""))].append(track)

    candidates = []
    version_terms = {
        "live", "remix", "remaster", "acoustic", "instrumental",
        "karaoke", "edit", "version", "demo", "slowed", "sped",
    }

    for artist_id, artist_tracks in by_artist.items():
        artist_tracks.sort(
            key=lambda track: (
                str(track.get("normalized_title", "")),
                str(track["id"]),
            )
        )

        for index, left in enumerate(artist_tracks):
            left_title = str(left.get("normalized_title", ""))

            if len(left_title) < 5:
                continue

            for right in artist_tracks[index + 1:]:
                right_title = str(right.get("normalized_title", ""))

                if len(right_title) < 5 or left_title == right_title:
                    continue

                score = SequenceMatcher(
                    None, left_title, right_title
                ).ratio()

                if score < FUZZY_REVIEW_THRESHOLD:
                    continue

                candidates.append({
                    "entity_type": "track",
                    "artist_id": artist_id,
                    "track_a_id": left["id"],
                    "track_a_title": left["title"],
                    "track_b_id": right["id"],
                    "track_b_title": right["title"],
                    "similarity": round(score, 4),
                    "version_wording_differs": (
                        bool(set(left_title.split()) & version_terms)
                        != bool(set(right_title.split()) & version_terms)
                    ),
                    "action": "review_only_not_merged",
                })

    candidates.sort(
        key=lambda item: (
            -item["similarity"],
            item["track_a_title"].casefold(),
            item["track_b_title"].casefold(),
        )
    )

    return candidates


def merge_aliases(existing: dict, incoming: dict, field: str) -> None:
    aliases = existing.setdefault("aliases", [])

    for value in [incoming.get(field), *incoming.get("aliases", [])]:
        if value and value != existing.get(field) and value not in aliases:
            aliases.append(value)


def build() -> dict[str, Any]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    raw_files = sorted(
        path for path in RAW_DIR.glob("*.json") if path.is_file()
    )

    artists = {}
    albums = {}
    tracks = {}
    events = []
    input_errors = []

    # Import and merge canonical entities from all source files.
    for path in raw_files:
        print(f"Processing {path}...")

        try:
            file_artists, file_albums, file_tracks, file_events = (
                ingest_zerocharts_file(path)
            )
        except Exception as exc:
            input_errors.append({
                "file": str(path),
                "error": f"{type(exc).__name__}: {exc}",
            })
            continue

        for entity_id, artist in file_artists.items():
            if entity_id not in artists:
                artists[entity_id] = artist
            else:
                merge_aliases(artists[entity_id], artist, "name")

        for entity_id, album in file_albums.items():
            if entity_id not in albums:
                albums[entity_id] = album
            else:
                existing = albums[entity_id]
                for track_id in album.get("track_ids", []):
                    if track_id not in existing.setdefault("track_ids", []):
                        existing["track_ids"].append(track_id)

        for entity_id, track in file_tracks.items():
            if entity_id not in tracks:
                tracks[entity_id] = track
            else:
                existing = tracks[entity_id]

                for album_id in track.get("album_ids", []):
                    if album_id not in existing.setdefault("album_ids", []):
                        existing["album_ids"].append(album_id)

                merge_aliases(existing, track, "title")

        events.extend(file_events)

    # Rebuild relationships in both directions using the final canonical IDs.
    # Album membership is many-to-many: one track can belong to several releases.
    integrity_issues = []

    for album in albums.values():
        album["track_ids"] = list(dict.fromkeys(album.get("track_ids", [])))

    for track in tracks.values():
        track_id = track["id"]
        album_ids = list(track.get("album_ids", []))

        # Support older records that contain album_id but not album_ids.
        legacy_album_id = track.get("album_id")
        if legacy_album_id and legacy_album_id not in album_ids:
            album_ids.append(legacy_album_id)

        # Also preserve associations already recorded on album records.
        for album_id, album in albums.items():
            if track_id in album.get("track_ids", []) and album_id not in album_ids:
                album_ids.append(album_id)

        album_ids = sorted(set(album_ids))

        for album_id in album_ids:
            if album_id not in albums:
                integrity_issues.append({
                    "type": "missing_track_album",
                    "track_id": track_id,
                    "album_id": album_id,
                })
            else:
                if track_id not in albums[album_id]["track_ids"]:
                    albums[album_id]["track_ids"].append(track_id)

        artist_id = track.get("primary_artist_id")
        if artist_id not in artists:
            integrity_issues.append({
                "type": "missing_track_artist",
                "track_id": track_id,
                "artist_id": artist_id,
            })

        track["album_ids"] = album_ids

        if album_ids:
            # Keep the compatibility field only when it points to a real album.
            track["album_id"] = album_ids[0]
        else:
            track.pop("album_id", None)

    for album in albums.values():
        album["track_ids"] = sorted(set(album.get("track_ids", [])))

        artist_id = album.get("primary_artist_id")
        if artist_id and artist_id not in artists:
            integrity_issues.append({
                "type": "missing_album_artist",
                "album_id": album["id"],
                "artist_id": artist_id,
            })

        for track_id in album["track_ids"]:
            if track_id not in tracks:
                integrity_issues.append({
                    "type": "missing_album_track",
                    "album_id": album["id"],
                    "track_id": track_id,
                })

    # Deduplicate exact timestamped plays and check event references.
    events, duplicate_event_count = deduplicate_events(events)

    invalid_events = []
    valid_events = []

    seen_event_ids = set()

    for event in events:
        track_id = event.get("track_id")
        event_id = event.get("event_id")

        if track_id not in tracks:
            invalid_events.append({
                **event,
                "validation_error": "track_id_not_found",
            })
            continue

        if event_id and event_id in seen_event_ids:
            invalid_events.append({
                **event,
                "validation_error": "duplicate_event_id",
            })
            continue

        if event_id:
            seen_event_ids.add(event_id)

        valid_events.append(event)

    events = valid_events

    # Album eligibility is based on distinct canonical tracks, never play counts.
    eligible_albums = {}
    ineligible_releases = []

    for album_id, album in albums.items():
        distinct_track_ids = sorted({
            track_id
            for track_id in album.get("track_ids", [])
            if track_id in tracks
        })

        album["track_ids"] = distinct_track_ids
        track_count = len(distinct_track_ids)

        if track_count >= MIN_ALBUM_TRACKS:
            eligible_albums[album_id] = album
        else:
            ineligible_releases.append({
                "id": album_id,
                "title": album.get("title", "Unknown Album"),
                "primary_artist_id": album.get("primary_artist_id"),
                "track_count": track_count,
                "track_ids": distinct_track_ids,
                "exclusion_reason": (
                    f"Fewer than {MIN_ALBUM_TRACKS} distinct canonical tracks"
                ),
            })

    ineligible_releases.sort(
        key=lambda release: (
            str(release["title"]).casefold(),
            release["id"],
        )
    )

    fuzzy_candidates = fuzzy_track_candidates(tracks)

    validation = {
        "status": (
            "failed"
            if input_errors or integrity_issues or invalid_events
            else "success"
        ),
        "raw_files_found": len(raw_files),
        "raw_files_failed": len(input_errors),
        "integrity_issue_count": len(integrity_issues),
        "invalid_event_count": len(invalid_events),
        "duplicate_events_removed": duplicate_event_count,
        "fuzzy_candidates_for_review": len(fuzzy_candidates),
        "notes": [
            "Exact normalized identities are canonicalized automatically.",
            "Fuzzy matches are review-only and are not automatically merged.",
            "Track album_ids may reference eligible or ineligible releases.",
            "Album eligibility requires at least three distinct canonical tracks.",
        ],
    }

    # Reports are written even when validation fails, to explain the failure.
    atomic_write_json(REPORTS_DIR / "input_errors.json", input_errors)
    atomic_write_json(REPORTS_DIR / "integrity_issues.json", integrity_issues)
    atomic_write_json(REPORTS_DIR / "invalid_events.json", invalid_events)
    atomic_write_json(REPORTS_DIR / "duplicate_candidates.json", fuzzy_candidates)
    atomic_write_json(REPORTS_DIR / "validation_report.json", validation)

    # Never replace the previous vault if source integrity checks fail.
    if validation["status"] != "success":
        raise RuntimeError(
            "Vault build validation failed. Existing vault files were not "
            "replaced. Check reports/integrity_issues.json, "
            "reports/invalid_events.json and reports/input_errors.json."
        )

    artists_out = [artists[key] for key in sorted(artists)]
    albums_out = [eligible_albums[key] for key in sorted(eligible_albums)]
    tracks_out = [tracks[key] for key in sorted(tracks)]

    manifest = {
        "settings": {
            "MIN_ALBUM_TRACKS": MIN_ALBUM_TRACKS,
            "FUZZY_REVIEW_THRESHOLD": FUZZY_REVIEW_THRESHOLD,
        },
        "record_counts": {
            "artists": len(artists_out),
            "eligible_albums": len(albums_out),
            "ineligible_releases": len(ineligible_releases),
            "all_albums": len(albums),
            "tracks": len(tracks_out),
            "listening_events": len(events),
            "fuzzy_candidates_for_review": len(fuzzy_candidates),
        },
        "deduplication": {
            "duplicate_events_removed": duplicate_event_count,
            "method": "exact canonical track_id + exact non-empty timestamp",
            "fuzzy_metadata_matches_auto_merged": 0,
        },
        "build_status": "success",
    }

    atomic_write_json(VAULT_DIR / "artists.json", artists_out)
    atomic_write_json(VAULT_DIR / "albums.json", albums_out)
    atomic_write_json(VAULT_DIR / "ineligible_releases.json", ineligible_releases)
    atomic_write_json(VAULT_DIR / "tracks.json", tracks_out)
    atomic_write_jsonl(VAULT_DIR / "listening_history.jsonl", events)
    atomic_write_json(VAULT_DIR / "manifest.json", manifest)

    print(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    build()
