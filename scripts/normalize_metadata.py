"""Conservative metadata normalization and deterministic IDs for Music Vault."""
from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any

_SPACE_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize_text(text: Any) -> str:
    """Normalize text for exact matching; does not remove meaningful words/version tags."""
    if text is None:
        return ""
    value = unicodedata.normalize("NFKD", str(text))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.casefold()
    value = value.replace("&", " and ")
    value = _PUNCT_RE.sub(" ", value)
    return _SPACE_RE.sub(" ", value).strip()


def display_text(text: Any, fallback: str = "Unknown") -> str:
    """Trim and collapse whitespace while retaining the source's display spelling."""
    if text is None:
        return fallback
    value = _SPACE_RE.sub(" ", str(text)).strip()
    return value or fallback


def generate_deterministic_id(entity_type: str, *identity_parts: Any) -> str:
    """Stable SHA-256 ID from normalized identity fields."""
    normalized_parts = [normalize_text(p) for p in identity_parts]
    raw_identity = f"{normalize_text(entity_type)}:{':'.join(normalized_parts)}"
    return hashlib.sha256(raw_identity.encode("utf-8")).hexdigest()[:24]


def title_match_key(text: Any) -> str:
    """Exact normalized title key. Intentionally preserves words like live/remix/remaster."""
    return normalize_text(text)


# Only remove known trailing edition labels that indicate an expanded version of
# the same studio album. Recording-type labels (Live, Remix, Acoustic, etc.) stay.
_DELUXE_SUFFIX_RE = re.compile(
    r"^(?P<base>.+?)\s*(?:"
    r"(?:\(|\[)\s*(?:deluxe(?:\s+(?:edition|version|album))?|expanded(?:\s+edition)?|bonus\s+tracks?(?:\s+edition)?)\s*(?:\)|\])"
    r"|(?:[-:–—]|\s+)\s*(?:deluxe(?:\s+(?:edition|version|album))?|expanded(?:\s+edition)?|bonus\s+tracks?(?:\s+edition)?)"
    r")\s*$",
    re.IGNORECASE,
)

def canonical_album_title(title: Any) -> str:
    """Return a parent-album title for known deluxe/expanded-edition suffixes.

    Intentionally conservative: it does not remove Live, Remixed, Anniversary,
    Acoustic, Instrumental, or other recording/edition labels.
    """
    value = display_text(title, "Unknown Album")
    previous = None
    while value != previous:
        previous = value
        match = _DELUXE_SUFFIX_RE.match(value)
        if match:
            value = match.group("base").strip()
        else:
            break
    return value or "Unknown Album"


