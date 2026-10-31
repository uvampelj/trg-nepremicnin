"""Download the raw GURS exports into data/raw, skipping files already present."""
from __future__ import annotations

import json
from pathlib import Path

from pipeline.sources import SALES, VALUATION, download, file_info, sales_years

RAW = Path("data/raw")


def fetch(product: tuple[int, int], target: Path, year: int | None = None) -> dict:
    info = file_info(product, year)
    marker = target.with_suffix(".json")
    if target.exists() and marker.exists() and json.loads(marker.read_text())["name"] == info["name"]:
        print(f"have {info['name']}", flush=True)
        return info
    print(f"get  {info['name']} ({info['size'] / 1e6:.0f} MB)", flush=True)
    download(product, target, year)
    marker.write_text(json.dumps(info))
    return info


def main() -> None:
    for year in sales_years():
        fetch(SALES, RAW / f"kpp_{year}.zip", year)
    fetch(VALUATION, RAW / "ev.zip")


if __name__ == "__main__":
    main()
