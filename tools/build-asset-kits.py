"""Regenerate data/assetKits.json — the static asset-kit manifest.

The game (js/arena.js) maps each custom-prop GLB's bare filename to the kit
folder it lives in. serve.py used to compute this on the fly at /api/asset-kits,
but that endpoint only exists while the dev server runs. On static hosting
(Sandscape) there is no server, so the manifest must be a plain file fetched
via a relative path. Run this script after adding/removing/moving kit GLBs:

    python tools/build-asset-kits.py

It writes { "<filename>.glb": "<kit_folder>", ... } sorted by filename. When a
filename exists in more than one kit, the later folder in KIT_FOLDERS wins
(matching serve.py's old behavior) and a warning is printed.
"""
import json
import os

# Folders under assets/ that hold custom-prop GLBs. Keep in sync with the
# kit folders the level editor offers. Order matters for collisions: later
# wins (same precedence serve.py used).
KIT_FOLDERS = ("CorridorKit", "arenaKit")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def build_manifest() -> dict:
    manifest = {}
    for kit in KIT_FOLDERS:
        kit_dir = os.path.join(_ROOT, "assets", kit)
        if not os.path.isdir(kit_dir):
            print(f"  [asset-kits] skipping missing folder assets/{kit}")
            continue
        for name in sorted(os.listdir(kit_dir)):
            if not name.lower().endswith(".glb"):
                continue
            if name in manifest and manifest[name] != kit:
                print(f"  [asset-kits] WARNING: {name} exists in both "
                      f"{manifest[name]} and {kit}; using {kit}.")
            manifest[name] = kit
    return manifest


def main() -> None:
    manifest = build_manifest()
    out_path = os.path.join(_ROOT, "data", "assetKits.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"Wrote {os.path.relpath(out_path, _ROOT)} with {len(manifest)} entries")


if __name__ == "__main__":
    main()
