# Tourenplaner (PWA)

Statische Web-App, kein Server nötig. Dateien: `index.html`, `app.js`, `styles.css`, `manifest.json`, `sw.js`, `icons/`.

- Texterkennung: tesseract.js 5 (Deutsch) im Browser, Bilder bleiben auf dem Gerät
- Adresssuche: OpenStreetMap Nominatim (max. 1 Anfrage/s, Ergebnisse im Gerät gespeichert)
- Fahrzeiten: OSRM-Demoserver (router.project-osrm.org), Schätzung ohne Verkehr
- Optimierung: exakt (Held-Karp) bis 12 freie Stopps, darüber Nächster Nachbar + 2-opt/Or-opt
- Navigation: Google Maps (max. 9 Zwischenziele/Link, automatisch geteilt), Apple Karten Gesamtroute
  (`maps.apple.com/directions?source=…&waypoint=…&destination=…&mode=driving`, iOS 18.4+), Einzel-Links je Stopp

## Einrichtung
Fahrer und Startadressen stehen nicht im Code. Sie werden auf jedem Gerät lokal gespeichert –
entweder über die Einstellungen oder einmalig über einen Einrichtungslink `…/#setup=<base64url JSON>`
mit `{"drivers":[{"name","address","lat","lon"}],"default":"Name"}`. Der Link wird nach dem Öffnen aus der Adresszeile entfernt.

## Veröffentlichen (GitHub Pages)
1. Auf github.com ein öffentliches Repository anlegen, z. B. `tourenplaner`.
2. Die App-Dateien hochladen (keine Testbilder – sie enthalten Kundendaten).
3. Settings → Pages → Source „Deploy from a branch“, Branch `main`, Ordner `/ (root)` → Save.
4. Nach ca. 1 Min. erreichbar unter `https://<benutzername>.github.io/tourenplaner/`.
5. Auf dem iPhone in Safari öffnen → Teilen → „Zum Home-Bildschirm“.

Nach Änderungen `VERSION` in `sw.js` und `app.js` auf denselben Wert erhöhen (z. B. `tp-v10`), damit Geräte die neue Version laden.
