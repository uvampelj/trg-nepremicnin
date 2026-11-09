"""Build the lookup that compares sale prices with GURS generalised values.

    python -m pipeline.valuation              # from the per-municipality exports
    python -m pipeline.valuation --zip FILE   # from the national archive

The national archive is 1.1 GB, the server has no range requests and cuts long
transfers, so from GitHub it never arrives whole. The 212 municipal exports hold
the same records in files of at most 73 MB, each of which can be retried alone.

Writes data/valuation/{units,parcels}.parquet and valuation.json. The weekly job
publishes them as a GitHub release, which the daily site build downloads.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.csv as pacsv

from pipeline.sources import VALUATION, closed, fetch, municipalities

OUT = Path("data/valuation")
WORKERS = 3   # more than this makes the GURS server reset connections

MEMBERS = {
    "stavba": {"EID_STAVBA": pa.int64(), "KO_SIFKO": pa.int32(), "STEV_ST": pa.int64(),
               "ID_KONSTRUKCIJA": pa.int32(), "ID_TIP_STAVBE": pa.int32()},
    "del_stavbe": {"EID_DEL_STAVBE": pa.int64(), "EID_STAVBA": pa.int64(), "STEV_DST": pa.int64()},
    "del_stavbe_enota": {"EID_DEL_STAVBE": pa.int64(), "POSPLOSENA_VREDNOST": pa.float64()},
    "parcela": {"EID_PARCELA": pa.int64(), "KO_SIFKO": pa.int32(), "PARCELA": pa.string()},
    "parc_enota": {"ID_PARC_ENOTA": pa.string(), "EID_PARCELA": pa.int64(), "POSPLOSENA_VREDNOST": pa.float64()},
}
CODE_LISTS = {"construction": ("SIF_KONSTRUKCIJA", "ID_KONSTRUKCIJA"), "buildingTypes": ("SIF_TIP_STAVBE", "ID_TIP_STAVBE")}


def read_member(z: zipfile.ZipFile, part: str) -> pa.Table:
    name = next(n for n in z.namelist() if f"VREDNOTENJA_{part}_2" in n)
    with z.open(name) as f:
        return pacsv.read_csv(
            f,
            read_options=pacsv.ReadOptions(block_size=1 << 25),
            convert_options=pacsv.ConvertOptions(include_columns=list(MEMBERS[part]), column_types=MEMBERS[part]),
        )


def read_archive(z: zipfile.ZipFile) -> dict[str, pa.Table]:
    return {part: read_member(z, part) for part in MEMBERS}


def read_codes(z: zipfile.ZipFile) -> dict[str, dict[str, str]]:
    names = {}
    for label, (part, key) in CODE_LISTS.items():
        member = next(n for n in z.namelist() if part in n)
        codes = pd.read_csv(io.BytesIO(z.read(member)), encoding="utf-8-sig", dtype=str, keep_default_na=False)
        names[label] = dict(zip(codes[key], codes["NAZIV"]))
    return names


def fetch_municipality(code: str) -> tuple[dict[str, pa.Table], dict, str]:
    data = fetch(VALUATION, where=("OBCINE", code))
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        stamp = re.search(r"(\d{8})\.csv$", z.namelist()[0]).group(1)
        return read_archive(z), read_codes(z), stamp


def from_municipalities() -> tuple[dict[str, pd.DataFrame], dict, str]:
    codes = municipalities()
    parts: dict[str, list[pa.Table]] = {part: [] for part in MEMBERS}
    names, stamps = {}, set()
    with ThreadPoolExecutor(WORKERS) as pool:
        for done, (tables, names, stamp) in enumerate(pool.map(fetch_municipality, codes), start=1):
            stamps.add(stamp)
            for part, table in tables.items():
                parts[part].append(table)
            if done % 20 == 0 or done == len(codes):
                print(f"{done}/{len(codes)} municipalities", flush=True)
    return {part: pa.concat_tables(tables).to_pandas() for part, tables in parts.items()}, names, max(stamps)


def from_national(path: Path) -> tuple[dict[str, pd.DataFrame], dict, str]:
    with zipfile.ZipFile(path) as z:
        stamp = re.search(r"(\d{8})\.csv$", z.namelist()[0]).group(1)
        return {part: table.to_pandas() for part, table in read_archive(z).items()}, read_codes(z), stamp


def build(frames: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, pd.DataFrame]:
    # Objects crossing a municipal border can appear in more than one export.
    buildings = frames["stavba"].drop_duplicates("EID_STAVBA")
    units = (
        frames["del_stavbe"].drop_duplicates("EID_DEL_STAVBE")
        .merge(buildings, on="EID_STAVBA")
        .merge(frames["del_stavbe_enota"].drop_duplicates("EID_DEL_STAVBE"), on="EID_DEL_STAVBE", how="left")
    )
    units = pd.DataFrame({
        "ko": units.KO_SIFKO.astype("int32"),
        "building": units.STEV_ST,
        "unit": units.STEV_DST,
        "gv": units.POSPLOSENA_VREDNOST.astype("float32"),
        "construction": units.ID_KONSTRUKCIJA.fillna(0).astype("int8"),
        "building_type": units.ID_TIP_STAVBE.fillna(0).astype("int8"),
    }).drop_duplicates(["ko", "building", "unit"])

    values = frames["parc_enota"].drop_duplicates("ID_PARC_ENOTA").groupby("EID_PARCELA").POSPLOSENA_VREDNOST.sum()
    parcels = frames["parcela"].drop_duplicates("EID_PARCELA")
    parcels = pd.DataFrame({
        "ko": parcels.KO_SIFKO.astype("int32"),
        "parcel": parcels.PARCELA.str.replace("*", "", regex=False).str.strip(),
        "gv": parcels.EID_PARCELA.map(values).astype("float32"),
    }).drop_duplicates(["ko", "parcel"])
    return units, parcels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", type=Path, help="national archive instead of the municipal exports")
    args = parser.parse_args()

    try:
        frames, names, stamp = from_national(args.zip) if args.zip else from_municipalities()
    except OSError as error:
        if not closed(error):
            raise
        # The published table stays; the daily job fails once its data gets too old.
        print(f"::warning::GURS je storitev zaprl ({error}), tabela vrednosti ostaja nespremenjena.")
        built(False)
        return
    units, parcels = build(frames)
    print(f"units {len(units):,}, with value {units.gv.notna().mean():.1%}")
    print(f"parcels {len(parcels):,}, with value {parcels.gv.notna().mean():.1%}")
    # Parcels and units cover the country; a thin result means a broken export, not a small country.
    if len(units) < 1_000_000 or len(parcels) < 4_000_000:
        raise RuntimeError("valuation lookup is suspiciously small, refusing to write it")

    OUT.mkdir(parents=True, exist_ok=True)
    units.to_parquet(OUT / "units.parquet", compression="zstd", index=False)
    parcels.to_parquet(OUT / "parcels.parquet", compression="zstd", index=False)
    info = {"name": f"EV_MUNICIPAL_{stamp}", "date": stamp, "names": names}
    (OUT / "valuation.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf8")
    for path in sorted(OUT.iterdir()):
        print(path.name, f"{path.stat().st_size / 1e6:.1f} MB")
    built(True)


def built(done: bool) -> None:
    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a", encoding="utf8") as f:
            f.write(f"built={'true' if done else 'false'}\n")


if __name__ == "__main__":
    main()
