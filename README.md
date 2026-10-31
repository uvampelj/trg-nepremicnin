# Kataster cen

Interaktivni zemljevid prodanih stanovanj, hiš in zemljišč v Sloveniji od leta 2020.

**Stran:** https://uvampelj.github.io/trg-nepremicnin/

- €/m², cena, promet in rast po občinah in katastrskih občinah
- toplotna karta cen, območja in posamezni posli
- trendi po četrtletjih, medletna rast, posli po tipih
- razmerje med pogodbeno ceno in posplošeno vrednostjo GURS
- filtri po tipu, letu, vrsti posla, tržnosti, novogradnji, letu gradnje, konstrukciji, površini, zemljišču in ceni
- pri hišah velikost zemljišča, ocena €/m² brez zemljišča in primerjava s podobnimi hišami v isti katastrski občini
- povezava vsebuje izbrane filtre, zato jo lahko delite; izbor prenesete kot CSV

Stran je neodvisen prikaz odprtih podatkov in ni uradna storitev GURS. Ni cenitev.

## Kako se osvežuje

GURS izvoze objavi enkrat tedensko. Osveževanje je razdeljeno na dva posla:

- [`refresh.yml`](.github/workflows/refresh.yml) vsak dan ob 6.20 UTC primerja objavljene izvoze s [`status/latest.json`](status/latest.json). Če ni novih podatkov, se konča. Če so, prenese posle ETN, zgradi podatke, zapiše novo stanje v repozitorij in objavi stran.
- [`valuation.yml`](.github/workflows/valuation.yml) vsak ponedeljek ob 3.40 UTC prenese evidenco vrednotenja po občinah (212 datotek, skupaj približno 1 GB), jo skrči v tabelo vrednosti in jo objavi kot izdajo [`valuation`](https://github.com/uvampelj/trg-nepremicnin/releases/tag/valuation).

Posli se osvežujejo neodvisno od vrednosti: če prenos vrednosti spodleti, stran še naprej uporablja zadnjo uspešno tabelo.

Če GURS spremeni strukturo datotek ali število poslov nenadoma pade za več kot 5 %, se gradnja ustavi, prejšnja različica strani pa ostane objavljena. GitHub o neuspešnem zagonu pošlje e-pošto.

Ročni zagon: **Actions → Osveži podatke → Run workflow**.

## Lokalni zagon

```bash
pip install -r pipeline/requirements.txt
gh release download valuation --dir data/valuation
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
| `pipeline/download.py` | prenos poslov ETN v `data/raw` |
| `pipeline/valuation.py` | tabela vrednosti iz občinskih izvozov evidence vrednotenja |
| `pipeline/build.py` | razvrstitev poslov, povezava z evidenco vrednotenja, izhod v `web/data` |
| `web/` | statična stran (MapLibre, brez gradnje) |

Metodologija je opisana na strani, pod gumbom **Metodologija**.

## Viri in licenca podatkov

Geodetska uprava Republike Slovenije: Evidenca trga nepremičnin (kupoprodajni posli), Evidenca vrednotenja, Register prostorskih enot, Kataster nepremičnin. Datum stanja je objavljen na strani in v `status/latest.json`. Podatki so na voljo pod licenco [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.sl).

Podlaga zemljevida: © OpenStreetMap, OpenMapTiles, OpenFreeMap.
