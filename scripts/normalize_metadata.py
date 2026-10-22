import re
import hashlib
import unicodedata

def normalize_text(text: str) -> str:
    if not text:
        return ""
    # Normalize unicode (e.g., matching 'Beyoncé' to 'Beyonce')
    text = unicodedata.normalize('NFKD', text).encode('ASCII', 'ignore').decode('utf-8')
    # Lowercase, strip punctuation and extra whitespace
    text = text.lower()
    text = re.sub(r'[^\w\s]', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def generate_deterministic_id(entity_type: str, *identity_parts) -> str:
    """Generates a stable SHA-256 ID based on normalized core metadata."""
    normalized_parts = [normalize_text(str(p)) for p in identity_parts]
    raw_identity = f"{entity_type}:{':'.join(normalized_parts)}"
    return hashlib.sha256(raw_identity.encode('utf-8')).hexdigest()[:24]
