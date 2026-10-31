"""Decide whether the site needs a rebuild: new sales exports or a new valuation lookup.

Prints changed=true|false, and appends it to $GITHUB_OUTPUT in Actions.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from pipeline.sources import remote_versions

STATUS = Path("status/latest.json")
VALUATION = Path("data/valuation/valuation.json")


def main() -> None:
    remote = remote_versions()
    if VALUATION.exists():
        remote["valuation"] = json.loads(VALUATION.read_text(encoding="utf8"))
    local = json.loads(STATUS.read_text(encoding="utf8"))["sources"] if STATUS.exists() else {}
    changed = {k: v["name"] for k, v in remote.items() if local.get(k, {}).get("name") != v["name"]}
    print(f"changed={'true' if changed else 'false'}")
    for key, name in changed.items():
        print(f"  {key}: {name}")
    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a", encoding="utf8") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")


if __name__ == "__main__":
    main()
