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


# Album-family rule: bracketed/parenthesized edition text is not a separate album.
# Remove every non-nested (...) or [...] segment, not only known Deluxe suffixes.
_BRACKETED_TEXT_RE = re.compile(r"\([^()]*\)|\[[^\[\]]*\]")
_ALBUM_SEPARATOR_RE = re.compile(r"\s*[-:–—|]+\s*$")
_PLAIN_EDITION_SUFFIX_RE = re.compile(
    r"\s*(?:[-:–—]\s*)?(?:deluxe(?:\s+(?:edition|version|album))?|expanded(?:\s+edition)?|bonus\s+tracks?(?:\s+edition)?)\s*$",
    re.IGNORECASE,
)

def canonical_album_title(title: Any) -> str:
    """Remove bracketed/parenthesized album annotations to map editions to a parent.

    The original source title is retained separately by the importer for auditability.
    If removing annotations would leave no usable title, preserve the source title.
    """
    original = display_text(title, "Unknown Album")
    value = original
    previous = None
    while value != previous:
        previous = value
        value = _BRACKETED_TEXT_RE.sub(" ", value)
    value = _SPACE_RE.sub(" ", value).strip()
    value = _PLAIN_EDITION_SUFFIX_RE.sub("", value).strip()
    value = _ALBUM_SEPARATOR_RE.sub("", value).strip()
    value = _SPACE_RE.sub(" ", value).strip()
    return value or original





# Track identity rules intentionally differ from display metadata. Featured-artist
# annotations are credits, not part of the recording title; version labels such as
# Remix, Live, Radio Edit, Instrumental and Remaster are retained.
_FEATURE_TITLE_ANNOTATION_RE = re.compile(
    r"[\(\[]\s*(?:(?:feat(?:uring)?|ft)\.?|with)\s+([^\)\]]+)[\)\]]",
    re.IGNORECASE,
)
_FEATURE_SUFFIX_RE = re.compile(
    r"\s+(?:feat(?:uring)?|ft)\.?\s+.+$",
    re.IGNORECASE,
)
_ARTIST_FEATURE_RE = re.compile(
    r"\s+(?:feat(?:uring)?|ft)\.?\s+(.+)$",
    re.IGNORECASE,
)

def split_featured_artist(artist: Any) -> tuple[str, list[str]]:
    """Split an explicit featured-artist suffix from the lead artist credit.

    Collaboration separators without an explicit feat./ft. marker are preserved:
    'A & B' can be a jointly billed act and must not be guessed into a solo lead.
    """
    value = display_text(artist, "")
    match = _ARTIST_FEATURE_RE.search(value)
    if not match:
        return value, []
    lead = value[:match.start()].strip()
    guests_text = match.group(1).strip()
    guests = [
        display_text(part, "")
        for part in re.split(r"\s*(?:,|&)\s*", guests_text, flags=re.IGNORECASE)
    ]
    return lead or value, [guest for guest in guests if guest]


def featured_artists_in_title(title: Any) -> list[str]:
    """Extract explicit featured-credit annotations wherever they appear in a title."""
    value = display_text(title, "")
    guests: list[str] = []
    for match in _FEATURE_TITLE_ANNOTATION_RE.finditer(value):
        guests.extend(
            display_text(part, "")
            for part in re.split(r"\s*(?:,|&)\s*", match.group(1))
        )
    suffix = _FEATURE_SUFFIX_RE.search(value)
    if suffix:
        guests.extend(
            display_text(part, "")
            for part in re.split(r"\s*(?:,|&)\s*", suffix.group(0).strip().split(None, 1)[1])
        )
    unique: list[str] = []
    for guest in guests:
        if guest and normalize_text(guest) not in {normalize_text(x) for x in unique}:
            unique.append(guest)
    return unique

def canonical_track_title(title: Any) -> str:
    """Remove featured-credit annotations while preserving recording/version labels."""
    original = display_text(title, "Unknown Track")
    value = _FEATURE_TITLE_ANNOTATION_RE.sub("", original)
    value = _FEATURE_SUFFIX_RE.sub("", value).strip()
    value = _SPACE_RE.sub(" ", value).strip(" -–—")
    return value or original
