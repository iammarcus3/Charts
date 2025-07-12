import json
from datetime import datetime
from collections import defaultdict
import os

# ---------- CONFIGURATION ----------
INPUT_FILE = "spotify.json"
OUTPUT_FILE = "weekdata.js"
SALE_UNIT_MS = 30000
WEEK_1_START = datetime(2018, 2, 23)  # Friday, Week 1
# -----------------------------------

def get_week_number(timestamp):
    ts = datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ")
    delta_days = (ts - WEEK_1_START).days
    return delta_days // 7 + 1 if delta_days >= 0 else None

def load_streams(filename):
    with open(filename, "r", encoding="utf-8") as f:
        return json.load(f)

def aggregate_by_week(streams):
    weekdata = defaultdict(lambda: defaultdict(lambda: {"ms_played": 0, "album": None}))
    for entry in streams:
        if not entry.get("master_metadata_track_name") or not entry.get("master_metadata_album_artist_name"):
            continue
        week = get_week_number(entry["ts"])
        if not week:
            continue

        title = entry["master_metadata_track_name"].strip()
        artist = entry["master_metadata_album_artist_name"].strip()
        album = entry.get("master_metadata_album_album_name", "").strip()
        ms = entry.get("ms_played", 0)

        key = (title, artist)
        weekdata[week][key]["ms_played"] += ms
        if not weekdata[week][key]["album"]:
            weekdata[week][key]["album"] = album or None
    return weekdata

def build_weekdata(weekly_data):
    final_data = {}
    history = defaultdict(lambda: {"totalSales": 0, "weeks": 0, "peak_rank": None, "last_rank": None, "last_week": None})

    for week in sorted(weekly_data.keys()):
        entries = []
        for (title, artist), info in weekly_data[week].items():
            sales = info["ms_played"] // SALE_UNIT_MS
            if sales <= 0:
                continue

            key = (title, artist)
            hist = history[key]
            hist["totalSales"] += sales
            hist["weeks"] += 1

            entries.append({
                "title": title,
                "artist": artist,
                "sales": sales,
                "album": info["album"],
                "key": key
            })

        entries.sort(key=lambda x: -x["sales"])
        for i, entry in enumerate(entries):
            rank = i + 1
            key = entry["key"]
            hist = history[key]

            # Determine movement
            movement = "NEW"
            if hist["last_week"] == week - 1:
                if hist["last_rank"]:
                    if rank < hist["last_rank"]:
                        movement = "↑"
                    elif rank > hist["last_rank"]:
                        movement = "↓"
                    else:
                        movement = "→"

            hist["last_rank"] = rank
            hist["last_week"] = week
            if hist["peak_rank"] is None or rank < hist["peak_rank"]:
                hist["peak_rank"] = rank

            entries[i] = {
                "rank": rank,
                "title": entry["title"],
                "artist": entry["artist"],
                "movement": movement,
                "sales": entry["sales"],
                "totalSales": hist["totalSales"],
                "weeks": hist["weeks"],
                "peak": hist["peak_rank"],
                "album": entry["album"]
            }

        final_data[str(week)] = entries
    return final_data

def export_to_js(data, output_file):
    js_code = "const weekData = " + json.dumps(data, indent=2) + ";"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(js_code)
    print(f"✅ Done: Exported to {output_file}")

# -------- MAIN SCRIPT ----------
if __name__ == "__main__":
    if not os.path.exists(INPUT_FILE):
        print(f"❌ File not found: {INPUT_FILE}")
        exit(1)

    streams = load_streams(INPUT_FILE)
    weekly_data = aggregate_by_week(streams)
    weekdata = build_weekdata(weekly_data)
    export_to_js(weekdata, OUTPUT_FILE)
