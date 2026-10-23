
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_vault


class TestAlbumEligibility(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

        self.raw_dir = self.root / "raw" / "listening_history"
        self.vault_dir = self.root / "vault"
        self.reports_dir = self.root / "reports"

        self.raw_dir.mkdir(parents=True)

        # Redirect the real build pipeline to temporary directories.
        self.patcher = patch.multiple(
            build_vault,
            RAW_DIR=self.raw_dir,
            VAULT_DIR=self.vault_dir,
            REPORTS_DIR=self.reports_dir,
            MIN_ALBUM_TRACKS=3,
        )
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.temp_dir.cleanup()

    def build_from_scrobbles(self, scrobbles):
        """Write test input and run the actual Vault builder."""
        input_file = self.raw_dir / "test_history.json"
        input_file.write_text(
            json.dumps({"scrobbles": scrobbles}),
            encoding="utf-8",
        )

        manifest = build_vault.build()

        albums = json.loads(
            (self.vault_dir / "albums.json").read_text(
                encoding="utf-8"
            )
        )
        ineligible = json.loads(
            (self.vault_dir / "ineligible_releases.json").read_text(
                encoding="utf-8"
            )
        )
        tracks = json.loads(
            (self.vault_dir / "tracks.json").read_text(
                encoding="utf-8"
            )
        )

        return manifest, albums, ineligible, tracks

    @staticmethod
    def play(artist, album, track, timestamp):
        return {
            "artist": artist,
            "album": album,
            "track": track,
            "timestamp": timestamp,
        }

    def test_single_track_release_is_ineligible(self):
        manifest, albums, ineligible, tracks = (
            self.build_from_scrobbles([
                self.play("Artist", "Single", "Song One", "2026-01-01"),
            ])
        )

        self.assertEqual(len(albums), 0)
        self.assertEqual(len(ineligible), 1)
        self.assertEqual(ineligible[0]["track_count"], 1)
        self.assertEqual(manifest["record_counts"]["tracks"], 1)

    def test_two_track_release_is_ineligible(self):
        _, albums, ineligible, _ = self.build_from_scrobbles([
            self.play("Artist", "Short Release", "Song One", "2026-01-01"),
            self.play("Artist", "Short Release", "Song Two", "2026-01-02"),
        ])

        self.assertEqual(len(albums), 0)
        self.assertEqual(len(ineligible), 1)
        self.assertEqual(ineligible[0]["track_count"], 2)

    def test_three_distinct_tracks_make_release_eligible(self):
        _, albums, ineligible, _ = self.build_from_scrobbles([
            self.play("Artist", "Full Album", "Song One", "2026-01-01"),
            self.play("Artist", "Full Album", "Song Two", "2026-01-02"),
            self.play("Artist", "Full Album", "Song Three", "2026-01-03"),
        ])

        self.assertEqual(len(albums), 1)
        self.assertEqual(len(ineligible), 0)
        self.assertEqual(len(albums[0]["track_ids"]), 3)

    def test_repeated_plays_do_not_inflate_track_count(self):
        _, albums, ineligible, tracks = self.build_from_scrobbles([
            self.play("Artist", "Short Album", "Song One", "2026-01-01"),
            self.play("Artist", "Short Album", "Song One", "2026-01-02"),
            self.play("Artist", "Short Album", "Song Two", "2026-01-03"),
            self.play("Artist", "Short Album", "Song Two", "2026-01-04"),
        ])

        self.assertEqual(len(albums), 0)
        self.assertEqual(len(ineligible), 1)
        self.assertEqual(ineligible[0]["track_count"], 2)
        self.assertEqual(len(tracks), 2)

    def test_same_recording_can_belong_to_multiple_releases(self):
        _, albums, ineligible, tracks = self.build_from_scrobbles([
            self.play("Artist", "Deluxe Album", "Song One", "2026-01-01"),
            self.play("Artist", "Deluxe Album", "Song Two", "2026-01-02"),
            self.play("Artist", "Deluxe Album", "Song Three", "2026-01-03"),
            self.play("Artist", "Single Release", "Song One", "2026-01-04"),
        ])

        eligible_by_title = {
            album["title"]: album for album in albums
        }
        ineligible_by_title = {
            album["title"]: album for album in ineligible
        }

        self.assertIn("Deluxe Album", eligible_by_title)
        self.assertIn("Single Release", ineligible_by_title)
        self.assertEqual(
            ineligible_by_title["Single Release"]["track_count"], 1
        )

        # Song One must be represented by one canonical track ID.
        song_one = [
            track for track in tracks
            if track["title"] == "Song One"
        ]
        self.assertEqual(len(song_one), 1)

        song_one_album_ids = set(song_one[0]["album_ids"])
        self.assertEqual(len(song_one_album_ids), 2)

    def test_accent_and_case_variants_share_canonical_track(self):
        _, _, ineligible, tracks = self.build_from_scrobbles([
            self.play("Beyoncé", "Test Album", "Café Song", "2026-01-01"),
            self.play("beyonce", "Test Album", "Cafe Song", "2026-01-02"),
        ])

        self.assertEqual(len(tracks), 1)
        self.assertEqual(len(ineligible), 1)
        self.assertEqual(ineligible[0]["track_count"], 1)

    def test_distinct_timestamps_preserve_legitimate_plays(self):
        manifest, _, _, _ = self.build_from_scrobbles([
            self.play("Artist", "Album", "Song One", "2026-01-01T10:00:00"),
            self.play("Artist", "Album", "Song One", "2026-01-01T11:00:00"),
        ])

        self.assertEqual(
            manifest["record_counts"]["listening_events"], 2
        )
        self.assertEqual(
            manifest["deduplication"]["duplicate_events_removed"], 0
        )

    def test_exact_duplicate_event_is_removed(self):
        manifest, _, _, _ = self.build_from_scrobbles([
            self.play("Artist", "Album", "Song One", "2026-01-01T10:00:00"),
            self.play("Artist", "Album", "Song One", "2026-01-01T10:00:00"),
        ])

        self.assertEqual(
            manifest["record_counts"]["listening_events"], 1
        )
        self.assertEqual(
            manifest["deduplication"]["duplicate_events_removed"], 1
        )


    def test_lastfm_name_field_is_used_as_track_title(self):
        _, _, _, tracks = self.build_from_scrobbles([
            {
                "artist": {"mbid": "artist-id", "#text": "Aaliyah"},
                "album": {"mbid": "album-id", "#text": "Age Ain't Nothing but a Number"},
                "name": "Back & Forth",
                "date": {"uts": "1760000000", "#text": "Thu, 09 Oct 2025 00:00:00"},
            },
        ])
        self.assertEqual(len(tracks), 1)
        self.assertEqual(tracks[0]["title"], "Back & Forth")
        self.assertNotEqual(tracks[0]["title"], "Unknown Track")


if __name__ == "__main__":
    unittest.main()
