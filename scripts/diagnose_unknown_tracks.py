"""Diagnostic for source rows that fall back to Unknown Track.

This prints counts and a few field-level examples in CI so the importer can be
fixed based on the actual ZeroCharts export schema rather than guesses.
"""
import json
from pathlib import Path

for path in sorted(Path("raw/listening_history").glob("*.json")):
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data if isinstance(data, list) else data.get("scrobbles", [])
    missing = []
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        title = next((row.get(k) for k in ("track", "track_name", "title") if row.get(k) not in (None, "")), None)
        if title is None:
            missing.append((i, sorted(row.keys()), {k: row.get(k) for k in ("artist", "artist_name", "album", "album_title", "track", "track_name", "title") if k in row}))
    print(f"DIAGNOSTIC {path.name}: records={len(rows)} missing_track_title={len(missing)}")
    for i, keys, values in missing[:12]:
        print(f"DIAGNOSTIC sample index={i} keys={keys} values={json.dumps(values, ensure_ascii=False)[:700]}")
