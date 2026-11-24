"""Take the newest data that was already built, for when GitHub cannot reach GURS.

    python -m pipeline.published https://owner.github.io/repo

GURS refuses GitHub's runners but still serves the owner's computer, which builds the data and
uploads it to the release site-data (scripts/refresh-local.ps1). The live site holds the last
deployment. Whichever was built later goes out.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

OUT = Path("web/data")
FILES = ["meta", "deals", "deals-old", "details", "details-old"]
RELEASE = "site-data"


def get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as response:
        return response.read()


def built_at(base: str) -> str:
    try:
        return json.loads(get(f"{base}/meta.json"))["generated"]
    except (OSError, ValueError, KeyError):
        return ""


def main() -> None:
    site = sys.argv[1].rstrip("/") + "/data"
    release = f"https://github.com/{os.environ['GITHUB_REPOSITORY']}/releases/download/{RELEASE}"
    stamps = {base: built_at(base) for base in (release, site)}
    base = max(stamps, key=stamps.get)
    if not stamps[base]:
        raise SystemExit("No built data found, neither in the release nor on the site")
    print(f"data from {base}, built {stamps[base]}")
    OUT.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        data = get(f"{base}/{name}.json")
        (OUT / f"{name}.json").write_bytes(data)
        print(f"{name}.json {len(data) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
