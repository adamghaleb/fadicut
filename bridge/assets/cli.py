"""``python -m assets.cli`` — operate the asset catalog from the shell.

    python -m assets.cli index [--force]    walk roots → catalog (incremental / full)
    python -m assets.cli roots              list configured roots + online status
    python -m assets.cli search <q>         quick search
    python -m assets.cli proxies [--limit N] backfill proxies for indexed assets
    python -m assets.cli stats              catalog counts

Handy for first-run warm-up and debugging without the HTTP server. Run from the
``bridge/`` dir (so the ``assets`` package is importable).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from .catalog import get_catalog
from .proxy import ensure_proxy
from .roots import get_roots


def _cmd_index(args: argparse.Namespace) -> int:
    stats = get_catalog().index_roots(force=args.force)
    print(json.dumps(stats.public(), indent=2))
    return 0


def _cmd_roots(_: argparse.Namespace) -> int:
    for r in get_roots():
        flag = "ONLINE " if r.online else "offline"
        print(f"[{flag}] {r.label:<28} {r.kind:<8} {r.path}")
    return 0


def _cmd_search(args: argparse.Namespace) -> int:
    items, total = get_catalog().search(q=args.query, limit=args.limit)
    print(f"{total} match(es); showing {len(items)}")
    for it in items:
        dur = f"{it['duration']:.1f}s" if it.get("duration") else "-"
        alpha = "α" if it.get("has_alpha") else " "
        print(f"  {alpha} {it['kind']:<6} {dur:>7}  {it['name']}")
    return 0


def _cmd_proxies(args: argparse.Namespace) -> int:
    cat = get_catalog()
    items, _ = cat.search(limit=args.limit, include_missing=False)
    built = 0
    for it in items:
        if it.get("proxy_path") or it["kind"] == "unknown":
            continue
        p = ensure_proxy(it["path"], it["content_hash"], it["kind"])
        if p:
            cat.set_proxy(it["path"], p)
            built += 1
            print(f"  proxy: {it['name']}")
    print(f"built {built} prox(ies)")
    return 0


def _cmd_stats(_: argparse.Namespace) -> int:
    cat = get_catalog()
    print(json.dumps({"total": cat.count(), "roots": cat.root_status()}, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="assets.cli")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("index", help="walk roots into the catalog")
    pi.add_argument("--force", action="store_true", help="re-probe + re-hash every file")
    pi.set_defaults(fn=_cmd_index)

    sub.add_parser("roots", help="list roots + online status").set_defaults(fn=_cmd_roots)

    ps = sub.add_parser("search", help="quick substring search")
    ps.add_argument("query")
    ps.add_argument("--limit", type=int, default=40)
    ps.set_defaults(fn=_cmd_search)

    pp = sub.add_parser("proxies", help="backfill proxies")
    pp.add_argument("--limit", type=int, default=200)
    pp.set_defaults(fn=_cmd_proxies)

    sub.add_parser("stats", help="catalog counts").set_defaults(fn=_cmd_stats)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
