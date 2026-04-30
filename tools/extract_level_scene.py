"""Extract the inner three.js `scene` object from a Rogue Engine .rogueScene
file and write it as a standalone .json file usable by the three.js editor.

Usage: python tools/extract_level_scene.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "LevelEditor", "LevelScene.rogueScene")
DST = os.path.join(ROOT, "assets", "LevelEditor", "LevelScene.json")

print(f"Reading {SRC} ...")
with open(SRC, "r", encoding="utf-8") as f:
    wrapper = json.load(f)

scene = wrapper.get("scene")
if not scene or "object" not in scene:
    raise SystemExit("Input file has no .scene with .object — not a Rogue scene wrapper.")

print(f"Writing {DST} ...")
with open(DST, "w", encoding="utf-8") as f:
    json.dump(scene, f)

src_size = os.path.getsize(SRC)
dst_size = os.path.getsize(DST)
print(f"Done. {src_size:,} bytes -> {dst_size:,} bytes")
