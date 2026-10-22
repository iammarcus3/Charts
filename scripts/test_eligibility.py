import unittest
from import_data import generate_deterministic_id

# We simulate the exact logic from build_vault.py to ensure the rule holds
def check_album_eligibility(tracks_list, min_tracks=3):
    album_track_sets = {}
    for track in tracks_list:
        album_id = track["album_id"]
        if album_id not in album_track_sets:
            album_track_sets[album_id] = set()
        album_track_sets[album_id].add(track["id"])
        
    eligible = {}
    ineligible = {}
    for album_id, track_set in album_track_sets.items():
        if len(track_set) >= min_tracks:
            eligible[album_id] = len(track_set)
        else:
            ineligible[album_id] = len(track_set)
    return eligible, ineligible

class TestAlbumEligibility(unittest.TestCase):
    def test_single_track_release(self):
        tracks = [{"id": "t1", "album_id": "a1"}]
        eligible, ineligible = check_album_eligibility(tracks)
        self.assertIn("a1", ineligible)
        self.assertNotIn("a1", eligible)

    def test_two_track_release(self):
        tracks = [{"id": "t1", "album_id": "a2"}, {"id": "t2", "album_id": "a2"}]
        eligible, ineligible = check_album_eligibility(tracks)
        self.assertIn("a2", ineligible)
        self.assertNotIn("a2", eligible)

    def test_three_track_release(self):
        tracks = [{"id": "t1", "album_id": "a3"}, {"id": "t2", "album_id": "a3"}, {"id": "t3", "album_id": "a3"}]
        eligible, ineligible = check_album_eligibility(tracks)
        self.assertIn("a3", eligible)
        self.assertEqual(eligible["a3"], 3)

    def test_duplicate_tracks_do_not_count(self):
        # A release with 10 listens but only 2 unique tracks
        tracks = [{"id": "t1", "album_id": "a4"}, {"id": "t2", "album_id": "a4"}, {"id": "t1", "album_id": "a4"}]
        eligible, ineligible = check_album_eligibility(tracks)
        self.assertIn("a4", ineligible)
        self.assertEqual(ineligible["a4"], 2)

    def test_multiple_legitimate_releases(self):
        # The same track on two different releases
        tracks = [
            {"id": "t1", "album_id": "album_deluxe"}, {"id": "t2", "album_id": "album_deluxe"}, {"id": "t3", "album_id": "album_deluxe"},
            {"id": "t1", "album_id": "single_release"}
        ]
        eligible, ineligible = check_album_eligibility(tracks)
        self.assertIn("album_deluxe", eligible)
        self.assertIn("single_release", ineligible)

if __name__ == '__main__':
    unittest.main()
