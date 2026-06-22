"""Filesystem watcher that keeps the asset catalog live.

Two implementations, auto-selected at runtime:

  * **watchdog** (if installed): native FS events per online root, debounced.
  * **polling fallback**: a background thread that re-runs the incremental
    ``index_roots`` on an interval. Cheap because indexing skips unchanged
    (size, mtime) rows without re-probing or re-hashing.

Either way the watcher also runs a periodic full incremental sweep so that a root
coming back **online** (the Seagate drive remounting) is picked up even when no FS
event fires. Start/stop are idempotent; the watcher owns no event loop and is safe to
run from the FastAPI lifespan in a thread.
"""

from __future__ import annotations

import logging
import threading
import time

from .catalog import AssetCatalog, get_catalog
from .proxy import ensure_proxy
from .roots import get_roots

log = logging.getLogger("fadi.bridge.assets.watcher")

try:  # optional native FS events
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    _HAS_WATCHDOG = True
except Exception:  # noqa: BLE001
    _HAS_WATCHDOG = False
    FileSystemEventHandler = object  # type: ignore


class AssetWatcher:
    def __init__(
        self,
        catalog: AssetCatalog | None = None,
        *,
        poll_interval: float = 30.0,
        full_sweep_interval: float = 120.0,
        build_proxies: bool = True,
    ) -> None:
        self.catalog = catalog or get_catalog()
        self.poll_interval = poll_interval
        self.full_sweep_interval = full_sweep_interval
        self.build_proxies = build_proxies
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._observer = None
        self._last_full_sweep = 0.0
        self.backend = "watchdog" if _HAS_WATCHDOG else "poll"

    # ── public lifecycle ─────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="fadi-asset-watcher", daemon=True)
        self._thread.start()
        log.info("asset watcher started (backend=%s)", self.backend)

    def stop(self) -> None:
        self._stop.set()
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=5.0)
            except Exception:  # noqa: BLE001
                pass
            self._observer = None
        if self._thread:
            self._thread.join(timeout=5.0)
            self._thread = None
        log.info("asset watcher stopped")

    # ── proxy backfill (best-effort, low priority) ────────────────────────────
    def _backfill_proxies(self, limit: int = 8) -> None:
        if not self.build_proxies:
            return
        rows, _ = self.catalog.search(
            kind=None, include_missing=False, limit=limit, sort="indexed_at", order="desc"
        )
        for r in rows:
            if self._stop.is_set():
                return
            if r.get("proxy_path") or r["kind"] == "unknown":
                continue
            p = ensure_proxy(r["path"], r["content_hash"], r["kind"])
            if p:
                self.catalog.set_proxy(r["path"], p)

    # ── core loop ────────────────────────────────────────────────────────────
    def _run(self) -> None:
        # Initial sweep so the catalog is warm right after startup.
        try:
            self.catalog.index_roots()
            self._last_full_sweep = time.time()
            self._backfill_proxies()
        except Exception as e:  # noqa: BLE001
            log.warning("initial asset sweep failed: %s", e)

        if _HAS_WATCHDOG:
            self._run_watchdog()
        else:
            self._run_poll()

    def _run_poll(self) -> None:
        while not self._stop.wait(self.poll_interval):
            try:
                self.catalog.index_roots()
                self._last_full_sweep = time.time()
                self._backfill_proxies()
            except Exception as e:  # noqa: BLE001
                log.warning("poll sweep failed: %s", e)

    def _run_watchdog(self) -> None:
        watcher = self

        class _Handler(FileSystemEventHandler):  # type: ignore[misc]
            def on_any_event(self, event):  # noqa: ANN001
                if getattr(event, "is_directory", False):
                    return
                watcher._debounce_resync()

        self._observer = Observer()
        scheduled = False
        for root in get_roots():
            if root.online:
                try:
                    self._observer.schedule(_Handler(), str(root.path), recursive=root.recursive)
                    scheduled = True
                except Exception as e:  # noqa: BLE001
                    log.warning("could not watch %s: %s", root.path, e)
        if scheduled:
            self._observer.start()

        # Even with FS events, periodically re-evaluate roots (drive remount detection).
        while not self._stop.wait(self.full_sweep_interval):
            try:
                self.catalog.index_roots()
                self._last_full_sweep = time.time()
                self._backfill_proxies()
            except Exception as e:  # noqa: BLE001
                log.warning("periodic sweep failed: %s", e)

    # Debounced resync used by watchdog events.
    _debounce_timer: threading.Timer | None = None
    _debounce_lock = threading.Lock()

    def _debounce_resync(self, delay: float = 3.0) -> None:
        with self._debounce_lock:
            if self._debounce_timer is not None:
                self._debounce_timer.cancel()
            self._debounce_timer = threading.Timer(delay, self._do_resync)
            self._debounce_timer.daemon = True
            self._debounce_timer.start()

    def _do_resync(self) -> None:
        try:
            self.catalog.index_roots()
            self._backfill_proxies()
        except Exception as e:  # noqa: BLE001
            log.warning("debounced resync failed: %s", e)


# ── module singleton ─────────────────────────────────────────────────────────
_watcher: AssetWatcher | None = None


def get_watcher() -> AssetWatcher:
    global _watcher
    if _watcher is None:
        _watcher = AssetWatcher()
    return _watcher
