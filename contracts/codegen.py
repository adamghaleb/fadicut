"""
Contract codegen — the mechanism that lets parallel agents build against one frozen
interface without colliding.

  Pydantic models  ──►  JSON Schema  ──►  TypeScript types

Run:  python codegen.py [--ts-out <dir>]

Emits:
  • dist/song_context.schema.json
  • dist/fadi_edl.schema.json
  • <ts-out>/fadi-contracts.d.ts   (if json-schema-to-typescript / quicktype available)

The JSON Schema is the portable artifact; the TS file is convenience. If no TS codegen
tool is installed it still writes the schemas and prints the command to finish the TS.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path

from fadi_contracts import FadiEDL, SongContext

HERE = Path(__file__).parent
DIST = HERE / "dist"


def write_schemas() -> dict[str, Path]:
    DIST.mkdir(exist_ok=True)
    out: dict[str, Path] = {}
    for name, model in {"song_context": SongContext, "fadi_edl": FadiEDL}.items():
        p = DIST / f"{name}.schema.json"
        p.write_text(json.dumps(model.model_json_schema(), indent=2))
        out[name] = p
        print(f"  ✓ {p.relative_to(HERE)}")
    return out


def try_ts(schemas: dict[str, Path], ts_out: Path) -> None:
    tool = shutil.which("json2ts") or shutil.which("quicktype")
    if not tool:
        print(
            "\n  TS codegen tool not found. To finish TS types, run one of:\n"
            "    npx json-schema-to-typescript dist/*.schema.json -o <out>\n"
            "    npx quicktype dist/fadi_edl.schema.json -o <out>/fadi-edl.ts\n"
        )
        return
    ts_out.mkdir(parents=True, exist_ok=True)
    for name, schema in schemas.items():
        dest = ts_out / f"{name}.ts"
        if "json2ts" in tool:
            subprocess.run([tool, "-i", str(schema), "-o", str(dest)], check=True)
        else:
            subprocess.run([tool, str(schema), "-o", str(dest)], check=True)
        print(f"  ✓ {dest}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ts-out", type=Path, default=None, help="Directory to emit TS types into.")
    args = ap.parse_args()

    print("Emitting JSON Schema from Pydantic contracts:")
    schemas = write_schemas()
    if args.ts_out:
        print("\nEmitting TypeScript:")
        try_ts(schemas, args.ts_out)
    print("\nContract version:", SongContext().schema_version if False else "see model defaults")


if __name__ == "__main__":
    main()
