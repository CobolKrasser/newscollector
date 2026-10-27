# flissebaalje-nieuws

Nieuwsverzamelaar voor een persoonlijke, afgeschermde nieuwspagina op flissebaalje.nl.

Elk kwartier (GitHub Actions) haalt `verzamel.mjs`:

1. de huidige dataset, de duimpjes en de **instellingen** (rubrieken, bronnen, betaalmuursites) op bij de
   afgeschermde API van de site. De instellingen staan bewust niet in deze openbare repo;
2. de RSS-feeds en zoekopdrachten op, netjes: per bron een minimaal interval en conditionele verzoeken
   (ETag / If-Modified-Since), en elk artikel maar één keer;
3. per nieuw artikel de hoofdfoto en tekst op, en slaat artikelen achter een betaalmuur over;
4. laat Claude (Haiku 5.5) de rubriek kiezen, een feitelijke kop zonder clickbait schrijven, een korte en een
   uitgebreide samenvatting maken en een interessescore geven op basis van de duimpjes;
5. stuurt het resultaat terug naar de API. Berichten blijven 7 dagen.

Het logboek in Actions bevat alleen aantallen; het verslag per run staat op de (afgeschermde) pagina.

## Secrets

| Secret | Inhoud |
|---|---|
| `NIEUWS_TOKEN` | Zelfde waarde als in de site-repo; koppelt de verzamelaar aan de API |
| `ANTHROPIC_API_KEY` | Claude API-sleutel (bij voorkeur een aparte sleutel met een bestedingslimiet) |

## Lokaal testen

```bash
npm ci
node verzamel.mjs --droog --lokaal /tmp/nieuws.json --bronnen ../site/nieuws/bronnen.mjs
```

`--droog` slaat Claude over (de kop blijft de originele titel). Zonder `--droog` is `ANTHROPIC_API_KEY` nodig.
