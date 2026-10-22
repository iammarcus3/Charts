
"""Build a normalized Music Vault from raw listening-history JSON files."""
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


def _atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON through a temporary file to avoid partial files."""
    path.parent.mkdir(parents=True, exist_ok=True)

    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )

    try:
        with os.fdopen(
            fd, "w", encoding="utf-8", newline="\n"
        ) as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")

        os.replace(temp_name, path)

    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _atomic_write_jsonl(
    path: Path,
    records: list[dict[str, Any]],
) -> None:
    """Write JSON Lines through a temporary file."""
    path.parent.mkdir(parents=True, exist_ok=True)

    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )

    try:
        with os.fdopen(
            fd, "w", encoding="utf-8", newline="\n"
        ) as handle:
            for record in records:
                handle.write(
                    json.dumps(
                        record,
                        ensure_ascii=False,
                        sort_keys=True,
                    ) + "\n"
                )

        os.replace(temp_name, path)

    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _deduplicate_events(
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    """
    Remove events with the same canonical track and exact non-empty
    timestamp. Events without timestamps are preserved.
    """
    output = []
    seen: set[tuple[str, str]] = set()
    removed = 0

    for event in events:
        timestamp = event.get("timestamp")
        track_id = event.get("track_id")

        if timestamp is None or not str(timestamp).strip():
            output.append(event)
            continue

        key = (str(track_id), str(timestamp).strip())

        if key in seen:
            removed += 1
            continue

        seen.add(key)
        output.append(event)

    output.sort(
        key=lambda event: (
            str(event.get("timestamp") or ""),
            str(event.get("event_id") or ""),
        )
    )

    return output, removed


def _fuzzy_track_candidates(
    tracks: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Report similar titles by the same canonical artist.
    Similarity is for review only and never triggers an automatic merge.
    """
    by_artist: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for track in tracks.values():
        artist_id = str(track.get("primary_artist_id", ""))
        by_artist[artist_id].append(track)

    candidates = []

    version_terms = {
        "live",
        "remix",
        "remaster",
        "acoustic",
        "instrumental",
        "karaoke",
        "edit",
        "demo",
        "version",
        "sped",
        "slowed",
        "radio",
        "clean",
        "explicit",
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

                left_words = set(left_title.split())
                right_words = set(right_title.split())

                left_has_version = bool(left_words & version_terms)
                right_has_version = bool(right_words & version_terms)

                score = SequenceMatcher(
                    None, left_title, right_title
                ).ratio()

                if score >= FUZZY_REVIEW_THRESHOLD:
                    candidates.append({
                        "entity_type": "track",
                        "artist_id": artist_id,
                        "track_a_id": left["id"],
                        "track_a_title": left["title"],
                        "track_b_id": right["id"],
                        "track_b_title": right["title"],
                        "similarity": round(score, 4),
                        "version_wording_differs": (
                            left_has_version != right_has_version
                        ),
                        "action": "review_only_not_merged",
                    })

    candidates.sort(
        key=lambda candidate: (
            -candidate["similarity"],
            candidate["track_a_title"].casefold(),
            candidate["track_b_title"].casefold(),
        )
    )

    return candidates


def build() -> dict[str, Any]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    raw_files = sorted(
        path for path in RAW_DIR.glob("*.json")
        if path.is_file()
    )

    all_artists: dict[str, dict[str, Any]] = {}
    all_albums: dict[str, dict[str, Any]] = {}
    all_tracks: dict[str, dict[str, Any]] = {}
    all_events: list[dict[str, Any]] = []
    input_errors: list[dict[str, str]] = []

    # Import and merge all files.
    for file_path in raw_files:
        print(f"Processing {file_path}...")

        try:
            artists, albums, tracks, events = (
                ingest_zerocharts_file(file_path)
            )
        except Exception as exc:
            input_errors.append({
                "file": str(file_path),
                "error": f"{type(exc).__name__}: {exc}",
            })
            continue

        for artist_id, artist in artists.items():
            if artist_id not in all_artists:
                all_artists[artist_id] = artist
            else:
                existing = all_artists[artist_id]

                for alias in [
                    artist.get("name"),
                    *artist.get("aliases", []),
                ]:
                    if (
                        alias
                        and alias != existing["name"]
                        and alias not in existing.setdefault("aliases", [])
                    ):
                        existing["aliases"].append(alias)

        for album_id, album in albums.items():
            if album_id not in all_albums:
                all_albums[album_id] = album
            else:
                existing = all_albums[album_id]

                for track_id in album.get("track_ids", []):
                    if track_id not in existing.setdefault("track_ids", []):
                        existing["track_ids"].append(track_id)

        for track_id, track in tracks.items():
            if track_id not in all_tracks:
                all_tracks[track_id] = track
            else:
                existing = all_tracks[track_id]

                for album_id in track.get("album_ids", []):
                    if album_id not in existing.setdefault("album_ids", []):
                        existing["album_ids"].append(album_id)

                for alias in [
                    track.get("title"),
                    *track.get("aliases", []),
                ]:
                    if (
                        alias
                        and alias != existing["title"]
                        and alias not in existing.setdefault("aliases", [])
                    ):
                        existing["aliases"].append(alias)

        all_events.extend(events)

    # Rebuild bidirectional album/track relationships.
    for album in all_albums.values():
        album["track_ids"] = sorted(set(album.get("track_ids", [])))

    for track in all_tracks.values():
        track["album_ids"] = sorted(set(track.get("album_ids", [])))

        for album_id in track["album_ids"]:
            if album_id in all_albums:
                album_track_ids = all_albums[album_id].setdefault(
                    "track_ids", []
                )

                if track["id"] not in album_track_ids:
                    album_track_ids.append(track["id"])

        track["album_ids"] = sorted(track["album_ids"])

        if track["album_ids"]:
            track["album_id"] = track["album_ids"][0]

    integrity_issues: list[dict[str, Any]] = []

    # Validate artists and album references.
    for track in all_tracks.values():
        artist_id = track.get("primary_artist_id")

        if artist_id not in all_artists:
            integrity_issues.append({
                "type": "missing_track_artist",
                "track_id": track["id"],
                "artist_id": artist_id,
            })

        valid_album_ids = []

        for album_id in track.get("album_ids", []):
            if album_id not in all_albums:
                integrity_issues.append({
                    "type": "missing_track_album",
                    "track_id": track["id"],
                    "album_id": album_id,
                })
            else:
                valid_album_ids.append(album_id)

        track["album_ids"] = valid_album_ids

        if valid_album_ids:
            track["album_id"] = valid_album_ids[0]
        else:
            track.pop("album_id", None)

    # Deduplicate exact repeat imports, not plays with different timestamps.
    all_events, duplicate_event_count = _deduplicate_events(all_events)

    invalid_events = []
    valid_events = []

    for event in all_events:
        if event.get("track_id") not in all_tracks:
            invalid_events.append({
                **event,
                "validation_error": "track_id_not_found",
            })
        else:
            valid_events.append(event)

    all_events = valid_events

    # Album eligibility is based on distinct canonical track IDs.
    eligible_albums: dict[str, dict[str, Any]] = {}
    ineligible_releases: list[dict[str, Any]] = []

    for album_id, album in all_albums.items():
        distinct_track_ids = sorted({
            track_id
            for track_id in album.get("track_ids", [])
            if track_id in all_tracks
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
                    f"Fewer than {MIN_ALBUM_TRACKS} "
                    "distinct canonical tracks"
                ),
            })

    ineligible_releases.sort(
        key=lambda row: (
            str(row["title"]).casefold(),
            row["id"],
        )
    )

    fuzzy_candidates = _fuzzy_track_candidates(all_tracks)

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
            "Fuzzy title candidates are reported for review only.",
            "Live, remix, remaster, acoustic and edit wording is preserved.",
            "Album eligibility requires distinct canonical track IDs.",
        ],
    }

    # Reports are written even if validation fails.
    _atomic_write_json(
        REPORTS_DIR / "input_errors.json",
        input_errors,
    )
    _atomic_write_json(
        REPORTS_DIR / "integrity_issues.json",
        integrity_issues,
    )
    _atomic_write_json(
        REPORTS_DIR / "invalid_events.json",
        invalid_events,
    )
    _atomic_write_json(
        REPORTS_DIR / "duplicate_candidates.json",
        fuzzy_candidates,
    )
    _atomic_write_json(
        REPORTS_DIR / "validation_report.json",
        validation,
    )

    # Do not replace the existing Vault if validation fails.
    if validation["status"] != "success":
        raise RuntimeError(
            "Vault validation failed; existing Vault files were not "
            "replaced. Check the reports directory."
        )

    artists_out = [
        all_artists[key] for key in sorted(all_artists)
    ]
    albums_out = [
        eligible_albums[key] for key in sorted(eligible_albums)
    ]
    tracks_out = [
        all_tracks[key] for key in sorted(all_tracks)
    ]

    manifest = {
        "settings": {
            "MIN_ALBUM_TRACKS": MIN_ALBUM_TRACKS,
            "FUZZY_REVIEW_THRESHOLD": FUZZY_REVIEW_THRESHOLD,
        },
        "record_counts": {
            "artists": len(artists_out),
            "eligible_albums": len(albums_out),
            "ineligible_releases": len(ineligible_releases),
            "all_albums": len(all_albums),
            "tracks": len(tracks_out),
            "listening_events": len(all_events),
            "fuzzy_candidates_for_review": len(fuzzy_candidates),
        },
        "deduplication": {
            "duplicate_events_removed": duplicate_event_count,
            "method": (
                "Exact canonical track ID plus exact non-empty timestamp"
            ),
            "fuzzy_metadata_matches_auto_merged": 0,
        },
        "build_status": "success",
    }

    # Write canonical datasets.
    _atomic_write_json(
        VAULT_DIR / "artists.json",
        artists_out,
    )
    _atomic_write_json(
        VAULT_DIR / "albums.json",
        albums_out,
    )
    _atomic_write_json(
        VAULT_DIR / "ineligible_releases.json",
        ineligible_releases,
    )
    _atomic_write_json(
        VAULT_DIR / "tracks.json",
        tracks_out,
    )
    _atomic_write_jsonl(
        VAULT_DIR / "listening_history.jsonl",
        all_events,
    )
    _atomic_write_json(
        VAULT_DIR / "manifest.json",
        manifest,
    )

    print(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    build()
