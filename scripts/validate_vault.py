import os
import json

VAULT_DIR = "vault"
required_files = [
    "artists.json", 
    "albums.json", 
    "ineligible_releases.json", 
    "tracks.json", 
    "listening_history.jsonl", 
    "manifest.json"
]

def validate():
    for file in required_files:
        filepath = os.path.join(VAULT_DIR, file)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Validation failed: Missing {file} in vault/")
    
    # Ensure minimum 3 tracks rule is applied in the generated data
    with open(os.path.join(VAULT_DIR, "manifest.json"), "r") as f:
        manifest = json.load(f)
        if manifest.get("settings", {}).get("MIN_ALBUM_TRACKS") != 3:
            raise ValueError("Manifest MIN_ALBUM_TRACKS is not set to 3.")
            
    print("Vault validation passed.")

if __name__ == "__main__":
    validate()
