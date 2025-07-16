import json
import re
from collections import defaultdict

def normalize(text):
    return re.sub(r'[^a-z0-9]', '', re.sub(r'\(.*?\)|\[.*?\]|feat\..*', '', text.lower()))

def get_fuzzy_key(title, artist):
    return normalize(title) + normalize(artist)

def clean_weekdata(raw_js_path, output_js_path):
    with open(raw_js_path, 'r', encoding='utf-8') as f:
        js = f.read()

    # Strip JS wrapper
    if js.startswith("const weekData ="):
        js = js[len("const weekData ="):].strip()
    if js.endswith(";"):
        js = js[:-1]

    # Parse as JSON
    weekdata = json.loads(js)

    # First, normalize history
    song_history = defaultdict(list)

    for week_str in sorted(weekdata.keys(), key=lambda x: int(x)):
        week_num = int(week_str)
        for song in weekdata[week_str]:
            key = get_fuzzy_key(song['title'], song['artist'])
            song_history[key].append((week_num, song))

    # Now fix each week's entries by carrying over correct totals
    for week_str in weekdata:
        week_num = int(week_str)
        for song in weekdata[week_str]:
            key = get_fuzzy_key(song['title'], song['artist'])
            history = [entry for wk, entry in song_history[key] if wk <= week_num]

            song['weeks'] = len(history)
            song['totalSales'] = round(sum(e['sales'] for e in history), 2)
            song['peak'] = min(e['rank'] for e in history)

    # Write cleaned output
    with open(output_js_path, 'w', encoding='utf-8') as f:
        f.write("const weekData = ")
        json.dump(weekdata, f, indent=2)
        f.write(";\n")

    print(f"Cleaned weekdata.js written to: {output_js_path}")

# Example usage:
# clean_weekdata("weekdata.js", "cleaned_weekdata.js")
