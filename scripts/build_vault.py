"""Build a normalized Music Vault from raw ZeroCharts listening-history JSON files.

Exact normalized matches are canonicalized. Fuzzy matches are reported for review,
not automatically merged, to avoid collapsing remixes/live/remasters into originals.
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
from normalize_metadata import normalize_text

RAW_DIR = Path("raw/listening_history")
VAULT_DIR = Path("vault")
REPORTS_DIR = Path("reports")
MIN_ALBUM_TRACKS = 3
FUZZY_REVIEW_THRESHOLD = 0.80


def _json_dump(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False, sort_keys=False)
        handle.write("\n")


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _atomic_write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _deduplicate_events(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Deduplicate only exact same canonical track + non-empty timestamp events."""
    output: list[dict[str, Any]] = []
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
    output.sort(key=lambda e: (str(e.get("timestamp") or ""), str(e.get("event_id") or "")))
    return output, removed


def _fuzzy_track_candidates(tracks: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Generate review-only title candidates within the same normalized artist."""
    by_artist: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for track in tracks.values():
        by_artist[str(track.get("primary_artist_id", ""))].append(track)

    candidates: list[dict[str, Any]] = []
    for artist_id, artist_tracks in by_artist.items():
        artist_tracks.sort(key=lambda t: (str(t.get("normalized_title", "")), str(t["id"])))
        for i, left in enumerate(artist_tracks):
            left_title = str(left.get("normalized_title", ""))
            if len(left_title) < 5:
                continue
            for right in artist_tracks[i + 1:]:
                right_title = str(right.get("normalized_title", ""))
                if left_title == right_title or len(right_title) < 5:
                    continue
                # Don't suggest auto-equivalence across explicit version markers.
                version_terms = ("live", "remix", "remaster", "acoustic", "instrumental", "karaoke", "radio edit", "sped up", "slowed", "demo", "edit", "version")
                left_has_version = any(term in left_title.split() for term in version_terms)
                right_has_version = any(term in right_title.split() for term in version_terms)
                score = SequenceMatcher(None, left_title, right_title).ratio()
                if score >= FUZZY_REVIEW_THRESHOLD:
                    candidates.append({
                        "entity_type": "track",
                        "artist_id": artist_id,
                        "track_a_id": left["id"],
                        "track_a_title": left["title"],
                        "track_b_id": right["id"],
                        "track_b_title": right["title"],
                        "similarity": round(score, 4),
                        "version_wording_differs": left_has_version != right_has_version,
                        "action": "review_only_not_merged",
                    })
    candidates.sort(key=lambda c: (-c["similarity"], c["track_a_title"].casefold(), c["track_b_title"].casefold()))
    return candidates


def build() -> dict[str, Any]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    raw_files = sorted(p for p in RAW_DIR.glob("*.json") if p.is_file())
    all_artists: dict[str, dict[str, Any]] = {}
    all_albums: dict[str, dict[str, Any]] = {}
    all_tracks: dict[str, dict[str, Any]] = {}
    all_events: list[dict[str, Any]] = []
    input_errors: list[dict[str, str]] = []

    for file_path in raw_files:
        print(f"Processing {file_path}...")
        try:
            artists, albums, tracks, events = ingest_zerocharts_file(file_path)
        except Exception as exc:
            input_errors.append({"file": str(file_path), "error": f"{type(exc).__name__}: {exc}"})
            continue

        # Merge exact deterministic IDs. Collect aliases and relationships rather than
        # overwriting records from earlier files.
        for artist_id, artist in artists.items():
            if artist_id not in all_artists:
                all_artists[artist_id] = artist
            else:
                existing = all_artists[artist_id]
                for alias in [artist.get("name"), *artist.get("aliases", [])]:
                    if alias and alias != existing["name"] and alias not in existing.setdefault("aliases", []):
                        existing["aliases"].append(alias)

        for album_id, album in albums.items():
            if album_id not in all_albums:
                all_albums[album_id] = album
            else:
                existing = all_albums[album_id]
                for track_id in album.get("track_ids", []):
                    if track_id not in existing.setdefault("track_ids", []):
                        existing["track_ids"].append(track_id)
                for field in ("source_titles", "edition_labels"):
                    for label in album.get(field, []):
                        if label not in existing.setdefault(field, []):
                            existing[field].append(label)

        for track_id, track in tracks.items():
            if track_id not in all_tracks:
                all_tracks[track_id] = track
            else:
                existing = all_tracks[track_id]
                for album_id in track.get("album_ids", []):
                    if album_id not in existing.setdefault("album_ids", []):
                        existing["album_ids"].append(album_id)
                for alias in [track.get("title"), *track.get("aliases", [])]:
                    if alias and alias != existing["title"] and alias not in existing.setdefault("aliases", []):
                        existing["aliases"].append(alias)
        all_events.extend(events)

    # Ensure bidirectional album/track relationships are complete.
    for album in all_albums.values():
        album["track_ids"] = sorted(set(album.get("track_ids", [])))
    for track in all_tracks.values():
        track["album_ids"] = sorted(set(track.get("album_ids", [])))
        for album_id in track["album_ids"]:
            if album_id in all_albums and track["id"] not in all_albums[album_id]["track_ids"]:
                all_albums[album_id]["track_ids"].append(track["id"])
        track["album_ids"] = sorted(track["album_ids"])
        if track["album_ids"]:
            track["album_id"] = track["album_ids"][0]

    # Remove references to absent entities and record integrity problems.
    integrity_issues: list[dict[str, Any]] = []
    for track in all_tracks.values():
        artist_id = track.get("primary_artist_id")
        if artist_id not in all_artists:
            integrity_issues.append({"type": "missing_track_artist", "track_id": track["id"], "artist_id": artist_id})
        valid_album_ids = [aid for aid in track.get("album_ids", []) if aid in all_albums]
        for aid in track.get("album_ids", []):
            if aid not in all_albums:
                integrity_issues.append({"type": "missing_track_album", "track_id": track["id"], "album_id": aid})
        track["album_ids"] = valid_album_ids
        if valid_album_ids:
            track["album_id"] = valid_album_ids[0]
        else:
            track.pop("album_id", None)

    all_events, duplicate_event_count = _deduplicate_events(all_events)
    invalid_events = []
    valid_events = []
    for event in all_events:
        if event.get("track_id") not in all_tracks:
            invalid_events.append({**event, "validation_error": "track_id_not_found"})
        else:
            valid_events.append(event)
    all_events = valid_events

    # Album eligibility counts distinct canonical track IDs, not play counts or aliases.
    eligible_albums: dict[str, dict[str, Any]] = {}
    ineligible_releases: list[dict[str, Any]] = []
    for album_id, album in all_albums.items():
        distinct_track_ids = sorted({tid for tid in album.get("track_ids", []) if tid in all_tracks})
        album["track_ids"] = distinct_track_ids
        count = len(distinct_track_ids)
        if count >= MIN_ALBUM_TRACKS:
            eligible_albums[album_id] = album
        else:
            ineligible_releases.append({
                "id": album_id,
                "title": album.get("title", "Unknown Album"),
                "primary_artist_id": album.get("primary_artist_id"),
                "track_count": count,
                "track_ids": distinct_track_ids,
                "exclusion_reason": f"Fewer than {MIN_ALBUM_TRACKS} distinct canonical tracks",
            })
    ineligible_releases.sort(key=lambda row: (str(row["title"]).casefold(), row["id"]))

    fuzzy_candidates = _fuzzy_track_candidates(all_tracks)
    album_family_report = []
    for album in all_albums.values():
        source_titles = sorted(set(album.get("source_titles", [])), key=str.casefold)
        edition_labels = sorted(set(album.get("edition_labels", [])), key=str.casefold)
        if len(source_titles) > 1 or edition_labels:
            album_family_report.append({
                "canonical_album_id": album["id"],
                "canonical_title": album.get("title", "Unknown Album"),
                "primary_artist_id": album.get("primary_artist_id"),
                "source_titles_merged": source_titles,
                "edition_labels_merged": edition_labels,
                "distinct_canonical_track_count": len(set(album.get("track_ids", []))),
                "action": "merged_known_deluxe_or_expanded_edition_into_parent_family",
            })
    album_family_report.sort(key=lambda row: (str(row["canonical_title"]).casefold(), row["canonical_album_id"]))

    validation = {
        "status": "failed" if input_errors or integrity_issues or invalid_events else "success",
        "raw_files_found": len(raw_files),
        "raw_files_failed": len(input_errors),
        "integrity_issue_count": len(integrity_issues),
        "invalid_event_count": len(invalid_events),
        "duplicate_events_removed": duplicate_event_count,
        "fuzzy_candidates_for_review": len(fuzzy_candidates),
        "album_families_consolidated": len(album_family_report),
        "notes": [
            "Known trailing Deluxe/Deluxe Edition/Deluxe Version/Expanded Edition/Bonus Tracks labels are consolidated into a parent album family.",
            "Original release titles and edition labels are preserved in album source_titles and edition_labels and reports/album_family_merges.json.",
            "Distinct canonical track IDs are unioned across editions, preserving unique deluxe bonus tracks without double-counting repeated tracks.",
            "Live, remix, remaster, acoustic, anniversary and other unrecognized edition labels are not automatically stripped.",
            "Fuzzy track title candidates are review-only; they are not automatically merged.",
        ],
    }

    # Do not replace a valid prior vault when input parsing or referential validation fails.
    _atomic_write_json(REPORTS_DIR / "input_errors.json", input_errors)
    _atomic_write_json(REPORTS_DIR / "integrity_issues.json", integrity_issues)
    _atomic_write_json(REPORTS_DIR / "invalid_events.json", invalid_events)
    _atomic_write_json(REPORTS_DIR / "duplicate_candidates.json", fuzzy_candidates)
    _atomic_write_json(REPORTS_DIR / "album_family_merges.json", album_family_report)
    _atomic_write_json(REPORTS_DIR / "validation_report.json", validation)

    if validation["status"] != "success":
        raise RuntimeError(
            "Vault build validation failed; existing vault files were not replaced. "
            f"See {REPORTS_DIR / 'validation_report.json'} and related reports."
        )

    # Stable output ordering for reproducible builds.
    artists_out = [all_artists[key] for key in sorted(all_artists)]
    albums_out = [eligible_albums[key] for key in sorted(eligible_albums)]
    tracks_out = [all_tracks[key] for key in sorted(all_tracks)]
    manifest = {
        "settings": {"MIN_ALBUM_TRACKS": MIN_ALBUM_TRACKS, "FUZZY_REVIEW_THRESHOLD": FUZZY_REVIEW_THRESHOLD},
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
            "method": "exact canonical track_id + exact non-empty timestamp",
            "fuzzy_metadata_matches_auto_merged": 0,
            "album_family_consolidation": "known deluxe/expanded/bonus-track suffixes; canonical track IDs unioned across family",
            "album_families_consolidated": len(album_family_report),
        },
        "build_status": "success",
    }

    _atomic_write_json(VAULT_DIR / "artists.json", artists_out)
    _atomic_write_json(VAULT_DIR / "albums.json", albums_out)
    _atomic_write_json(VAULT_DIR / "ineligible_releases.json", ineligible_releases)
    _atomic_write_json(VAULT_DIR / "tracks.json", tracks_out)
    _atomic_write_jsonl(VAULT_DIR / "listening_history.jsonl", all_events)
    _atomic_write_json(VAULT_DIR / "manifest.json", manifest)
    print(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    build()

