
"""Conservative metadata normalization and deterministic IDs for Music Vault."""
from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any

_SPACE_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize_text(text: Any) -> str:
    """Normalize text for exact matching without removing meaningful version tags."""
    if text is None:
        return ""

    value = unicodedata.normalize("NFKD", str(text))
    value = "".join(
        char for char in value
        if not unicodedata.combining(char)
    )
    value = value.casefold()
    value = value.replace("&", " and ")
    value = _PUNCT_RE.sub(" ", value)

    return _SPACE_RE.sub(" ", value).strip()


def display_text(text: Any, fallback: str = "Unknown") -> str:
    """Clean display whitespace without changing the original spelling."""
    if text is None:
        return fallback

    value = _SPACE_RE.sub(" ", str(text)).strip()
    return value or fallback


def generate_deterministic_id(
    entity_type: str,
    *identity_parts: Any,
) -> str:
    """Generate a stable ID from normalized identity fields."""
    normalized_parts = [
        normalize_text(part) for part in identity_parts
    ]

    raw_identity = (
        f"{normalize_text(entity_type)}:"
        f"{':'.join(normalized_parts)}"
    )

    return hashlib.sha256(
        raw_identity.encode("utf-8")
    ).hexdigest()[:24]


def title_match_key(text: Any) -> str:
    """Exact normalized title key; preserves live/remix/remaster wording."""
    return normalize_text(text)
