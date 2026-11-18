# Better Keito Bar

Electron-menubalk-app voor tijdregistratie in [Keito](https://keito.ai), gebouwd voor 23G (±50
mensen, overstap van Harvest). Harvest-achtige weeknavigatie, Jira-tickets, meetingherkenning,
budgetsignaal, idle-detectie en herinneringen. Interface en teksten zijn **Nederlands**.

Repo: `jimvaneijk/keito-bar` (publiek; er staan geen keys in de code). Collega's installeren via
GitHub Releases en krijgen updates automatisch.

## Commando's

```bash
npm start                 # bouwt eerst native/mic-monitor (Swift), start dan Electron
npm run check             # node --check op alle JS
npm run format            # Prettier; format:check alleen controleren
npm run dist              # lokale testbuild, ad-hoc gesigneerd (niet voor collega's)
npm run release           # signeren + notariseren + publiceren op GitHub (zie Release)
npm run release -- --upload-only   # afgebroken upload aanvullen zonder opnieuw te bouwen
```

Na een `git pull` met nieuwe dependencies: `npm install` (Prettier staat alleen in devDependencies).

## Structuur

| Pad | Wat |
|---|---|
| `main.js` | Main process: tray, venster (menubalk ↔ losgemaakt), IPC, versleutelde keys (`safeStorage`), idle, herinneringen, meetings, budgetten, auto-update |
| `preload.js` | `contextBridge` → `window.keito`. **Elke nieuwe IPC-functie hier toevoegen** |
| `renderer/` | Interface in vanilla HTML/CSS/JS, geen framework, geen bundler |
| `src/keito-api.js` | Keito API v2 (`https://app.keito.ai/api/v2`, `Authorization: Bearer kto_…` + `Keito-Account-Id`) |
| `src/jira-api.js` | Jira Cloud (Basic auth e-mail + API-token; issue picker + `/search/jql`) |
| `src/meeting-detector.js` | Meetingherkenning: welke app gebruikt de microfoon + browsertabbladen via JXA |
| `native/mic-monitor.swift` | Meldt per JSON-regel welke apps de microfoon gebruiken (CoreAudio process objects, macOS 14+) |
| `build/` | `release.js`, `update-info.js` (schrijft `latest-mac.yml`), `build-mic-monitor.js`, `entitlements.mac.plist`, `adhoc-sign.js` |
| `docs/screenshots/` | README-afbeeldingen, gemaakt met **verzonnen** voorbeelddata (repo is publiek) |

## Codestijl

- 4 spaties, enkele quotes, regels tot 120 tekens: Prettier (`.prettierrc.json`), `.editorconfig`.
- **Voluit geschreven namen.** Geen variabelen of functies van één letter, geen afkortingen
  (`entry` niet `e`, `event` niet `ev`, `formatHours` niet `fmtH`).
- Teksten in de interface in het Nederlands; codecommentaar in het Engels.

## Valkuilen (hier al eens misgegaan)

- **Declareer in `renderer/app.js` nooit een top-level naam die `contextBridge` al op `window` zet**,
  vooral `keito`. Die eigenschap is niet overschrijfbaar; `const keito = …` geeft in de echte app
  `SyntaxError: Identifier 'keito' has already been declared` en de app blijft op het laadscherm.
  De brug heet in de renderer daarom `keitoBridge`. Hetzelfde geldt voor `top`, `location`, `window`, enz.
- **SVG-elementen hebben geen `.hidden`-property.** Gebruik `element.toggleAttribute('hidden', …)`.
- **CSP** (`script-src 'self'; style-src 'self'`): geen inline `style="…"` in HTML-strings; zet
  stijlen via CSSOM (`element.style.setProperty`).
- **Lopende timers:** Keito's `hours` bevat de lopende tijd niet. Reken vanaf `timer_started_at`
  (`annotateRunning()` in `main.js` zet `liveStartMs`/`liveBaseHours`). Pauzeren = stoppen + hervatten.
- **Keito `PATCH /time_entries/:id` accepteert geen `external_reference`.** Alleen bij aanmaken; valt
  terug op aanmaken zonder als Keito het weigert. Jira-koppeling staat altijd ook in de notitie
  (`KEY-123 · samenvatting — notitie`).
- **Budgetten volgen Keito-rechten:** `/reports/project_budget` alleen voor Owners/Admins (alles) en
  Managers met *View billable rates* (eigen projecten). Medewerkers: per project
  `/projects/:id/budget_summary`, alleen als een beheerder geldbudget-inzage gaf (geen urenbudgetten).
  403/404 = "geen inzage", nooit als fout tonen.
- **Testen met een nep-`window.keito`:** definieer hem net als Electron niet-overschrijfbaar
  (`Object.defineProperty(window, 'keito', { configurable: false, writable: false, … })`),
  anders mis je botsingen als hierboven.

## Release

`npm run release` (`build/release.js`):

1. controleert certificaat (*Developer ID Application: Joannes van Eijk (NL25W42U2F)*, in de
   **login**-sleutelhanger), notarisatieprofiel `keito-notary`, GitHub-token (`gh auth token`),
   of de repo bestaat en of de versie nieuw is;
2. `electron-builder --publish never`: bouwen, signeren, notariseren (eerste keer kan uren duren);
3. maakt zelf **één concept-release**, uploadt bestanden **één voor één** (`latest-mac.yml` als
   laatste) en publiceert pas daarna.

Laat electron-builder **niet** zelf publiceren: die uploadt DMG en zip tegelijk, beide maken de
release aan en GitHub geeft `422 Published releases must have a valid tag`; dan ontbreekt
`latest-mac.yml` en krijgt niemand de update.

Versie ophogen vóór een release: `npm version patch --no-git-tag-version`.
Builds van vóór 0.2.0 (ad-hoc) kunnen zichzelf niet bijwerken.

## Openstaand

- Meetingherkenning (Swift-hulpprogramma, Apple Events-toestemming) en het losgemaakte venster
  (Dock, slepen) zijn tot nu toe alleen in een nagebootste omgeving getest; controleer op een Mac.
- Ideeën die nog liggen: agenda-koppeling (meetingnamen in Teams-app, project per terugkerende
  meeting), vastgezette favorieten, week afronden op vrijdag, Jira-ticket uit de git-branch.
