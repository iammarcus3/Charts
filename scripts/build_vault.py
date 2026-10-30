"""Build a normalized Music Vault from raw ZeroCharts listening-history JSON files.

Bracketed album variants are consolidated into parent album families. Track identities
are based on exact normalized artist/title keys only; fuzzy title similarity is never
automatically used to merge distinct songs or versions.
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
from normalize_metadata import generate_deterministic_id, normalize_text

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


def _merge_similar_tracks(
    tracks: dict[str, dict[str, Any]], events: list[dict[str, Any]], threshold: float = 0.90
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]], dict[str, str]]:
    """Merge same-artist track records whose normalized titles are >= threshold similar.

    Connected components are merged so a chain of qualifying title variants cannot
    survive as multiple chart entries. The shortest title is the deterministic
    canonical display title; all other spellings are preserved as aliases.
    """
    by_artist: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for track in tracks.values():
        by_artist[str(track.get("primary_artist_id", ""))].append(track)

    parent: dict[str, str] = {track_id: track_id for track_id in tracks}

    def find(track_id: str) -> str:
        while parent[track_id] != track_id:
            parent[track_id] = parent[parent[track_id]]
            track_id = parent[track_id]
        return track_id

    def union(left_id: str, right_id: str) -> None:
        left_root, right_root = find(left_id), find(right_id)
        if left_root == right_root:
            return
        # Root selection is deterministic and independent of input file order.
        parent[max(left_root, right_root)] = min(left_root, right_root)

    pair_scores: dict[tuple[str, str], float] = {}
    for artist_tracks in by_artist.values():
        artist_tracks.sort(key=lambda t: (str(t.get("normalized_title", "")), str(t["id"])))
        for i, left in enumerate(artist_tracks):
            left_title = str(left.get("normalized_title") or normalize_text(left.get("title", "")))
            for right in artist_tracks[i + 1:]:
                right_title = str(right.get("normalized_title") or normalize_text(right.get("title", "")))
                if not left_title or not right_title or left_title == right_title:
                    continue
                score = SequenceMatcher(None, left_title, right_title).ratio()
                if score >= threshold:
                    a, b = sorted((str(left["id"]), str(right["id"])))
                    pair_scores[(a, b)] = score
                    union(a, b)

    components: dict[str, list[str]] = defaultdict(list)
    for track_id in tracks:
        components[find(track_id)].append(track_id)

    event_counts: dict[str, int] = defaultdict(int)
    for event in events:
        if event.get("track_id"):
            event_counts[str(event["track_id"])] += 1

    remap: dict[str, str] = {}
    merged: dict[str, dict[str, Any]] = {}
    report: list[dict[str, Any]] = []
    for members in components.values():
        # Prefer the shortest normalized title (usually the original title), then
        # most-used spelling, then stable lexical/ID tie-breakers.
        canonical_id = min(
            members,
            key=lambda tid: (
                len(str(tracks[tid].get("normalized_title") or normalize_text(tracks[tid].get("title", "")))),
                -event_counts.get(tid, 0),
                str(tracks[tid].get("normalized_title", "")),
                tid,
            ),
        )
        canonical = dict(tracks[canonical_id])
        canonical["album_ids"] = list(canonical.get("album_ids", []))
        canonical["aliases"] = list(canonical.get("aliases", []))
        source_titles: list[str] = []
        for member_id in members:
            remap[member_id] = canonical_id
            member = tracks[member_id]
            for album_id in member.get("album_ids", []):
                if album_id not in canonical["album_ids"]:
                    canonical["album_ids"].append(album_id)
            for title in [member.get("title"), *member.get("aliases", [])]:
                if title and title not in source_titles:
                    source_titles.append(title)
                if title and title != canonical.get("title") and title not in canonical["aliases"]:
                    canonical["aliases"].append(title)
        canonical["album_ids"] = sorted(canonical["album_ids"])
        if canonical["album_ids"]:
            canonical["album_id"] = canonical["album_ids"][0]
        canonical["source_titles"] = sorted(source_titles, key=str.casefold)
        merged[canonical_id] = canonical
        if len(members) > 1:
            member_set = set(members)
            scores = [score for (a, b), score in pair_scores.items() if a in member_set and b in member_set]
            report.append({
                "canonical_track_id": canonical_id,
                "canonical_title": canonical.get("title", "Unknown Track"),
                "artist_id": canonical.get("primary_artist_id"),
                "source_track_ids_merged": sorted(members),
                "source_titles_merged": canonical["source_titles"],
                "highest_pairwise_similarity": round(max(scores, default=1.0), 4),
                "action": "automatically_merged_at_or_above_similarity_threshold",
            })

    for event in events:
        old_id = str(event.get("track_id", ""))
        if old_id in remap:
            event["track_id"] = remap[old_id]
            # Event identity must follow canonical track identity before de-duplication.
            timestamp = event.get("timestamp")
            if timestamp is not None and str(timestamp).strip():
                event["event_id"] = generate_event_id(event["track_id"], timestamp)
    report.sort(key=lambda row: (str(row["canonical_title"]).casefold(), row["canonical_track_id"]))
    return merged, report, remap


def generate_event_id(track_id: str, timestamp: Any) -> str:
    from normalize_metadata import generate_deterministic_id
    return generate_deterministic_id("event", track_id, str(timestamp).strip())


def _fuzzy_track_candidates(tracks: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Report near-matches below the automatic 90% merge threshold for auditing."""
    by_artist: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for track in tracks.values():
        by_artist[str(track.get("primary_artist_id", ""))].append(track)
    candidates: list[dict[str, Any]] = []
    for artist_id, artist_tracks in by_artist.items():
        artist_tracks.sort(key=lambda t: (str(t.get("normalized_title", "")), str(t["id"])))
        for i, left in enumerate(artist_tracks):
            left_title = str(left.get("normalized_title", ""))
            for right in artist_tracks[i + 1:]:
                right_title = str(right.get("normalized_title", ""))
                if not left_title or not right_title or left_title == right_title:
                    continue
                score = SequenceMatcher(None, left_title, right_title).ratio()
                if FUZZY_REVIEW_THRESHOLD <= score < 0.90:
                    candidates.append({
                        "entity_type": "track",
                        "artist_id": artist_id,
                        "track_a_id": left["id"],
                        "track_a_title": left["title"],
                        "track_b_id": right["id"],
                        "track_b_title": right["title"],
                        "similarity": round(score, 4),
                        "action": "review_only_below_auto_merge_threshold",
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

    # Do not fuzzy-merge similar song titles: versions, remixes, edits and bonus tracks
    # can have very similar names but must remain separate chart entries. Exact normalized
    # artist/title duplicates already share a deterministic ID in import_data.py.
    song_merge_report: list[dict[str, Any]] = []
    track_id_remap = {track_id: track_id for track_id in all_tracks}
    for album in all_albums.values():
        album["track_ids"] = sorted({track_id_remap.get(tid, tid) for tid in album.get("track_ids", [])})

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
                "action": "merged_bracketed_or_edition_variant_into_parent_album_family",
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
        "song_families_merged": len(song_merge_report),
        "album_families_consolidated": len(album_family_report),
        "notes": [
            "All parenthesized (...) and bracketed [...] album-title annotations are removed for album-family matching; source titles are preserved.",
            "Original release titles and edition labels are preserved in album source_titles and edition_labels and reports/album_family_merges.json.",
            "Distinct canonical track IDs are unioned across editions, preserving unique deluxe bonus tracks without double-counting repeated tracks.",
            "Track identity uses exact normalized artist/title keys only; fuzzy title-similarity candidates are reported for review and never auto-merged.",
            "Similarity candidates from 80% up to but below 90% are reported for review and are not auto-merged.",
        ],
    }

    # Do not replace a valid prior vault when input parsing or referential validation fails.
    _atomic_write_json(REPORTS_DIR / "input_errors.json", input_errors)
    _atomic_write_json(REPORTS_DIR / "integrity_issues.json", integrity_issues)
    _atomic_write_json(REPORTS_DIR / "invalid_events.json", invalid_events)
    _atomic_write_json(REPORTS_DIR / "duplicate_candidates.json", fuzzy_candidates)
    _atomic_write_json(REPORTS_DIR / "song_merges.json", song_merge_report)
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
            "song_families_merged": len(song_merge_report),
        },
        "deduplication": {
            "duplicate_events_removed": duplicate_event_count,
            "method": "exact canonical track_id + exact non-empty timestamp",
            "fuzzy_metadata_matches_auto_merged": 0,
            "track_similarity_auto_merge_threshold": None,
            "album_family_consolidation": "all bracketed and parenthesized album-title annotations stripped for family matching; canonical track IDs unioned across family",
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

# Trigger a diagnostic rebuild so failed validation reports are captured in Actions.
