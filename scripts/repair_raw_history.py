import json
from pathlib import Path

RAW_DIR = Path("raw/listening_history")
# Safe, repeatable repair: only a verified trailing literal escape is removed.


def load_and_repair(path: Path):
    raw = path.read_bytes()
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as original_error:
        # Repair only the exact two-byte suffix accidentally appended by the
        # previous workflow: a literal backslash followed by the letter n.
        if not raw.endswith(b"\\n"):
            raise original_error
        candidate = raw[:-2]
        data = json.loads(candidate.decode("utf-8"))
        rows = data if isinstance(data, list) else data.get("scrobbles", [])
        if not isinstance(rows, list):
            raise RuntimeError(f"Refusing repair: invalid scrobbles array in {path}")
        path.write_bytes(candidate + b"\n")
        json.loads(path.read_text(encoding="utf-8"))
        print(f"RAW_JSON_REPAIRED {path.name}: preserved {len(rows)} scrobbles")
    return data


def canonicalize(data):
    rows = data if isinstance(data, list) else data.get("scrobbles", [])
    changed = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in ("artist", "artist_name", "album_artist"):
            value = row.get(key)
            if isinstance(value, str) and value.strip().casefold() == "q":
                row[key] = "Q Marsden"
                changed += 1
            elif isinstance(value, dict):
                for text_key in ("#text", "#TEXT", "text", "name", "title", "value"):
                    candidate = value.get(text_key)
                    if isinstance(candidate, str) and candidate.strip().casefold() == "q":
                        value[text_key] = "Q Marsden"
                        changed += 1
                        break
    return changed


def main():
    total_replacements = 0
    for path in sorted(RAW_DIR.glob("*.json")):
        data = load_and_repair(path)
        replacements = canonicalize(data)
        total_replacements += replacements
        if replacements:
            path.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        # Validate the exact bytes that will be consumed by the vault builder.
        json.loads(path.read_text(encoding="utf-8"))
        rows = data if isinstance(data, list) else data.get("scrobbles", [])
        print(f"RAW_JSON_VALID {path.name}: records={len(rows)} Q_replacements={replacements}")
    print(f"RAW_ARTIST_CANONICALIZATION replacements={total_replacements}")


if __name__ == "__main__":
    main()
