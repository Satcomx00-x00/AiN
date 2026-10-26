"""Prints {crate folder: checksum} for a vendor folder, as JSON: the package checksum from
.cargo-checksum.json, or the file's own SHA-256 when there is none (git dependencies). Must match
crateSum() in lib/stage.ts. A folder without the file (a half-sent crate) gets "" so it's replaced."""
import hashlib
import json
import os
import sys

root = os.path.expanduser(sys.argv[1])
sums = {}
if os.path.isdir(root):
    for name in os.listdir(root):
        path = os.path.join(root, name, ".cargo-checksum.json")
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError:
            sums[name] = ""
            continue
        sums[name] = json.loads(raw).get("package") or hashlib.sha256(raw).hexdigest()
print(json.dumps(sums))
