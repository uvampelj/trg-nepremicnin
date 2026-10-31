"""Access to the public GURS JGP download API (no registration needed)."""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

API = "https://ipi.eprostor.gov.si/jgp-service-api/display-views/groups"
FIRST_YEAR = 2020

# (display group, composite product) as listed by /display-views/groups/{id}/composite-products
SALES = (127, 321)       # Kupoprodajni posli za območje Slovenije po letih
VALUATION = (361, 361)   # Evidenca vrednotenja za območje Slovenije


def _get_json(url: str, tries: int = 4) -> dict:
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                return json.load(resp)
        except OSError as error:
            if attempt == tries - 1 or getattr(error, "code", None) == 404:
                raise
            time.sleep(15 * (attempt + 1))
    raise AssertionError


def _url(product: tuple[int, int], endpoint: str, year: int | None) -> str:
    query = {"filterParam": "DRZAVA", "filterValue": 1}
    if year is not None:
        query["filterYear"] = year
    return f"{API}/{product[0]}/composite-products/{product[1]}/{endpoint}?{urllib.parse.urlencode(query)}"


def file_info(product: tuple[int, int], year: int | None = None) -> dict:
    """Name and size of the currently published file, without downloading it."""
    meta = _get_json(_url(product, "result", year))
    if meta.get("statusText") != "OK":
        raise RuntimeError(f"GURS result status for {product}/{year}: {meta.get('statusText')}")
    name = meta["file"]["name"]
    stamp = re.search(r"(\d{8})\.zip$", name)
    if not stamp:
        raise RuntimeError(f"Unexpected GURS file name: {name}")
    return {"name": name, "size": meta["fileSize"], "date": stamp.group(1)}


def download(product: tuple[int, int], dest: Path, year: int | None = None, tries: int = 4) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    for attempt in range(tries):
        try:
            link = _get_json(_url(product, "file", year))["url"]
            with urllib.request.urlopen(link, timeout=600) as resp, tmp.open("wb") as out:
                while chunk := resp.read(1 << 20):
                    out.write(chunk)
            tmp.replace(dest)
            return
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(30 * (attempt + 1))


def sales_years() -> list[int]:
    """Published years. A new year's export only appears with its first sales."""
    this_year = date.today().year
    years = list(range(FIRST_YEAR, this_year))
    try:
        file_info(SALES, this_year)
        years.append(this_year)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    return years


def remote_versions() -> dict:
    """Fingerprint of everything the site is built from."""
    versions = {str(y): file_info(SALES, y) for y in sales_years()}
    versions["valuation"] = file_info(VALUATION)
    return versions
