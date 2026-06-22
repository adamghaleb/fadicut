#!/usr/bin/env python3
"""Out-of-venv beat-detection worker.

The bridge venv intentionally has no numpy. snippet-selector's `analyze_beats.py`
(numpy-only spectral-flux onset → comb-filter tempo → phase-aligned grid → 4/4
downbeat pick) is the authoritative beat detector for FadiFiles tracks, so we run
it as a subprocess under a Python that *does* have numpy and capture its JSON.

This file is the subprocess entrypoint. It is invoked as::

    <python-with-numpy> _detect_worker.py <abs-audio-path>

and prints a single JSON object to stdout:

    {"bpm": float, "duration": float, "beats": [t...], "downbeats": [t...]}

It reuses `analyze_beats.analyze(path)` verbatim — no algorithm is reimplemented
here. The snippet-selector dir is injected on sys.path so its `album` import (used
only by analyze_beats' `main()`, not `analyze()`) resolves cleanly.
"""
from __future__ import annotations

import json
import os
import sys

SNIPPET_SELECTOR_DIR = os.environ.get(
    "FADI_SNIPPET_SELECTOR_DIR",
    os.path.expanduser("~/Documents/windsurf projects/snippet-selector"),
)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"error": "usage: _detect_worker.py <audio-path>"}))
        return 2
    audio_path = argv[1]
    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"audio not found: {audio_path}"}))
        return 3

    sys.path.insert(0, SNIPPET_SELECTOR_DIR)
    try:
        import analyze_beats  # noqa: E402  (path injected above)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"cannot import analyze_beats: {type(exc).__name__}: {exc}"}))
        return 4

    try:
        data = analyze_beats.analyze(audio_path)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"analyze failed: {type(exc).__name__}: {exc}"}))
        return 5

    print(json.dumps(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
