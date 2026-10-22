import os

VAULT_DIR = "vault"
required_files = ["artists.json", "albums.json", "tracks.json", "listening_history.jsonl", "manifest.json"]

def validate():
    for file in required_files:
        if not os.path.exists(os.path.join(VAULT_DIR, file)):
            raise FileNotFoundError(f"Validation failed: Missing {file} in vault/")
    print("Vault validation passed.")

if __name__ == "__main__":
    validate()
