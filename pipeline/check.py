"""Decide whether the site needs a rebuild: new sales exports or a new valuation lookup.

Prints changed=true|false, and appends it to $GITHUB_OUTPUT in Actions.
"""
from __future__ import annotations

import http.client
import json
import os
from datetime import date, datetime
from pathlib import Path

from pipeline.sources import remote_versions

STATUS = Path("status/latest.json")
VALUATION = Path("data/valuation/valuation.json")
# GURS can be down for days. Until the published data is this old the site simply keeps it,
# so a short outage does not fail every daily run; a longer one must not go unnoticed.
STALE_DAYS = 21


def report(changed: bool, note: str = "", reachable: bool = True) -> None:
    print(f"changed={'true' if changed else 'false'}")
    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a", encoding="utf8") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
            f.write(f"reachable={'true' if reachable else 'false'}\n")
    if note and (summary := os.environ.get("GITHUB_STEP_SUMMARY")):
        with open(summary, "a", encoding="utf8") as f:
            f.write(note + "\n")


def unreachable(error: BaseException, status: dict | None) -> None:
    stamp = status["summary"]["etnDate"] if status else None
    age = (date.today() - datetime.strptime(stamp, "%Y%m%d").date()).days if stamp else None
    note = f"GURS ni dosegljiv ({error}). Stran ostaja na podatkih ETN z dne {stamp}, starih {age} dni."
    if age is None or age > STALE_DAYS:
        print(f"::error::{note}")
        raise SystemExit(1)
    print(f"::warning::{note}")
    report(False, note, reachable=False)


def main() -> None:
    status = json.loads(STATUS.read_text(encoding="utf8")) if STATUS.exists() else None
    try:
        remote = remote_versions()
    except (OSError, http.client.HTTPException) as error:
        unreachable(error, status)
        return
    if VALUATION.exists():
        remote["valuation"] = json.loads(VALUATION.read_text(encoding="utf8"))
    local = status["sources"] if status else {}
    changed = {k: v["name"] for k, v in remote.items() if local.get(k, {}).get("name") != v["name"]}
    report(bool(changed))
    for key, name in changed.items():
        print(f"  {key}: {name}")


if __name__ == "__main__":
    main()
