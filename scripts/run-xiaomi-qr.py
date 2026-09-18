"""Start the Xiaomi token extractor directly in QR mode."""

from __future__ import annotations

import builtins
import runpy
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXTRACTOR = ROOT / "tools" / "xiaomi-cloud-tokens-extractor" / "token_extractor.py"
OUTPUT = ROOT / "runtime" / "xiaomi-cloud-devices.json"


original_input = builtins.input


def choose_qr(prompt: str = "") -> str:
    if prompt.strip().lower().startswith("p/q"):
        return "q"
    return original_input(prompt)


builtins.input = choose_qr
sys.argv = [
    str(EXTRACTOR),
    "-s",
    "ru",
    "--host",
    "192.168.1.108",
    "-o",
    str(OUTPUT),
]
runpy.run_path(str(EXTRACTOR), run_name="__main__")
