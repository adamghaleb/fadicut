"""`python -m bridge` — launch the Bridge bound to localhost.

Honors FADI_BRIDGE_HOST / FADI_BRIDGE_PORT and the rest of the env in config.py.
Use the run.sh wrapper for the venv + token-printing convenience.
"""

from __future__ import annotations

import logging

import uvicorn

from bridge.config import get_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    s = get_settings()
    uvicorn.run("bridge.app:app", host=s.host, port=s.port, log_level="info", reload=False)


if __name__ == "__main__":
    main()
