"""Turn the raw GURS exports into the static data files the site loads.

    python -m pipeline.build

Reads data/raw/, writes web/data/{deals,details,meta}.json and status/latest.json.
One output row is one sale. A sale is classified from all the properties it covers,
because ETN only records the price of the sale as a whole.
"""
from __future__ import annotations

import io
import json
import re
import unicodedata
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from pyproj import Transformer

from pipeline.sources import FIRST_YEAR

RAW = Path("data/raw")
VALUATION = Path("data/valuation")
OUT = Path("web/data")
GEO = Path("web/geo")
STATUS = Path("status/latest.json")
MIN_DATE = pd.Timestamp(FIRST_YEAR, 1, 1)

# Property groups. The numbering is the site's stable series id.
FLAT, HOUSE, LAND_BUILD, LAND_FARM, LAND_OTHER, LAND_FOREST = 1, 2, 3, 4, 5, 6
TYPE_LABELS = {
    FLAT: "Stanovanja",
    HOUSE: "Hiše",
    LAND_BUILD: "Stavbna zemljišča",
    LAND_FARM: "Kmetijska zemljišča",
    LAND_OTHER: "Druga zemljišča",
    LAND_FOREST: "Gozdna zemljišča",
}
# VRSTA_ZEMLJISCA -> group. 5 (land under or belonging to a building), 4 and 6 (roads,
# infrastructure) and 10 (barren, water) are not a market for building, farming or forestry.
LAND_GROUP = {1: LAND_BUILD, 2: LAND_BUILD, 3: LAND_BUILD, 7: LAND_FARM, 8: LAND_FARM, 9: LAND_FOREST,
              4: LAND_OTHER, 5: LAND_OTHER, 6: LAND_OTHER, 10: LAND_OTHER}

# VRSTA_DELA_STAVBE: 1 house, 2 flat, 3 parking, 4 garage, 13 farm building,
# 14 technical/auxiliary, 15 other. 5-12 are commercial and make a sale out of scope.
MAIN_PARTS = {1, 2}
COMMERCIAL_PARTS = set(range(5, 13))

# Beyond these the price says more about the sale than about the market, so the sale
# stays in the counts but is left out of price statistics.
PRICE_BOUNDS = {  # EUR/m2, smallest credible area m2
    FLAT: (300, 15000, 12),
    HOUSE: (100, 12000, 25),
    LAND_BUILD: (2, 2500, 30),
    LAND_FARM: (0.1, 80, 30),
    LAND_OTHER: (0.1, 2500, 5),
    LAND_FOREST: (0.05, 30, 30),
}
BIG_LAND_M2 = 3000  # a building sold with this much land is closer to a farm than a house

FLAG_NEW, FLAG_PART, FLAG_BUNDLE, FLAG_VAT, FLAG_PARKING, FLAG_NO_PRICE = 1, 2, 4, 8, 16, 32

REQUIRED = {
    "KPP_POSLI": ["ID_POSLA", "VRSTA_KUPOPRODAJNEGA_POSLA", "DATUM_SKLENITVE_POGODBE",
                  "POGODBENA_CENA_ODSKODNINA", "VKLJUCENOST_DDV", "VRSTA_AKTA", "TRZNOST_POSLA"],
    "KPP_DELISTAVB": ["ID_POSLA", "SIFRA_KO", "OBCINA", "STEVILKA_STAVBE", "STEVILKA_DELA_STAVBE", "NASELJE",
                      "ULICA", "HISNA_STEVILKA", "DODATEK_HS", "VRSTA_DELA_STAVBE", "LETO_IZGRADNJE_DELA_STAVBE",
                      "NOVOGRADNJA", "PRODANI_DELEZ_DELA_STAVBE", "UPORABNA_POVRSINA", "PRODANA_POVRSINA_DELA_STAVBE",
                      "PRODANA_POVRSINA", "E_CENTROID", "N_CENTROID"],
    "KPP_ZEMLJISCA": ["ID_POSLA", "SIFRA_KO", "IME_KO", "OBCINA", "PARCELNA_STEVILKA", "VRSTA_ZEMLJISCA",
                      "PRODANI_DELEZ_PARCELE", "POVRSINA_PARCELE", "E_CENTROID", "N_CENTROID"],
}


def raw_years() -> list[int]:
    years = sorted(int(path.stem.split("_")[1]) for path in RAW.glob("kpp_*.zip"))
    return [year for year in years if year >= FIRST_YEAR]


def read_sales() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    frames: dict[str, list[pd.DataFrame]] = {key: [] for key in REQUIRED}
    for year in raw_years():
        with zipfile.ZipFile(RAW / f"kpp_{year}.zip") as z:
            for key, columns in REQUIRED.items():
                name = next(n for n in z.namelist() if key in n)
                df = pd.read_csv(io.BytesIO(z.read(name)), encoding="utf-8-sig", dtype=str, keep_default_na=False)
                if missing := set(columns) - set(df.columns):
                    raise RuntimeError(f"{name}: GURS changed the structure, missing {sorted(missing)}")
                frames[key].append(df[columns])
    deals, parts, land = (pd.concat(frames[key], ignore_index=True) for key in REQUIRED)
    if deals.ID_POSLA.duplicated().any():
        raise RuntimeError("ID_POSLA is no longer unique across years")
    return deals, parts, land


def fraction(text: pd.Series) -> pd.Series:
    """'41/10000' -> 0.0041. Empty or unreadable shares count as the whole property."""
    pieces = text.str.replace(",", ".", regex=False).str.extract(r"^\s*([\d.]+)\s*(?:/\s*([\d.]+))?\s*$")
    top = pd.to_numeric(pieces[0], errors="coerce")
    bottom = pd.to_numeric(pieces[1], errors="coerce").fillna(1)
    share = (top / bottom).where(lambda s: (s > 0) & (s <= 1))
    return share.fillna(1.0)


def number(text: pd.Series) -> pd.Series:
    return pd.to_numeric(text.str.replace(",", ".", regex=False), errors="coerce")


def read_valuation(parts: pd.DataFrame, land: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """The prebuilt lookup, narrowed to the buildings and parcels that were sold."""
    info = json.loads((VALUATION / "valuation.json").read_text(encoding="utf8"))
    units = pd.read_parquet(VALUATION / "units.parquet")
    units = units.merge(parts[["ko", "building"]].drop_duplicates(), on=["ko", "building"])
    parcels = pd.read_parquet(VALUATION / "parcels.parquet")
    parcels = parcels.merge(land[["ko", "parcel"]].drop_duplicates(), on=["ko", "parcel"])
    return units, parcels, info


def plain(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text.upper()) if not unicodedata.combining(c))


def readable(name: str) -> str:
    """Cadastral names come in capitals: 'SVETI JURIJ PRI GROBELNEM' -> 'Sveti Jurij pri Grobelnem'."""
    small = {"pri", "na", "v", "ob", "nad", "pod", "in", "pred", "za", "do", "k", "s", "z"}
    words = name.lower().split()
    return " ".join(w if i and w in small else "-".join(p.capitalize() for p in w.split("-")) for i, w in enumerate(words))


def region_lookup() -> tuple[dict[int, str], dict[int, str], dict[str, int]]:
    def load(name: str) -> dict[int, str]:
        features = json.loads((GEO / name).read_text(encoding="utf8"))["features"]
        return {f["properties"]["id"]: f["properties"]["name"] for f in features}

    municipalities = load("obcine.geojson")
    cadastral = {code: readable(name) for code, name in load("ko.geojson").items()}
    by_name = {plain(name): code for code, name in municipalities.items()}
    # ETN uses the short names; RPE adds the bilingual form.
    for code, name in municipalities.items():
        by_name[plain(re.split(r"[/-]", name)[0]).strip()] = code
    return municipalities, cadastral, by_name


def classify(deals: pd.DataFrame, parts: pd.DataFrame, land: pd.DataFrame) -> pd.DataFrame:
    """One row per sale with its group, area, location and flags."""
    parts["main"] = parts.part_type.isin(MAIN_PARTS)
    parts["area"] = parts.useful_area.where(parts.useful_area > 0) * parts.share

    # Only rows that carry the sale's identity are needed from here: main parts first.
    main = parts[parts.main].sort_values(["deal", "useful_area"], ascending=[True, False])
    agg = main.groupby("deal").agg(
        area=("area", lambda s: s.sum(min_count=len(s))),
        main_parts=("area", "size"),
        buildings=("building", "nunique"),
        flats=("part_type", lambda s: int((s == 2).sum())),
        houses=("part_type", lambda s: int((s == 1).sum())),
        min_share=("share", "min"),
        built=("built", "first"),
        new=("new", "max"),
    )
    first = main.drop_duplicates("deal").set_index("deal")
    agg = agg.join(first[["e", "n", "ko", "municipality", "settlement", "street", "house_no", "construction", "building_type"]])

    has_commercial = parts[parts.part_type.isin(COMMERCIAL_PARTS)].deal.unique()
    has_parking = parts[parts.part_type.isin({3, 4})].deal.unique()
    land_with_building = land.groupby("deal").area.sum()

    buildings = agg[~agg.index.isin(has_commercial)].copy()
    buildings["group"] = np.where(buildings.houses >= buildings.flats, HOUSE, FLAT)
    buildings["parking"] = buildings.index.isin(has_parking)
    buildings["land_area"] = land_with_building.reindex(buildings.index).fillna(0)
    bundle = (buildings.buildings > 1) | ((buildings.flats > 0) & (buildings.main_parts > 1)) \
        | (buildings.land_area >= BIG_LAND_M2)
    buildings["bundle"] = bundle

    # Land-only sales take the group holding most of the area.
    only_land = land[~land.deal.isin(parts.deal)].copy()
    only_land = only_land[only_land.land_type.isin(LAND_GROUP)]
    only_land["group"] = only_land.land_type.map(LAND_GROUP)
    by_group = only_land.groupby(["deal", "group"]).area.sum().rename("group_area").reset_index()
    dominant = by_group.sort_values("group_area").drop_duplicates("deal", keep="last").set_index("deal")
    biggest = only_land.sort_values("area").drop_duplicates("deal", keep="last").set_index("deal")
    plots = only_land.groupby("deal").agg(area=("area", "sum"), min_share=("share", "min"))
    plots["group"] = dominant.group
    plots = plots.join(biggest[["e", "n", "ko", "municipality"]])
    plots["land_area"] = plots.area
    # A sale split evenly across farmland and forest has no single EUR/m2 worth reporting.
    plots["bundle"] = dominant.group_area / plots.area < 0.8
    plots["parking"] = False

    sales = pd.concat([buildings, plots])
    return deals.set_index("deal").join(sales, how="inner")


def add_values(sales: pd.DataFrame, parts: pd.DataFrame, land: pd.DataFrame, units: pd.DataFrame,
               parcels: pd.DataFrame) -> pd.DataFrame:
    """Sum the generalised value of everything in the sale, only when all of it matched."""
    in_scope = parts[parts.deal.isin(sales.index)].merge(units, on=["ko", "building", "unit"], how="left", suffixes=("", "_ev"))
    in_scope["value"] = in_scope.gv * in_scope.share
    plots = land[land.deal.isin(sales.index)].merge(parcels, on=["ko", "parcel"], how="left")
    plots["value"] = plots.gv * plots.share
    rows = pd.concat([in_scope[["deal", "value"]], plots[["deal", "value"]]])
    sales["gv"] = rows.groupby("deal").value.sum(min_count=1)
    sales.loc[rows[rows.value.isna()].deal.unique(), "gv"] = np.nan

    extra = in_scope.sort_values("main", ascending=False).drop_duplicates("deal").set_index("deal")
    sales["construction"] = extra.construction.reindex(sales.index)
    sales["building_type"] = extra.building_type.reindex(sales.index)
    return sales


def main() -> None:
    municipalities, cadastral, municipality_by_name = region_lookup()

    deals, parts, land = read_sales()
    deals = pd.DataFrame({
        "deal": deals.ID_POSLA,
        "kind": pd.to_numeric(deals.VRSTA_KUPOPRODAJNEGA_POSLA, errors="coerce").fillna(0).astype(int),
        "date": pd.to_datetime(deals.DATUM_SKLENITVE_POGODBE, format="%d.%m.%Y", errors="coerce"),
        "price": number(deals.POGODBENA_CENA_ODSKODNINA),
        "vat": deals.VKLJUCENOST_DDV == "1",
        "act": deals.VRSTA_AKTA,
        "market": pd.to_numeric(deals.TRZNOST_POSLA, errors="coerce").fillna(4).astype(int),
    })
    total_rows = len(deals)
    deals = deals[deals.date >= MIN_DATE]

    parts = pd.DataFrame({
        "deal": parts.ID_POSLA,
        "ko": pd.to_numeric(parts.SIFRA_KO, errors="coerce").fillna(0).astype(np.int32),
        "municipality": parts.OBCINA,
        "building": pd.to_numeric(parts.STEVILKA_STAVBE, errors="coerce").fillna(0).astype(np.int64),
        "unit": pd.to_numeric(parts.STEVILKA_DELA_STAVBE, errors="coerce").fillna(0).astype(np.int64),
        "settlement": parts.NASELJE,
        "street": parts.ULICA,
        "house_no": parts.HISNA_STEVILKA + parts.DODATEK_HS,
        "part_type": pd.to_numeric(parts.VRSTA_DELA_STAVBE, errors="coerce").fillna(0).astype(int),
        "built": pd.to_numeric(parts.LETO_IZGRADNJE_DELA_STAVBE, errors="coerce"),
        "new": parts.NOVOGRADNJA == "1",
        "share": fraction(parts.PRODANI_DELEZ_DELA_STAVBE),
        # New flats missing from the cadastre have no useful area yet, only the contract's.
        "useful_area": number(parts.UPORABNA_POVRSINA).where(lambda a: a > 0)
        .fillna(number(parts.PRODANA_POVRSINA_DELA_STAVBE).where(lambda a: a > 0))
        .fillna(number(parts.PRODANA_POVRSINA).where(lambda a: a > 0)),
        "e": number(parts.E_CENTROID),
        "n": number(parts.N_CENTROID),
    }).drop_duplicates(["deal", "ko", "building", "unit"])
    parts = parts[parts.deal.isin(deals.deal)]

    land = pd.DataFrame({
        "deal": land.ID_POSLA,
        "ko": pd.to_numeric(land.SIFRA_KO, errors="coerce").fillna(0).astype(np.int32),
        "municipality": land.OBCINA,
        "parcel": land.PARCELNA_STEVILKA.str.replace("*", "", regex=False).str.strip(),
        "land_type": pd.to_numeric(land.VRSTA_ZEMLJISCA, errors="coerce").fillna(0).astype(int),
        "share": fraction(land.PRODANI_DELEZ_PARCELE),
        "parcel_area": number(land.POVRSINA_PARCELE),
        "e": number(land.E_CENTROID),
        "n": number(land.N_CENTROID),
    }).drop_duplicates(["deal", "ko", "parcel"])
    land = land[land.deal.isin(deals.deal)]
    land["area"] = land.parcel_area.fillna(0) * land.share

    units, parcels, valuation = read_valuation(parts, land)
    parts = parts.merge(units[["ko", "building", "unit", "construction", "building_type"]], on=["ko", "building", "unit"], how="left")

    sales = classify(deals, parts, land)
    sales = add_values(sales, parts, land, units, parcels)

    # Location
    to_wgs84 = Transformer.from_crs("EPSG:3794", "EPSG:4326", always_xy=True)
    lon, lat = to_wgs84.transform(sales.e.to_numpy(), sales.n.to_numpy())
    inside = (lon > 13.3) & (lon < 16.7) & (lat > 45.3) & (lat < 47.0)
    sales["lon"] = np.where(inside, lon, np.nan)
    sales["lat"] = np.where(inside, lat, np.nan)

    # Municipality: ETN name, else the most common one in the same cadastral community.
    sales["muni"] = sales.municipality.fillna("").map(lambda s: municipality_by_name.get(plain(s).strip(), 0))
    known = sales[sales.muni > 0]
    usual = known.groupby("ko").muni.agg(lambda s: s.mode().iat[0])
    missing = sales.muni == 0
    sales.loc[missing, "muni"] = sales.loc[missing, "ko"].map(usual).fillna(0)
    sales["muni"] = sales.muni.astype(int)

    # Price per m2, gated on plausibility per group.
    sales["per_m2"] = sales.price / sales.area
    low = sales.group.map(lambda g: PRICE_BOUNDS[g][0])
    high = sales.group.map(lambda g: PRICE_BOUNDS[g][1])
    smallest = sales.group.map(lambda g: PRICE_BOUNDS[g][2])
    priced = sales.per_m2.between(low, high) & (sales.area >= smallest)

    bits = (
        sales.new.eq(True).astype(int) * FLAG_NEW
        + (sales.min_share < 0.999).astype(int) * FLAG_PART
        + sales.bundle.eq(True).astype(int) * FLAG_BUNDLE
        + sales.vat.astype(int) * FLAG_VAT
        + sales.parking.eq(True).astype(int) * FLAG_PARKING
        + (~priced).astype(int) * FLAG_NO_PRICE
    )
    built = sales.built.where(sales.built.between(1500, date.today().year + 3)).fillna(0).astype(int)

    sales = sales.assign(bits=bits, built=built).sort_values(["group", "muni", "date"])
    write_outputs(sales, municipalities, cadastral, valuation, total_rows)


def rounded(values: pd.Series, digits: int = 0) -> list:
    """JSON-friendly column: 0 stands for missing, floats keep only the digits they need."""
    out = values.fillna(0).round(digits)
    return out.astype(int).tolist() if digits == 0 else [int(v) if v == int(v) else v for v in out.tolist()]


def write_outputs(sales, municipalities, cadastral, valuation, total_rows) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    month = (sales.date.dt.year - FIRST_YEAR) * 12 + sales.date.dt.month - 1

    columns = {
        "t": sales.group.astype(int).tolist(),
        "m": month.astype(int).tolist(),
        "x": rounded(sales.lon * 1e4),
        "y": rounded(sales.lat * 1e4),
        "p": rounded(sales.price),
        "a": rounded(sales.area, 1),
        "g": rounded(sales.gv),
        "o": sales.muni.tolist(),
        "k": sales.ko.fillna(0).astype(int).tolist(),
        "f": sales.bits.astype(int).tolist(),
        "v": sales.kind.tolist(),
        "r": sales.market.tolist(),
        "b": sales.built.tolist(),
        "c": sales.construction.fillna(0).astype(int).tolist(),
        "s": sales.building_type.fillna(0).astype(int).tolist(),
        "l": rounded(sales.land_area),
    }
    (OUT / "deals.json").write_text(json.dumps({"n": len(sales), "cols": columns}, separators=(",", ":")), encoding="utf8")

    addresses = (sales.street.where(sales.street.fillna("") != "", sales.settlement).fillna("") + " " + sales.house_no.fillna("")).str.strip()
    place = sales.settlement.fillna("")
    dictionary = sorted(set(addresses) | set(place))
    index = {text: i for i, text in enumerate(dictionary)}
    details = {
        "dict": dictionary,
        "address": [index[a] for a in addresses],
        "place": [index[p] for p in place],
        "day": sales.date.dt.day.astype(int).tolist(),
        "id": sales.index.astype(int).tolist(),
    }
    (OUT / "details.json").write_text(json.dumps(details, separators=(",", ":"), ensure_ascii=False), encoding="utf8")

    sources = {}
    for year in raw_years():
        marker = RAW / f"kpp_{year}.json"
        with zipfile.ZipFile(RAW / f"kpp_{year}.zip") as z:
            stamp = re.search(r"(\d{8})\.csv$", z.namelist()[0]).group(1)
        name = f"ETN_SLO_{year}_KPP_{stamp}.zip"
        sources[str(year)] = json.loads(marker.read_text()) if marker.exists() else {"name": name, "date": stamp}
    sources["valuation"] = {"name": valuation["name"], "date": valuation["date"]}

    last_month = int(month.max())
    summary = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "etnDate": max(v["date"] for k, v in sources.items() if k != "valuation"),
        "evDate": sources["valuation"]["date"],
        "firstYear": FIRST_YEAR,
        "lastMonth": last_month,
        "sales": len(sales),
        "salesWithValue": int(sales.gv.notna().sum()),
        "salesWithoutCoordinates": int(sales.lon.isna().sum()),
        "rowsInEtn": total_rows,
    }
    meta = dict(summary)
    meta["types"] = {str(k): v for k, v in TYPE_LABELS.items()}
    meta["municipalities"] = {str(k): v for k, v in municipalities.items()}
    meta["cadastral"] = {str(k): v for k, v in cadastral.items()}
    meta["construction"] = valuation["names"]["construction"]
    meta["buildingTypes"] = valuation["names"]["buildingTypes"]
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":"), ensure_ascii=False), encoding="utf8")

    previous = json.loads(STATUS.read_text(encoding="utf8")) if STATUS.exists() else None
    if previous and len(sales) < 0.95 * previous["summary"]["sales"]:
        raise RuntimeError(f"Sales dropped from {previous['summary']['sales']} to {len(sales)}, refusing to publish")
    STATUS.parent.mkdir(exist_ok=True)
    STATUS.write_text(json.dumps({"summary": summary, "sources": sources}, indent=1, ensure_ascii=False) + "\n", encoding="utf8")
    print(json.dumps(summary, indent=1))
    for path in ("deals.json", "details.json", "meta.json"):
        print(path, f"{(OUT / path).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
