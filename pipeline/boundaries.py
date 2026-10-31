"""Rebuild web/geo from the GURS boundary exports. Needs Node (npx mapshaper).

Boundaries change rarely, so this runs by hand and the output is committed:

    python -m pipeline.boundaries
"""
from __future__ import annotations

import io
import subprocess
import tempfile
import zipfile
from pathlib import Path

from pipeline.sources import fetch

SPATIAL_UNITS = (119, 12)   # Prostorske enote
CADASTRAL = (123, 4)        # Katastrske občine
GEO = Path("web/geo")


def extract(archive: Path, member: str, target: Path) -> Path:
    """The exports are zips of zips; return the shapefile inside the named member."""
    with zipfile.ZipFile(archive) as outer:
        name = next(n for n in outer.namelist() if member in n)
        with zipfile.ZipFile(io.BytesIO(outer.read(name))) as inner:
            inner.extractall(target)
    return next(target.glob("*.shp"))


def mapshaper(source: Path, *steps: str) -> None:
    subprocess.run(
        f'npx --yes mapshaper "{source}" encoding=utf8 -proj wgs84 {" ".join(steps)}',
        shell=True, check=True,
    )


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "rpe.zip").write_bytes(fetch(SPATIAL_UNITS))
        (root / "ko.zip").write_bytes(fetch(CADASTRAL))
        municipalities = extract(root / "rpe.zip", "obcine", root / "ob")
        cadastral = extract(root / "ko.zip", "katastrske_obcine", root / "kat")

        polygons = "-simplify 12% keep-shapes planar -clean"
        mapshaper(municipalities, polygons, "-filter-fields SIFRA,NAZIV", "-rename-fields id=SIFRA,name=NAZIV",
                  f"-o {GEO / 'obcine.geojson'} format=geojson precision=0.00001")
        mapshaper(cadastral, polygons, "-filter-fields KO_ID,NAZIV", "-rename-fields id=KO_ID,name=NAZIV",
                  f"-o {GEO / 'ko.geojson'} format=geojson precision=0.00001")
        mapshaper(municipalities, "-dissolve", "-simplify 6% keep-shapes planar", "-filter-fields",
                  f"-o {GEO / 'slovenija.geojson'} format=geojson precision=0.0001")


if __name__ == "__main__":
    main()
