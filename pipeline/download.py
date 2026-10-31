"""Download the yearly sales exports into data/raw, skipping files already present."""
from __future__ import annotations

import json
from pathlib import Path

from pipeline.sources import SALES, fetch, file_info, sales_years

RAW = Path("data/raw")


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for year in sales_years():
        target = RAW / f"kpp_{year}.zip"
        marker = target.with_suffix(".json")
        info = file_info(SALES, year)
        if target.exists() and marker.exists() and json.loads(marker.read_text())["name"] == info["name"]:
            print(f"have {info['name']}", flush=True)
            continue
        print(f"get  {info['name']} ({info['size'] / 1e6:.1f} MB)", flush=True)
        target.write_bytes(fetch(SALES, year))
        marker.write_text(json.dumps(info))


if __name__ == "__main__":
    main()
