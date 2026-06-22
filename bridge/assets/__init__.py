"""Asset serving + catalog.

Batch A ships the range-media streamer; batch E (this batch) adds the SQLite catalog,
incremental indexer, content-hash-keyed proxies, a filesystem watcher, and the
search/filter/tag REST router.

Integrator wiring (kept out of shared files per scope discipline):
    from assets import assets_router, get_watcher
    app.include_router(assets_router)              # in bridge/app.py
    get_watcher().start() / .stop()                # in the lifespan
"""

from .api import assets_router
from .catalog import AssetCatalog, get_catalog
from .media import open_range_response
from .proxy import ensure_proxy, proxy_dir
from .roots import AssetRoot, get_roots, online_roots
from .watcher import AssetWatcher, get_watcher

__all__ = [
    "open_range_response",
    "assets_router",
    "AssetCatalog",
    "get_catalog",
    "AssetWatcher",
    "get_watcher",
    "AssetRoot",
    "get_roots",
    "online_roots",
    "ensure_proxy",
    "proxy_dir",
]
