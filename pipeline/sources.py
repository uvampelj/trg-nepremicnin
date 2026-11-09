"""Access to the public GURS JGP download API (no registration needed)."""
from __future__ import annotations

import http.client
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

ROOT = "https://ipi.eprostor.gov.si/jgp-service-api"
API = f"{ROOT}/display-views/groups"
FIRST_YEAR = 2010   # 2007-2009 exist but are far from complete

# (display group, composite product) as listed by /display-views/groups/{id}/composite-products
SALES = (127, 321)       # Kupoprodajni posli za območje Slovenije po letih
VALUATION = (363, 362)   # Evidenca vrednotenja za območje občine

COUNTRY = ("DRZAVA", 1)
HEADERS = {"User-Agent": "kataster-cen (+https://github.com/uvampelj/trg-nepremicnin)"}


def _open(url: str, timeout: int):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout)


def closed(error: BaseException) -> bool:
    """GURS answers 403 while it keeps a service shut, as after its security stop of November 2026."""
    return getattr(error, "code", None) == 403


def _get_json(url: str, tries: int = 6) -> dict | list:
    for attempt in range(tries):
        try:
            with _open(url, 60) as resp:
                return json.load(resp)
        except OSError as error:
            # 404 is an answer, and waiting does not reopen a closed service.
            if attempt == tries - 1 or getattr(error, "code", None) == 404 or closed(error):
                raise
            # The server resets connections under load and needs a real pause.
            time.sleep(30 * (attempt + 1))
    raise AssertionError


def _url(product: tuple[int, int], endpoint: str, where: tuple[str, int | str], year: int | None) -> str:
    query = {"filterParam": where[0], "filterValue": where[1]}
    if year is not None:
        query["filterYear"] = year
    return f"{API}/{product[0]}/composite-products/{product[1]}/{endpoint}?{urllib.parse.urlencode(query)}"


def file_info(product: tuple[int, int], year: int | None = None, where: tuple[str, int | str] = COUNTRY) -> dict:
    """Name and size of the currently published file, without downloading it."""
    meta = _get_json(_url(product, "result", where, year))
    if meta.get("statusText") != "OK":
        raise RuntimeError(f"GURS result status for {product}/{where}/{year}: {meta.get('statusText')}")
    name = meta["file"]["name"]
    stamp = re.search(r"(\d{8})\.zip$", name)
    if not stamp:
        raise RuntimeError(f"Unexpected GURS file name: {name}")
    return {"name": name, "size": meta["fileSize"], "date": stamp.group(1)}


def fetch(product: tuple[int, int], year: int | None = None, where: tuple[str, int | str] = COUNTRY,
          tries: int = 5) -> bytes:
    """Download a published file. The link is single-use, so every attempt asks for a new one."""
    for attempt in range(tries):
        try:
            expected = file_info(product, year, where)["size"]
            link = _get_json(_url(product, "file", where, year))["url"]
            with _open(link, 300) as resp:
                data = resp.read()
            # A cut connection can end a stream early without raising anything.
            if len(data) != expected:
                raise OSError(f"short download: {len(data)} of {expected} bytes")
            return data
        except (OSError, http.client.HTTPException) as error:
            if attempt == tries - 1 or closed(error):
                raise
            time.sleep(20 * (attempt + 1))
    raise AssertionError


def municipalities() -> list[str]:
    return [m["sifra"] for m in _get_json(f"{ROOT}/municipalities")]


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
    """Fingerprint of the sales exports the site is built from."""
    return {str(year): file_info(SALES, year) for year in sales_years()}
