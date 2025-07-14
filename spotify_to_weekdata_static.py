import json
from datetime import datetime, timedelta
from collections import defaultdict

def rank_multiplier(rank):
    if rank == 1: return 13
    elif 2 <= rank <= 5: return 12
    elif 6 <= rank <= 10: return 11
    elif 11 <= rank <= 40: return 10
    elif 41 <= rank <= 50: return 9
    elif 51 <= rank <= 60: return 8
    elif 61 <= rank <= 70: return 7
    elif 71 <= rank <= 80: return 6
    elif 81 <= rank <= 100: return 5
    return 0

def get_week_number(dt):
    chart_start = datetime(2018, 2, 23)
    return 1 + (dt - chart_start).days // 7

def load_spotify_data(files):
    data = []
    for file in files:
        with open(file, "r", encoding="utf-8") as f:
            data.extend(json.load(f))
    return data

def process_data(data):
    weekly_data = defaultdict(lambda: defaultdict(lambda: {"ms": 0, "album": ""}))

    for entry in data:
        try:
            title = entry["master_metadata_track_name"]
            artist = entry["master_metadata_album_artist_name"]
            album = entry.get("master_metadata_album_album_name", "")
            ms = entry["ms_played"]
            dt = datetime.strptime(entry["ts"], "%Y-%m-%dT%H:%M:%SZ")
        except: continue

        if not title or not artist or ms <= 0: continue

        week = str(get_week_number(dt))
        key = (title.strip(), artist.strip())
        weekly_data[week][key]["ms"] += ms
        weekly_data[week][key]["album"] = album

    return weekly_data

def build_weekdata(weekly_data):
    weekData = {}
    history = defaultdict(lambda: {"totalSales": 0, "weeks": 0, "peak": float("inf"), "lastRank": None})

    for week in sorted(weekly_data.keys(), key=int):
        songs = []
        for (title, artist), val in weekly_data[week].items():
            raw = val["ms"] / 30000
            songs.append({ "title": title, "artist": artist, "album": val["album"], "raw": raw })

        songs.sort(key=lambda x: x["raw"], reverse=True)

        for idx, song in enumerate(songs[:100], 1):
            mult = rank_multiplier(idx)
            sales = round(song["raw"] * mult, 2)

            key = (song["title"], song["artist"])
            hist = history[key]
            hist["totalSales"] += sales
            hist["weeks"] += 1
            hist["peak"] = min(hist["peak"], idx)

            movement = "⬅️"
            if hist["lastRank"] is not None:
                if idx < hist["lastRank"]: movement = "⬆️"
                elif idx > hist["lastRank"]: movement = "⬇️"
            hist["lastRank"] = idx

            song.update({
                "rank": str(idx),
                "movement": movement,
                "sales": sales,
                "totalSales": round(hist["totalSales"], 2),
                "weeks": hist["weeks"],
                "peak": hist["peak"]
            })
            del song["raw"]

        weekData[week] = songs[:100]

    return weekData

def export_weekdata(weekData, out_path="weekdata.js"):
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("const weekData = ")
        json.dump(weekData, f, indent=2)
        f.write(";")

# Example usage:
if __name__ == "__main__":
    files = [
        "Streaming_History_Audio_2020-2021_0.json",
        "Streaming_History_Audio_2021-2022_1.json",
        "Streaming_History_Audio_2022_2.json"
    ]
    data = load_spotify_data(files)
    weekly = process_data(data)
    weekdata = build_weekdata(weekly)
    export_weekdata(weekdata)
