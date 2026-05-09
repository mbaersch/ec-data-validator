# Enhanced Conversions — Findings für Blogpost

Faktensammlung aus der praktischen Pipeline-Analyse mit GTM, gtag und der
Validator-Extension. Jedes Finding ist eigenständig, datiert und mit
Quelle/Repro-Setup versehen, damit es im Post als Beleg zitiert werden kann.

---

## 1. Hash-Encoding im `em`-Parameter: Base64URL, nicht Hex

**Datum:** 2026-05-09
**Setup:** atomkraftwerke24.de/ectest.html (statisches Form, GTM-M3X2ND4),
Google-Ads-Conversion-Tag mit Enhanced Conversions im Modus *Automatische
Sammlung* (Auto-Detection per `autocomplete`-Attributen).

**Beobachtung**
Beim Form-Submit mit `mail@markus-baersch.de` schickt das Google-Tag im
Conversion-Request einen `em`-Parameter:

```
tv.1~em.jZtw_SDiORnP5mTqXlcds51yuhvxe_V-kJraJL6ao6o
```

Der Hash-Wert nach `em.` hat **43 Zeichen** und enthält `_` / `-`. Das ist
Base64URL ohne Padding — nicht Hex.

**Verifikation**
SHA-256 von `mail@markus-baersch.de` (lowercase, getrimmt) liefert:

| Encoding   | Länge | Wert                                                               |
|------------|-------|--------------------------------------------------------------------|
| Hex        | 64    | `8d9b70fd20e23919cfe664ea5e571db39d72ba1bf17bf57e909ada24be9aa3aa` |
| Base64URL  | 43    | `jZtw_SDiORnP5mTqXlcds51yuhvxe_V-kJraJL6ao6o`                      |

Der Base64URL-Wert matcht den `em`-Parameter exakt → es ist derselbe Hash,
nur kompakter kodiert.

**Konsequenz für die Pipeline**
Es existieren in der Praxis **zwei Encodings für SHA-256-Hashes** in
Enhanced-Conversions-Daten:

- **Hex** (64 Zeichen, `[0-9a-f]`) — bei *manuell* bereitgestellten Werten,
  z. B. `sha256_email_address` aus einem dataLayer-Push oder
  `gtag('set','user_data',{...})`. Entspricht der offiziellen Google-Doku
  („Hashing erfolgt immer mit SHA256 im Hex-Format").
- **Base64URL** (43 Zeichen, `[A-Za-z0-9_-]`, kein Padding) — bei *automatisch*
  durch das Google-Tag gesammelten Werten. Wird so im `em`-Parameter
  übertragen (URL-platzsparend).

**Heuristik zur Unterscheidung**

```
^[0-9a-f]{64}$            → Hex
^[A-Za-z0-9_-]{43}={0,1}$ → Base64URL (43 ohne Padding, 44 mit)
```

**Implikation für Validierungstools**
Wer einen Hash gegen einen Plaintext prüfen will, muss **beide Encodings**
des Plaintext-Hashes vorhalten und den Vergleich gegen beide machen. Die
Validator-Extension hat in v1.2 nur Hex unterstützt → Auto-Detection-Werte
schlugen still fehl (kein MATCH, obwohl der Hash korrekt war). Fix: pro
verifiziertem Klartext beides berechnen, das Encoding pro Hash-Token in der
UI anzeigen.

**Quellen / Belege**
- Eigener Conversion-Request, Network-Tab Chrome DevTools, 2026-05-09
- ressources/enhanced-conversions-info-de.md (eigene Notiz: „Hashing im
  Hex-Format" — gilt nur für manuell bereitgestellte Daten, nicht für die
  Auto-Detection)

---

## 2. Validierungs-Asymmetrie: nur das GTM-UI erzwingt eine Mindestadresse

**Datum:** 2026-05-09 (überarbeitet 2026-05-09 nach erweiterten Tests, siehe
Note unten)
**Setup:** Google Tag Manager. Drei getestete Pfade, alle mit demselben
dataLayer-Push aus atomkraftwerke24.de/ectest.html: (a) manuelles
„User-Provided Data"-Tag mit Feld-Mapping in der UI, (b) UPD-Tag, das eine
UPD-Variable im *Code*-Modus konsumiert, (c) direkter `dataLayer.push` /
`gtag('set','user_data', …)` ohne UPD-Konstrukt.

**Beobachtung**
Validiert wird **ausschließlich im GTM-UI**, nirgends sonst:

| Pfad | Validierung clientseitig |
|------|--------------------------|
| **GTM-UI, manuelles Feld-Mapping im UPD-Tag** | Strikt. Wer dort `first_name` oder `last_name` mappt, muss zusätzlich `country` *und* `postal_code` mappen — sonst blockiert die Oberfläche das Speichern. Spiegelt Googles eigene Mindestregel für die „vollständige Adresse" (FN + LN + Country + PLZ) als Identifikator. |
| **UPD-Variable im Code-Modus** | Keine. Was im `user_data`-Objekt liegt, wird abgegriffen und vom UPD-Tag weitergereicht — vorausgesetzt, die Felder stehen am richtigen Ort (Adressfelder unter `user_data.address`). |
| **Direkter `dataLayer.push` / `gtag('set','user_data', …)`** | Keine. Jede beliebige Teilmenge wird akzeptiert. |

**Hinweis zur ursprünglichen Annahme (korrigiert)**
In einem früheren Test schien die UPD-Variable im Code-Modus eine eigene,
mittlere Mindestregel zu haben — Pushes mit nur `first_name + last_name`
seien verworfen worden, sobald aber ein weiteres Adressfeld (z. B. nur
`country`) dazukam, lief alles durch. Diese Theorie war falsch. Tatsächlich
lag das „Verwerfen" daran, dass die Adressfelder auf der falschen
Hierarchie-Ebene lagen (flach im `user_data`-Objekt statt im
`user_data.address`-Sub-Block). Sobald die Struktur nach offizieller Spec
nested ist, läuft auch ein einzelnes `last_name` problemlos durch und landet
unverändert im `em`-Parameter — die Code-Variante validiert *gar nicht*.

**Bewertung**
Die UI-Validierung ist inhaltlich korrekt und schützt den Nutzer vor unter-
identifizierten Datensätzen. Sie ist aber die *einzige* Stelle, an der
Google das tut — sobald die UPD-Daten irgendwie programmatisch entstehen
(eigener Code, GTM-Variable im Code-Modus, Custom-HTML-Tag), gelten *keine*
Regeln mehr außer der Strukturgrammatik. Für den Beobachter im Network-Tab
ist nicht erkennbar, welcher Pfad die Daten geliefert hat.

**Implikation für die Praxis**
- Wer ausschließlich über das GTM-UI mit Feld-Mapping arbeitet, läuft
  automatisch in das offizielle Mindest-Schema.
- Alle anderen Pfade müssen die Mindestanforderung selbst sicherstellen.
- Validierungs-Tools wie diese Extension messen den `em`-Parameter
  weiterhin am offiziellen Standard (Email **oder** FN + LN + Country + PLZ)
  — nicht an dem, was Google im `em` durchlässt. Die Compliance-Pille zeigt
  also den *gesollten* Zustand, nicht zwingend den im Wire-Format
  beobachtbaren.

**Quellen / Belege**
- Eigene Tests im GTM-Container GTM-M3X2ND4, alle drei Pfade, 2026-05-09
- atomkraftwerke24.de/ectest.html (Push-Konfiguration über die Checkboxen
  „in dataLayer pushen" / „als Hash übermitteln" / „Country DE hinzufügen")
- popup.js → `checkMinReq()` (implementiert die UI-Regel als Soll-Standard)

---

## 3. `em`-Parameter transportiert auch Single-Field-Identifier — Stitching-Hypothese

**Datum:** 2026-05-09
**Setup:** Wie Finding 2 (Pfad: direkter `dataLayer.push` mit Hash-Modus,
korrekt nested unter `user_data.address`).

**Beobachtung**
Selbst minimale Teildatensätze landen vollständig im `em`-Parameter und
werden mit der Conversion an Google Ads gesendet:

- Push mit *nur* Email + `last_name` (im Address-Block, ohne Vorname, ohne
  PLZ, ohne Country) → `em` enthält `em.HASH~ln0.HASH`.
- Push mit *nur* `first_name` (allein im Address-Block, ohne irgendetwas
  sonst) → `em` enthält `fn0.HASH`.

Es gibt keine clientseitige Filterung gegen „nutzlose" Teildatensätze.

**Hypothese**
Dass Google Ads den Single-Field-Wert überhaupt annimmt, deutet darauf hin,
dass die serverseitige Auswertung **nicht je Conversion isoliert** stattfindet.
Plausible Erklärung: Google sammelt die Teildatensätze über mehrere Events
desselben Browsers/Geräts und versucht serverseitig, daraus einen vollständigen
Identifier zu *stitchen* — etwa: Event A liefert Email + Last Name, Event B
liefert First Name + ZIP + Country, gemeinsam ergeben sie einen verwertbaren
Match.

Das ist eine **Hypothese**, kein bestätigter Mechanismus. Belegbar ist nur
das clientseitige Verhalten: das Tag verwirft solche Teildatensätze nicht.

**Bewertung**
Selbst wenn Stitching tatsächlich greift, ist der praktische Nutzen
fragwürdig: Ein einzelner Vorname ist ohne weiteren Kontext kein
verwertbarer Identifier, und die Match-Qualität dürfte massiv unter dem
liegen, was ein vollständiger Datensatz pro Event erreicht. Für den
einzelnen Werbetreibenden ist das Hinschicken solcher Bruchstücke
vermutlich nicht wertschöpfend, sondern bestenfalls neutral.

**Implikation für die Praxis**
- Es ist *nicht* problematisch, wenn der `em`-Parameter mit Bruchstücken
  durchläuft — verworfen wird auf Client-Seite ohnehin nichts.
- Wer Match-Qualität optimieren will, sollte trotzdem dafür sorgen, dass
  jeder einzelne Conversion-Hit das offizielle Mindest-Set erfüllt
  (Email **oder** vollständige Adresse). Die Validator-Extension warnt
  weiterhin entsprechend, auch wenn der Hit Google nicht stört.
- Beim Debugging: ein im `em` sichtbarer `fn0.…` ohne `ln0.…` / `co0.…` /
  `zp0.…` ist kein Bug, sondern Designentscheidung des Tags.

**Quellen / Belege**
- Eigene Conversion-Tests mit reduzierten Push-Konstellationen, 2026-05-09
- Network-Tab Chrome DevTools, atomkraftwerke24.de/ectest.html

---

## 4. Pro UPD-Event zwei Requests an unterschiedliche Endpunkte — nur einer trägt den `em`

**Datum:** 2026-05-09
**Setup:** atomkraftwerke24.de/ectest.html, GTM-M3X2ND4 mit aktivem
Auto-Detection-UPD-Tag und Google-Ads-Conversion-Tag. Aufzeichnung über
die in den Validator integrierte Recording-Funktion (Side Panel) auf
`https://atomkraftwerke24.de/*`. Querverifikation in Tag Assistant: pro
ausgelöstem UPD-Event sieht man dort zwei Einträge.

**Beobachtung**
Pro UPD-/Conversion-Event verschickt das Tag systematisch **zwei
POST-Requests in derselben Millisekunde**, an zwei *unterschiedliche*
Endpunkte:

| Endpunkt | `em` im Request? | `ecsid`? |
|----------|------------------|----------|
| `https://www.google.com/pagead/form-data/<conv_id>` | **nein** | nein |
| `https://www.google.com/ccm/form-data/<conv_id>`    | **ja**   | ja  |

Das Muster ist über alle beobachteten Events stabil: form_start, form_submit,
conversion (`ec_mode=a` und `ec_mode=c`) — immer dasselbe Paar, immer mit
derselben Asymmetrie.

Zusätzlich gibt es bei der eigentlichen Conversion noch GET-Requests an
`pagead/conversion/<id>/`, `ccm/conversion/<id>/` und
`pagead/1p-conversion/<id>/`, alle drei mit dem vollständigen `em` im
Query-String. Diese sind aber Conversion-spezifisch und treten nicht je
UPD-Event auf.

**Hypothesen**
Zwei nicht ausgeschlossene Erklärungen:

1. **Getrennte Verantwortlichkeiten + serverseitige Korrelation.**
   Der `pagead/form-data`-POST liefert Tag-/Telemetrie-Kontext (`gtm`,
   `gcs`/`gcd`, `dma`, `tag_exp`, UA-Hints, `auid`), der
   `ccm/form-data`-POST trägt das Identifier-Payload (`em` plus `ecsid`).
   Die Korrelation findet serverseitig über die `ecsid`/Cookies statt.
2. **Redundanz zur Stitching-Sicherheit.**
   Beide Endpunkte nehmen Daten an und werden serverseitig auf Browser/
   Geräte-Ebene zusammengeführt. Der zweite Request ist „Versicherung",
   falls der erste verloren geht oder anders gefiltert wird.

Gegen Hypothese 2 spricht, dass die Verteilung *sehr* konsistent ist —
`pagead/form-data` ist in allen beobachteten Fällen ohne `em`,
`ccm/form-data` immer mit. Bei reiner Redundanz wäre eher zu erwarten,
dass mal der eine, mal der andere die Last trägt. Das deutet darauf hin,
dass die Endpunkte unterschiedliche Verträge haben (Hypothese 1) — was
beide aber serverseitig nicht daran hindert, in dieselbe Identifier-
Pipeline einzufließen.

**Implikation für die Praxis**
- Beim Debugging im Network-Tab nicht erschrecken, wenn `pagead/form-data`
  „leer" aussieht — das ist Designentscheidung, kein Tag-Bug.
- Wer mit Sniffer-Tools (wie der Validator-Recording-Funktion) arbeitet,
  sollte den Filter „nur Requests mit `em`" aktiv haben (Default in der
  Extension), sonst dominiert der Telemetrie-Lärm die Capture-Liste.
- Endpunkt-spezifische Debugging-Strategie: Wer die Identifier-Daten
  inspizieren will, schaut auf `ccm/form-data` (POST) und auf
  `pagead/conversion/`/`ccm/conversion/`/`1p-conversion/` (alle GET).
  Wer Tag-Verhalten/Consent-Modus debuggt, schaut auf `pagead/form-data`
  und die `1p-user-list`-GETs.

**Quellen / Belege**
- Live-Capture im Validator-Side-Panel, 2026-05-09
- Tag Assistant, je UPD-Event zwei Einträge sichtbar
- Eigene Beobachtung über mehrere Test-Conversions hinweg

---
