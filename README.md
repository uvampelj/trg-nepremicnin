# Kataster cen

Interaktivni zemljevid prodanih stanovanj, hiš in zemljišč v Sloveniji od leta 2020.

**Stran:** https://uvampelj.github.io/trg-nepremicnin/

- €/m², cena, promet in rast po občinah in katastrskih občinah
- toplotna karta cen, območja in posamezni posli
- trendi po četrtletjih, medletna rast, posli po tipih
- razmerje med pogodbeno ceno in posplošeno vrednostjo GURS
- filtri po tipu, letu, vrsti posla, tržnosti, novogradnji, obdobju gradnje, konstrukciji, površini in ceni
- povezava vsebuje izbrane filtre, zato jo lahko delite; izbor prenesete kot CSV

Stran je neodvisen prikaz odprtih podatkov in ni uradna storitev GURS. Ni cenitev.

## Kako se osvežuje

GURS izvoze objavi enkrat tedensko. GitHub Action [`refresh.yml`](.github/workflows/refresh.yml) vsak dan ob 6.20 UTC:

1. primerja objavljene datoteke s [`status/latest.json`](status/latest.json),
2. če ni novih, se konča,
3. če so nove, prenese izvoze (približno 1,1 GB), zgradi podatke, zapiše novo stanje v repozitorij in objavi stran.

Če GURS spremeni strukturo datotek ali število poslov nenadoma pade za več kot 5 %, se gradnja ustavi, prejšnja različica strani pa ostane objavljena. GitHub o neuspešnem zagonu pošlje e-pošto.

Ročni zagon: **Actions → Osveži podatke → Run workflow**.

## Lokalni zagon

```bash
pip install -r pipeline/requirements.txt
python -m pipeline.download
python -m pipeline.build
python -m http.server 8791 --directory web
```

Meje območij v `web/geo` so v repozitoriju in se redko spreminjajo. Obnovite jih s `python -m pipeline.boundaries` (potrebuje Node).

## Struktura

| Pot | Vsebina |
|---|---|
| `pipeline/sources.py` | dostop do javnega API-ja JGP |
| `pipeline/check.py` | preveri, ali so na voljo novi podatki |
| `pipeline/download.py` | prenos izvozov v `data/raw` |
| `pipeline/build.py` | razvrstitev poslov, povezava z evidenco vrednotenja, izhod v `web/data` |
| `web/` | statična stran (MapLibre, brez gradnje) |

Metodologija je opisana na strani, pod gumbom **Metodologija**.

## Viri in licenca podatkov

Geodetska uprava Republike Slovenije: Evidenca trga nepremičnin (kupoprodajni posli), Evidenca vrednotenja, Register prostorskih enot, Kataster nepremičnin. Datum stanja je objavljen na strani in v `status/latest.json`. Podatki so na voljo pod licenco [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.sl).

Podlaga zemljevida: © OpenStreetMap, OpenMapTiles, OpenFreeMap.
