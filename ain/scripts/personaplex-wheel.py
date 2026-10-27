"""Builds the wheel of NVIDIA's `moshi-personaplex` that the app bundles, so installing PersonaPlex on
a user's computer clones nothing: only its dependencies (torch…) come from PyPI.

The wheel is made here from the source archive of the pinned commit (checked against its SHA-256),
with the standard library alone: no build backend runs. It holds what setuptools would put in it
(the `moshi` package's modules, its metadata and license), and the same input always gives the same
bytes. Run it again after changing COMMIT, then update ARCHIVE_SHA256 and `PACKAGE` in
`src-tauri/src/features/persona/local.rs`:

    python -I scripts/personaplex-wheel.py
"""

import base64
import hashlib
import io
import re
import sys
import tarfile
import tomllib
import urllib.request
import zipfile
from pathlib import Path

COMMIT = "3428dfd95309a7f3c84fd93259ded0f810d1ff91"
ARCHIVE = f"https://github.com/NVIDIA/personaplex/archive/{COMMIT}.tar.gz"
# Empty after changing COMMIT: the next run prints the archive's hash to pin here.
ARCHIVE_SHA256 = "e02f1addf03d028b4fbb90f4483d559de753a580f60d8e741fec0e822dc189b7"
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "resources" / "personaplex"
# A fixed date for every entry, so the wheel's bytes depend on its contents alone.
STAMP = (2026, 1, 1, 0, 0, 0)


def fetch() -> bytes:
    with urllib.request.urlopen(ARCHIVE, timeout=120) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if ARCHIVE_SHA256 and digest != ARCHIVE_SHA256:
        sys.exit(f"the archive's SHA-256 is {digest}, not the pinned {ARCHIVE_SHA256}")
    if not ARCHIVE_SHA256:
        print(f"archive SHA-256: {digest} (pin it as ARCHIVE_SHA256)")
    return data


def sources(data: bytes) -> dict[str, bytes]:
    """The files under `moshi/` (the Python project), by their path inside it, with the
    repository's own license beside them."""
    repo = f"personaplex-{COMMIT}/"
    root = f"{repo}moshi/"
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith(root):
                files[member.name[len(root):]] = archive.extractfile(member).read()
            elif member.isfile() and member.name == f"{repo}LICENSE-MIT":
                files["LICENSE-MIT"] = archive.extractfile(member).read()
    return files


def metadata(project: dict, version: str, readme: str | None) -> str:
    lines = ["Metadata-Version: 2.1", f"Name: {project['name']}", f"Version: {version}"]
    if "description" in project:
        lines.append(f"Summary: {project['description']}")
    if "requires-python" in project:
        lines.append(f"Requires-Python: {project['requires-python']}")
    lines += [f"Requires-Dist: {dep}" for dep in project.get("dependencies", [])]
    for extra, deps in project.get("optional-dependencies", {}).items():
        lines.append(f"Provides-Extra: {extra}")
        lines += [f'Requires-Dist: {dep}; extra == "{extra}"' for dep in deps]
    text = "\n".join(lines) + "\n"
    if readme:
        text += "Description-Content-Type: text/markdown\n\n" + readme
    return text


def record_line(name: str, data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{name},sha256={digest},{len(data)}"


def build(files: dict[str, bytes]) -> Path:
    project = tomllib.loads(files["pyproject.toml"].decode())["project"]
    version = re.search(r'__version__\s*=\s*"([^"]+)"', files["moshi/__init__.py"].decode()).group(1)
    name = project["name"].replace("-", "_")
    info = f"{name}-{version}.dist-info"
    readme = files.get("README.md")
    entries = {path: data for path, data in sorted(files.items()) if path.startswith("moshi/") and path.endswith(".py")}
    # PersonaPlex's MIT license, and those of the Moshi and AudioCraft code it builds on.
    for license_name in ("LICENSE-MIT", "LICENSE.moshi", "LICENSE.audiocraft"):
        if license_name in files:
            entries[f"{info}/licenses/{license_name}"] = files[license_name]
    entries[f"{info}/METADATA"] = metadata(project, version, readme.decode() if readme else None).encode()
    entries[f"{info}/WHEEL"] = b"Wheel-Version: 1.0\nGenerator: ain personaplex-wheel.py\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    entries[f"{info}/top_level.txt"] = b"moshi\n"
    record = "\n".join(record_line(path, data) for path, data in entries.items()) + f"\n{info}/RECORD,,\n"
    entries[f"{info}/RECORD"] = record.encode()

    OUT.mkdir(parents=True, exist_ok=True)
    wheel = OUT / f"{name}-{version}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, data in entries.items():
            entry = zipfile.ZipInfo(path, STAMP)
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, data)
    return wheel


if __name__ == "__main__":
    wheel = build(sources(fetch()))
    print(f"{wheel} ({wheel.stat().st_size // 1024} KB)")
