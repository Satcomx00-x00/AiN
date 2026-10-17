#!/usr/bin/env python3
"""Checks a release's update manifest before installed apps can see it.

Fails unless `latest.json`:
- announces the version being released;
- has an entry for every required platform;
- points each entry at a file of the release (found in the assets folder);
- carries, for each, a signature that verifies against the app's public key.

Signatures are minisign's (what `tauri signer` makes), base64-encoded once more by Tauri.

Entries point at a file either by name (`…/releases/download/<tag>/<name>`) or, as tauri-action
writes them when uploading to a draft, by asset id
(`https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`, which the updater downloads
with `Accept: application/octet-stream`). For those, set ASSET_IDS to a JSON file mapping each
asset id to its file name.

Usage: check-update-manifest.py MANIFEST ASSETS_DIR PUBKEY_FILE_OR_TAURI_CONF VERSION PLATFORM...
Needs the `cryptography` package.
"""

import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def lines(tauri_b64: str) -> list[str]:
    """A Tauri key or signature: base64 of minisign's text file."""
    return base64.b64decode(tauri_b64).decode().splitlines()


def public_key(tauri_b64: str) -> tuple[bytes, Ed25519PublicKey]:
    raw = base64.b64decode(lines(tauri_b64)[1])
    if len(raw) != 42 or raw[:2] != b"Ed":
        raise ValueError("not a minisign Ed25519 public key")
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:])


def verify(data: bytes, tauri_sig: str, key_id: bytes, key: Ed25519PublicKey) -> None:
    sig_lines = lines(tauri_sig)
    raw = base64.b64decode(sig_lines[1])
    algorithm, sig_key_id, signature = raw[:2], raw[2:10], raw[10:]
    if sig_key_id != key_id:
        raise ValueError(f"signed by key {sig_key_id.hex()}, the app trusts {key_id.hex()}")
    # "ED": the file's BLAKE2b-512 is what was signed (minisign's default); "Ed": the file itself.
    message = hashlib.blake2b(data, digest_size=64).digest() if algorithm == b"ED" else data
    key.verify(signature, message)
    trusted = sig_lines[2].removeprefix("trusted comment: ").encode()
    key.verify(base64.b64decode(sig_lines[3]), signature + trusted)


API_ASSET = re.compile(r"^https://api\.github\.com/repos/[^/]+/[^/]+/releases/assets/(\d+)$")


def file_name(url: str, asset_ids: dict[str, str]) -> str | None:
    """The release file an entry's URL points at; None for an asset id that names no file."""
    if match := API_ASSET.match(url):
        return asset_ids.get(match.group(1))
    return unquote(Path(urlparse(url).path).name)


def load_pubkey(path: Path) -> str:
    text = path.read_text().strip()
    if path.suffix == ".json":
        return json.loads(text)["plugins"]["updater"]["pubkey"]
    return text


def main(manifest_path: str, assets: str, pubkey_path: str, version: str, *platforms: str) -> int:
    manifest = json.loads(Path(manifest_path).read_text())
    key_id, key = public_key(load_pubkey(Path(pubkey_path)))
    errors = []
    ids_file = os.environ.get("ASSET_IDS")
    asset_ids = {str(k): v for k, v in json.loads(Path(ids_file).read_text()).items()} if ids_file else {}

    if manifest.get("version") != version:
        errors.append(f"announces version {manifest.get('version')!r}, releasing {version!r}")
    entries = manifest.get("platforms", {})
    for missing in sorted(set(platforms) - entries.keys()):
        errors.append(f"{missing}: no entry, so those apps won't update")

    for target, entry in sorted(entries.items()):
        name = file_name(entry["url"], asset_ids)
        if name is None:
            errors.append(f"{target}: {entry['url']} is an asset id that names none of the release's files")
            continue
        file = Path(assets) / name
        if not file.is_file():
            errors.append(f"{target}: {name} is not among the release's files")
            continue
        try:
            verify(file.read_bytes(), entry["signature"], key_id, key)
            print(f"ok  {target}: {name}")
        except (InvalidSignature, ValueError) as e:
            errors.append(f"{target}: {name}: bad signature ({e or 'does not match the file'})")

    for error in errors:
        print(f"::error::latest.json: {error}")
    return 1 if errors else 0


if __name__ == "__main__":
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))
