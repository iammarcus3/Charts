
import pandas as pd
from datetime import datetime
import json
from collections import defaultdict

CSV_PATH = "iammarcus3.csv"
EXISTING_WEEKDATA = "weekdata.js"
OUTPUT_FILE = "weekdata_ranked.js"
BASE_WEEK_START = datetime(2018, 2, 23)  # Week 1 = 23 Feb 2018

def get_week_number(date):
    delta_days = (date - BASE_WEEK_START).days
    return (delta_days // 7) + 1 if delta_days >= 0 else None

def get_multiplier(rank):
    if rank == 1: return 13
    elif rank <= 5: return 12
    elif rank <= 10: return 11
    elif rank <= 20: return 10
    elif rank <= 40: return 10
    elif rank <= 50: return 9
    elif rank <= 60: return 8
    elif rank <= 70: return 7
    elif rank <= 80: return 6
    else: return 5

def get_key(title, artist):
    return title.lower().strip() + "||" + artist.lower().strip()

# Load CSV and weekData
df = pd.read_csv(CSV_PATH, header=None)
df.columns = ['artist', 'album', 'title', 'timestamp']
df['timestamp'] = pd.to_datetime(df['timestamp'], errors='coerce')
df['week'] = df['timestamp'].apply(get_week_number)
df = df.dropna(subset=['week'])

with open(EXISTING_WEEKDATA, "r", encoding="utf-8") as f:
    js_text = f.read()
json_start = js_text.find("{")
week_data = json.loads(js_text[json_start:].rstrip().rstrip(";"))

# Build song history
song_history = defaultdict(lambda: {"totalSales": 0, "weeks": 0, "lastRank": None, "peak": None})
for week in sorted(week_data.keys(), key=lambda w: int(w)):
    for entry in week_data[week]:
        key = get_key(entry["title"], entry["artist"])
        song_history[key]["totalSales"] += entry["sales"]
        song_history[key]["weeks"] += 1
        song_history[key]["lastRank"] = entry["rank"]
        if song_history[key]["peak"] is None or entry["rank"] < song_history[key]["peak"]:
            song_history[key]["peak"] = entry["rank"]

# Process new weeks from CSV
for week, group in df.groupby('week'):
    week_key = str(int(week))
    grouped = group.groupby(['title', 'artist', 'album']).size().reset_index(name='plays')
    grouped = grouped.sort_values(by='plays', ascending=False).head(100).reset_index(drop=True)

    entries = []
    for i, row in grouped.iterrows():
        rank = i + 1
        key = get_key(row["title"], row["artist"])
        multiplier = get_multiplier(rank)
        plays = int(row['plays'])
        sales = plays * multiplier

        if key not in song_history:
            movement = "NEW"
        elif song_history[key]["lastRank"] is None:
            movement = "RE"
        elif rank < song_history[key]["lastRank"]:
            movement = "UP"
        elif rank > song_history[key]["lastRank"]:
            movement = "DOWN"
        else:
            movement = "—"

        total_sales = song_history[key]["totalSales"] + sales
        weeks_on_chart = song_history[key]["weeks"] + 1
        peak = min(rank, song_history[key]["peak"]) if song_history[key]["peak"] else rank

        entry = {
            "rank": rank,
            "title": row["title"],
            "artist": row["artist"],
            "movement": movement,
            "sales": sales,
            "totalSales": total_sales,
            "weeks": weeks_on_chart,
            "peak": peak,
            "album": row["album"] if pd.notnull(row["album"]) else None
        }

        entries.append(entry)
        song_history[key].update({
            "totalSales": total_sales,
            "weeks": weeks_on_chart,
            "lastRank": rank,
            "peak": peak
        })

    week_data[week_key] = entries

# Write final JS output
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    f.write("const weekData = " + json.dumps(week_data, indent=2, ensure_ascii=False) + ";")

print(f"✅ Done. Saved to {OUTPUT_FILE}")
