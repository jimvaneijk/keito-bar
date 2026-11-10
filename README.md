# Keito Bar

Menubar-app voor Keito-tijdregistratie, geïnspireerd op de Harvest-menubar:
week bovenin, met één klik (of ←/→) door de dagen, en geen "recente projecten"-ruis.

## Starten

```bash
npm install
npm start
```

Bij de eerste keer opent het venster vanzelf. Vul je **full-access integration key** (`kto_…`)
en **Company ID** in (Keito → Settings → API & Developers). Een personal read-only sync key
werkt niet: daarmee kun je geen tijd schrijven.

De key wordt via Electron `safeStorage` (macOS-sleutelhanger) versleuteld opgeslagen in
`~/Library/Application Support/Keito Bar/config.json` en alleen naar `app.keito.ai` gestuurd.
Voor ontwikkeling kun je ook `KEITO_API_KEY` en `KEITO_ACCOUNT_ID` als env-variabelen zetten.

## Bouwen en uitrollen

```bash
npm run dist       # lokale testbuild (ad-hoc gesigneerd, niet voor collega's)
npm run release    # gesigneerd + genotariseerd + gepubliceerd op GitHub Releases
```

### Eenmalig instellen

1. **Developer ID-certificaat** — Xcode → Settings → Accounts → je team → Manage Certificates →
   `+` → *Developer ID Application*. (Alleen de Account Holder van het team kan dit type maken.)
2. **Notarisatie** — maak een app-specifiek wachtwoord op account.apple.com en sla het op:
   ```bash
   xcrun notarytool store-credentials keito-notary \
     --apple-id jouw@appleid.nl --team-id ABCDE12345 --password xxxx-xxxx-xxxx-xxxx
   ```
3. **GitHub** — maak een publieke repo (bijv. `keito-bar`), vul `owner` en `repo` in bij
   `build.publish` in `package.json`, en log in met de GitHub CLI: `brew install gh && gh auth login`.

### Nieuwe versie uitbrengen

```bash
npm version patch --no-git-tag-version   # 0.2.0 → 0.2.1
npm run release                          # of release:universal als er nog Intel-Macs zijn
```

Geïnstalleerde apps controleren bij het opstarten en elke 4 uur, downloaden op de achtergrond
en tonen "Versie x staat klaar — Herstart nu". Zonder herstart wordt de update bij de
volgende keer afsluiten geïnstalleerd.

**Let op:** builds van vóór 0.2.0 (ad-hoc gesigneerd) kunnen zichzelf niet bijwerken.
Collega's installeren de eerste gesigneerde DMG één keer handmatig; daarna gaat het vanzelf.

## Wat het doet

- Menubalk toont de lopende timer (bijv. `1:26`), of anders je totaal van vandaag
- Weekstrip met dagtotalen; klik een dag of gebruik het toetsenbord
- Timer starten / stoppen / hervatten (starten stopt automatisch een lopende timer)
- Uren toevoegen op elke dag, bewerken, verwijderen; goedgekeurde/vergrendelde uren zijn read-only
- Projectzoeker op project, klant of code, gegroepeerd per klant — geen recente projecten
- Onthoudt per project de laatst gebruikte taak
- Ververst bij elke keer openen; pakt elke 2 min timers op die elders (web, Raycast) zijn gestart

## Idle-tijd

Loopt er een timer en ben je een tijd weg (geen muis/toetsenbord, scherm op slot of laptop in
slaap), dan vraagt Keito Bar bij terugkomst wat je met die tijd wilt:

1. **Haal eraf en ga door** — idle-tijd van de timer af, timer loopt verder
2. **Haal eraf en stop de timer**
3. **Boek als andere registratie** — eraf bij deze timer, en direct een formulier met die duur
4. **Gewoon doorgaan** — tijd laten staan

Aan/uit en de drempel (5 min – 1 uur, standaard 10 min) staan in Instellingen. Sluit je het
venster zonder te kiezen, dan komt de vraag terug bij de volgende keer openen.

## Herinneringen

Alleen op je werkdagen (standaard ma–vr) en pas als je achter je computer zit:

- **Timer nog niet gestart** — vanaf 09:15 zonder lopende timer: start met één klik je laatst
  gebruikte project, een andere timer, herinner over 15 min, of vandaag niet meer vragen.
- **Uren-check einde dag** — om 16:45 onder de 6 uur (incl. lopende timer): uren aanvullen
  (resterende tijd staat al ingevuld), bekijk je dag, herinner over 15 min, of "klopt zo".

Tijden, het minimum (4–8 uur) en de werkdagen pas je aan in Instellingen → Herinneringen.
Met "Probeer" zie je de herinnering direct. Elke herinnering komt maximaal één keer per dag
(behalve als je hem uitstelt).

## Sneltoetsen

| Toets | Actie |
|---|---|
| ⌘⇧K | Venster openen/sluiten (globaal) |
| ← / → | Vorige / volgende dag |
| ⇧← / ⇧→ | Vorige / volgende week |
| 1–7 | Ma t/m zo van de getoonde week |
| T | Vandaag |
| N | Nieuwe registratie |
| S | Lopende timer stoppen |
| ⌘↵ | Formulier opslaan |
| ⌘R | Verversen |
| Esc | Terug / venster sluiten |

Duur invoeren: `1:30`, `1.5`, `1,5`, `90m`, `1h30`. Leeg laten op vandaag = timer starten.

## Structuur

- `main.js` — tray, popover-venster, IPC, opslag van de key
- `src/keito-api.js` — Keito API v2-client (`https://app.keito.ai/api/v2`, Bearer + `Keito-Account-Id`)
- `preload.js` — veilige brug naar de renderer (contextIsolation, sandbox)
- `renderer/` — UI (vanilla HTML/CSS/JS)
