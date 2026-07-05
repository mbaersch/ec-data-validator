# Plattform-Spezifikationen: User-Daten-Normalisierung & Hashing

Stand: 2026-07-05 (Detektoren live seit v2.7.0; Snapchat + Reddit ab v2.8.0)

Dieses Dokument fasst die Hashing- und Normalisierungsregeln der gaengigen
Werbeplattform-Conversion-APIs zusammen, vergleicht sie mit den jeweils
verbreitetsten Server-Side-Templates (Stape-IO) und dokumentiert
identifizierte Abweichungen zur Spezifikation. Quelle pro Aussage am Ende
jedes Abschnitts und am Dokumentende.

Ziel: Grundlage fuer (a) die Verifikations-Logik der Extension und (b) Issues
oder PRs gegen die untersuchten Templates.

## Schnellvergleich

| Plattform   | Endpunkt-Pfad                       | PII-Felder gehashed                                  | PII-Felder Klartext                                      | Phone-Format vor Hash | City Spaces im Hash | Address.street |
|-------------|-------------------------------------|------------------------------------------------------|----------------------------------------------------------|-----------------------|---------------------|----------------|
| Google Ads EC | `googleads:uploadClickConversions` etc. | em, ph, fn, ln, street                               | city, region (state), postal_code, country               | `+` + Ziffern (E.164) | n/a (city Klartext) | gehashed       |
| Meta CAPI   | `graph.facebook.com/.../events`     | em, ph, fn, ln, ct, st, zp, country, ge, db, external_id | client_ip_address, client_user_agent, fbp, fbc           | Ziffern **ohne `+`**  | **entfernt**        | nicht im Schema |
| TikTok EAPI 2.0 | `business-api.tiktok.com/.../event/track/` | email, phone, external_id, first_name, last_name, zip_code | city, state, country, ip, user_agent, ttp, ttclid        | E.164 mit `+` (Doku)  | n/a (city Klartext) | nicht im Schema |
| LinkedIn CAPI | `api.linkedin.com/rest/conversionEvents` | SHA256_EMAIL                                       | firstName, lastName, companyName, title, countryCode, IP, AcxiomID, LiveRamp, GoogleAID | n/a (kein Phone)      | n/a                 | nicht im Schema |
| Pinterest CAPI | `api.pinterest.com/.../events`     | em, ph, ge, db, ln, fn, ct, st, zp, country, hashed_maids, external_id | client_ip_address, client_user_agent, click_id           | Ziffern **ohne `+`**  | **entfernt**        | nicht im Schema |
| Microsoft CAPI | `capi.uet.microsoft.com/v1/{tagID}/events` | em, ph                                          | clientIpAddress, clientUserAgent, msclkid, anonymousId, externalId, idfa, gaid | E.164 mit `+`         | n/a                 | nicht im Schema |
| Snapchat Pixel | `tr.snapchat.com/p` (GET-Beacon)  | u_hem, u_hpn, u_fn, u_ln, **u_age**, l_city, l_gc, l_gpc, l_gr | — (POST `/p` = Telemetrie, ignoriert)          | Ziffern **ohne `+`**  | **bleiben** (nur lowercase) | n/a |
| Reddit Pixel | `alb.reddit.com/rp.gif` (GET-Beacon) | em, pn, external_id, auto_em, auto_pn          | —                                                        | E.164 mit `+`         | n/a                 | n/a |

Email-Normalisierung divergiert kraeftiger als oben darstellbar; Detail in
den jeweiligen Abschnitten.

---

## Google Ads — Enhanced Conversions

### Felder & Regeln

| Feld          | Hashed? | Normalisierung                                                                 |
|---------------|---------|--------------------------------------------------------------------------------|
| `email_address` | SHA256 | `trim().toLowerCase()`. Bei Domain `gmail.com`/`googlemail.com`: zusaetzlich alle Dots aus dem Local-Part entfernen UND `+suffix` strippen. |
| `phone_number`  | SHA256 | E.164-Format mit fuehrendem `+`, sonst nur Ziffern. Beispiel: `+18005550200`. |
| `first_name`    | SHA256 | `trim().toLowerCase()`. |
| `last_name`     | SHA256 | `trim().toLowerCase()`. |
| `street_address`| SHA256 | `trim().toLowerCase()`. Empirisch verifiziert: Google entfernt Hausnummern und Satzzeichen (`.`, `-`) vor dem internen Match — Sender muss das **nicht** vorbereiten. Umlaute/ß bleiben. |
| `city`          | Klartext | empfohlen lowercase + trim, Spaces drin lassen. |
| `region`        | Klartext | ISO-3166-2 Subdivision oder bekannter State-Name. |
| `postal_code`   | Klartext | as-is. |
| `country_code`  | Klartext | ISO-3166 alpha-2. |

Hash-Algorithmus: SHA-256, Output als **hex lowercase** ODER **base64url**
(Web-Tag akzeptiert beide; sGTM-Tag sendet hex).

Quellen: [Google Ads API — Enhance conversions](https://developers.google.com/google-ads/api/docs/conversions/enhance-conversions),
[Manage online click conversions](https://developers.google.com/google-ads/api/docs/conversions/upload-online).

### Beobachtungen aus dem Web-Tag

Der Browser-Tag akzeptiert Felder unter mehreren Schluesselnamen
(`email`/`email_address`/`sha256_email_address`), wickelt Adressen je nach
Mode in `address: {...}` oder `address: [{...}]`. Die Extension behandelt
beide Varianten und unterstuetzt hex + base64url als Hash-Encoding.

---

## Meta — Conversions API

### Felder & Regeln

| Feld     | Hashed? | Normalisierung                                                                 |
|----------|---------|--------------------------------------------------------------------------------|
| `em`     | SHA256  | `trim().toLowerCase()`. (Keine Gmail-Spezialbehandlung.)                       |
| `ph`     | SHA256  | Nur Ziffern, **kein `+`**, keine Leerzeichen/Bindestriche/Klammern.           |
| `fn`     | SHA256  | `trim().toLowerCase()`.                                                       |
| `ln`     | SHA256  | `trim().toLowerCase()`.                                                       |
| `ct`     | SHA256  | `trim().toLowerCase()` + **alle Leerzeichen entfernen**.                       |
| `st`     | SHA256  | `trim().toLowerCase()`. Bevorzugt 2-Letter-Code.                              |
| `zp`     | SHA256  | `trim().toLowerCase()`.                                                       |
| `country`| SHA256  | `trim().toLowerCase()`. ISO-3166 alpha-2.                                     |
| `ge`     | SHA256  | `"m"` oder `"f"`.                                                              |
| `db`     | SHA256  | `YYYYMMDD`.                                                                    |
| `external_id` | SHA256 | `trim().toLowerCase()`.                                                  |
| `fbp`, `fbc`, `client_ip_address`, `client_user_agent` | Klartext | as-is. |
| `address.street` | — | **Nicht im CAPI-Schema vorgesehen.** Wird ignoriert. |

Hash-Algorithmus: SHA-256, Output als **hex lowercase**.

Quelle: [Meta CAPI — Customer Information Parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters).

### Untersuchtes Template — stape-io/facebook-tag

Repo: [stape-io/facebook-tag](https://github.com/stape-io/facebook-tag).
Relevante Funktion: `hashData(key, value)` in `template.tpl`.

```js
value = makeString(value).trim().toLowerCase();
if (key === 'ph') value = normalizePhoneNumber(value);   // entfernt non-digit, inkl. '+'
else if (key === 'ct') value = value.split(' ').join(''); // entfernt alle Spaces
```

**Spec-konform:**
- Email-Normalisierung
- Phone (kein `+`, nur Ziffern)
- City (Spaces raus)
- `isHashed`-Pass-through (64-Char-Hex wird nicht erneut gehashed)
- Address-Array nimmt nur `[0]` (zweites Element wird ignoriert — vertretbar)

**Abweichungen / Empfehlungen fuer Issue/PR:**

1. **Keine Diakritika-Normalisierung.** `Bärbel` wird zu `bärbel` und so gehashed.
   Meta toleriert das in der Praxis (interner Server foldet vermutlich), aber
   die Match-Rate koennte mit ASCII-Folding (NFD + Combining-Marks raus) steigen.
   Vorschlag: optionale Toggle `normalizeDiacritics`.
2. **Nur erstes Adress-Element ausgewertet.** Bei Multi-Address-Profilen geht
   die zweite Adresse verloren. Bedarf gering, aber dokumentationswert.

---

## TikTok — Events API 2.0

### Felder & Regeln

`data[].user` (NICHT `user_data` wie bei Meta).

| Feld           | Hashed? | Normalisierung                                              |
|----------------|---------|-------------------------------------------------------------|
| `email`        | SHA256  | `trim().toLowerCase()`.                                     |
| `phone`        | SHA256  | **E.164-Format mit fuehrendem `+`** vor `trim().toLowerCase().sha256()`. |
| `external_id`  | SHA256  | `trim().toLowerCase()`.                                     |
| `first_name`   | SHA256  | `trim().toLowerCase()`.                                     |
| `last_name`    | SHA256  | `trim().toLowerCase()`.                                     |
| `zip_code`     | SHA256  | `trim().toLowerCase()`.                                     |
| `city`         | Klartext | as-is. TikTok normalisiert serverseitig.                   |
| `state`        | Klartext | as-is.                                                      |
| `country`      | Klartext | ISO-3166 alpha-2, Klartext.                                 |
| `ip`           | Klartext | IPv4/IPv6.                                                  |
| `user_agent`   | Klartext | UA-String.                                                  |
| `ttp`          | Klartext | First-Party-Cookie `_ttp`.                                  |
| `ttclid`       | Klartext | URL-Click-ID.                                               |
| `idfa`/`idfv`/`gaid`/`att_status` | Klartext | App-Felder.                       |

Hash-Algorithmus: SHA-256, Output als **hex lowercase**.

Quellen: [TikTok Events API 2.0 — Parameter Specs](https://business-api.tiktok.com/portal/docs?id=1771101151059969),
[Matching with Events API](https://ads.tiktok.com/help/article/how-to-set-up-matching-events-with-events-api?lang=en).

### Untersuchtes Template — stape-io/tiktok-tag

Repo: [stape-io/tiktok-tag](https://github.com/stape-io/tiktok-tag).

```js
return sha256Sync(makeString(value).trim().toLowerCase(), {
  outputEncoding: 'hex'
});
```

**Abweichungen / Empfehlungen fuer Issue/PR:**

1. **Phone-E.164-Normalisierung fehlt komplett.** Anders als das
   FB-Template ruft das TikTok-Template keine `normalizePhoneNumber()`-
   Variante auf. Wer Phone als `0177 6132720`, `+49 177 6132720`,
   `0049-177-6132720` reinwirft, bekommt drei unterschiedliche Hashes —
   alle nicht spec-konform (TikTok erwartet E.164 mit `+`).
   **Vorschlag (PR-tauglich):** vor `sha256Sync()` einen Aufruf
   einfuegen, der Whitespaces/Bindestriche/Klammern entfernt und ein
   fuehrendes `+` erzwingt, sobald `key === 'phone'`.
2. **Keine Diakritika-Normalisierung** (gleicher Punkt wie FB).
3. **Address-Array nur `[0]`** (Zeile 1209).

---

## LinkedIn — Conversions API

### Felder & Regeln

Struktur ist anders als bei den anderen: `user.userIds[]` (Liste von
`{idType, idValue}`-Paaren) + `user.userInfo{}` (Klartext-Probabilistic-Match).

| Bereich                                                  | Feld                 | Hashed? | Regel                                |
|----------------------------------------------------------|----------------------|---------|--------------------------------------|
| `userIds[]` `idType=SHA256_EMAIL`                        | Email                | SHA256  | `lower-case, without any whitespaces` dann SHA256 hex. |
| `userIds[]` `idType=LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID` | `li_fat_id` Cookie/Param | Klartext | as-is.                            |
| `userIds[]` `idType=ACXIOM_ID`                           | LiveRamp/Acxiom-ID   | Klartext | as-is.                              |
| `userIds[]` `idType=PLAINTEXT_IP_ADDRESS`                | IPv4                 | Klartext | LinkedIn hashed serverseitig mit Salt. |
| `userIds[]` `idType=GOOGLE_AID`                          | Android-Ad-ID        | Klartext | as-is.                              |
| `userInfo.firstName`                                     | Vorname              | Klartext | as-is. Pflicht wenn `userInfo` gesetzt. |
| `userInfo.lastName`                                      | Nachname             | Klartext | as-is. Pflicht wenn `userInfo` gesetzt. |
| `userInfo.companyName`                                   | Firma                | Klartext | as-is.                              |
| `userInfo.title`                                         | Job-Titel            | Klartext | as-is.                              |
| `userInfo.countryCode`                                   | ISO-2                | Klartext | as-is.                              |
| `externalIds[]`                                          | Advertiser-Kunden-ID | Klartext | max. 1 Element.                     |
| `lead`                                                   | LeadGenFormResponse-URN | Klartext | aus LinkedIn-Lead-Form.          |

**Was LinkedIn nicht kennt:** Kein Phone (weder Klartext noch gehashed), keine
Adress-Felder (Street, City, Zip, State), kein Geburtsdatum, kein Geschlecht.

Quelle: [LinkedIn Conversions API Schema (Microsoft Learn, 2026-05)](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api-schema).

### Untersuchtes Template — stape-io/linkedin-tag

Repo: [stape-io/linkedin-tag](https://github.com/stape-io/linkedin-tag).

```js
function hashData(value) {
  if (isHashed(value)) return value;
  value = makeString(value).trim().toLowerCase();
  return sha256Sync(value, { outputEncoding: 'hex' });
}
```

**Abweichungen / Empfehlungen fuer Issue/PR:**

1. **Email-Spec verletzt strenggenommen.** LinkedIn fordert "without any
   whitespaces" (auch innere). Stape macht nur `trim()`. Realweltimpact
   nahe Null, da RFC-5321 keine inneren Spaces zulaesst — aber Spec
   verletzt.
   **Vorschlag:** `value.replace(/\s/g, '')` statt `trim()`.
2. **Veralteter idType-Katalog.** Template kennt `ORACLE_MOAT_ID` (in der
   aktuellen 2026-05-Doku **nicht mehr aufgefuehrt**), unterstuetzt aber
   die aktuell dokumentierten `PLAINTEXT_IP_ADDRESS` und `GOOGLE_AID`
   **nicht**. **Vorschlag:** `ORACLE_MOAT_ID` entfernen oder als Legacy
   markieren, `PLAINTEXT_IP_ADDRESS` und `GOOGLE_AID` als waehlbare
   `idType` aufnehmen.
3. **Phone aus eingehendem `eventData` wird stillschweigend verworfen.**
   Klar — LinkedIn akzeptiert kein Phone — aber eine UI-Warnung waere
   netter als stille Datensenke.

---

## Pinterest — Conversions API

### Felder & Regeln

| Feld                  | Hashed? | Normalisierung                                                            |
|-----------------------|---------|---------------------------------------------------------------------------|
| `em`                  | SHA256  | `lowercase` + **alle Leerzeichen entfernen**. (Pinterest-Doku verlangt das explizit.) |
| `ph`                  | SHA256  | Nur Ziffern, **kein `+`**, keine Symbole/Buchstaben/Spaces, fuehrende Nullen entfernen. |
| `ge`                  | SHA256  | `"m"`/`"f"`/`"n"` (lowercase).                                            |
| `db`                  | SHA256  | `YYYYMMDD`.                                                                |
| `fn`                  | SHA256  | `trim().toLowerCase()`.                                                   |
| `ln`                  | SHA256  | `trim().toLowerCase()`.                                                   |
| `ct`                  | SHA256  | `lowercase` + **alle Leerzeichen entfernen** (laut Pinterest-Doku, analog Meta). |
| `st`                  | SHA256  | 2-Letter-Code lowercase.                                                  |
| `zp`                  | SHA256  | Nur Ziffern.                                                              |
| `country`             | SHA256  | ISO-3166 alpha-2 lowercase.                                               |
| `external_id`         | SHA256  | `trim().toLowerCase()`.                                                   |
| `hashed_maids`        | SHA256  | IDFA/GAID lowercase, dann SHA256.                                         |
| `client_ip_address`   | Klartext | IPv4/IPv6.                                                                |
| `client_user_agent`   | Klartext | UA-String.                                                                |
| `click_id`            | Klartext | `_epik`-Cookie-Wert.                                                       |

Wichtig: Pinterest erwartet die gehashten Felder als **Array von Strings**,
nicht als Einzelstring — auch wenn nur ein Wert vorliegt
(`em: ["abc...def"]`).

Hash-Algorithmus: SHA-256, Output als **hex lowercase**.

Quellen: [Pinterest Conversions API — Track conversion events](https://developers.pinterest.com/docs/conversions/updated/),
[Pinterest Enhanced Match](https://help.pinterest.com/en/business/article/enhanced-match),
[Pinterest API v5 — ConversionEventsUserData (Generated Client)](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/ConversionEventsUserDataAnyOf2.md).

### Untersuchtes Template — stape-io/pinterest-capi-tag

Repo: [stape-io/pinterest-capi-tag](https://github.com/stape-io/pinterest-capi-tag).

```js
value = makeString(value).trim().toLowerCase();
if (key === 'ph') {
  value = value.split(' ').join('').split('-').join('')
              .split('(').join('').split(')').join('').split('+').join('');
} else if (key === 'ct') {
  value = value.split(' ').join('');
}
return sha256Sync(value, { outputEncoding: 'hex' });
```

**Spec-konform:**
- Phone (Spaces, `-`, `()`, `+` weg)
- City (Spaces weg)
- Werte werden in Arrays gewrappt (Pinterest-Anforderung)

**Abweichungen / Empfehlungen fuer Issue/PR:**

1. **Email-Spaces werden NICHT entfernt.** Pinterest's Enhanced-Match-Doku
   sagt explizit: "needs to be lowercase and have all spaces removed".
   Stape macht nur `trim().toLowerCase()` — innere Spaces (selten, aber
   theoretisch moeglich bei kaputten Quellen) bleiben.
   **Vorschlag (PR-tauglich):** In `hashData`, vor dem SHA256, fuer
   `key === 'em'` zusaetzlich `value.split(' ').join('')` (analog
   Behandlung von `ct`).
2. **Phone strippt nicht ALLE Nicht-Ziffern.** Buchstaben (z.B.
   `"ext. 123"`) bleiben drin. Pinterest's Doku sagt "any symbols, letters,
   spaces and leading zeros removed".
   **Vorschlag:** `value.replace(/\D/g, '').replace(/^0+/, '')`.
3. **Fuehrende Nullen bei Phone nicht entfernt** (Pinterest-Doku verlangt
   das ausdruecklich).
4. **Keine Diakritika-Normalisierung** (gleicher Punkt wie Meta/TikTok).

---

## Microsoft Advertising — Conversions API (CAPI)

### Felder & Regeln

`userData`-Objekt im Event-Body:

| Feld                | Hashed? | Normalisierung                                                                                   |
|---------------------|---------|--------------------------------------------------------------------------------------------------|
| `em`                | SHA256  | **(1) `trim()`, (2) ALLE Dots aus Local-Part entfernen, (3) `+alias` strippen, (4) lowercase, (5) SHA256 hex lowercase.** Achtung: **fuer ALLE Domains**, nicht nur Gmail. |
| `ph`                | SHA256  | E.164 mit `+` (z. B. `+14255551234`), dann SHA256 hex lowercase.                                 |
| `externalId`        | Klartext (anonymisiert) | 32-Byte-Hex empfohlen.                                                                |
| `anonymousId`       | Klartext | UUID v1 bevorzugt; muss mit ID-Sync-`vid` matchen.                                              |
| `clientIpAddress`   | Klartext | IPv4/IPv6.                                                                                       |
| `clientUserAgent`   | Klartext | UA-String.                                                                                       |
| `msclkid`           | Klartext | Microsoft Click ID aus Landing-Page-URL.                                                         |
| `idfa`/`gaid`       | Klartext | Mobile-Ad-IDs.                                                                                   |

**Was Microsoft NICHT akzeptiert:** Keine first_name/last_name/address-Felder
ueberhaupt. Nur `em`, `ph` und Identifier. Sehr schmal verglichen mit
Meta/Pinterest.

API antwortet mit **HTTP 400 `ValidationError: 'em' must be a valid SHA256
string`** wenn Klartext geschickt wird — Hashing ist Pflicht.

Quelle: [Microsoft Advertising — Conversions API (CAPI) Guide](https://learn.microsoft.com/en-us/advertising/guides/uet-conversion-api-integration?view=bingads-13).

### Bemerkenswerte Eigenheit gegenueber Google

Google strippt Dots/`+alias` **nur fuer `gmail.com`/`googlemail.com`**;
Microsoft strippt sie **fuer ALLE Domains**. Konsequenz:
`Jane.Doe+Shopping@contoso.com` ergibt unterschiedliche Hashes:

- Google EC: `sha256("jane.doe+shopping@contoso.com")`
- Microsoft CAPI: `sha256("janedoe@contoso.com")`

Wer parallel an beide Plattformen sendet, braucht zwei Email-Hash-Varianten.

### Untersuchtes Template — stape-io/microsoft-capi-tag

Repo: [stape-io/microsoft-capi-tag](https://github.com/stape-io/microsoft-capi-tag).

```js
function normalizeEmail(email) {
  const emailSplit = email.split('@');
  emailSplit[0] = emailSplit[0].split('.').join('').split('+')[0];
  return emailSplit.join('@');
}
function normalizePhoneNumber(phoneNumber) {
  return phoneNumber.split(' ').join('').split('-').join('')
                    .split('(').join('').split(')').join('');
}
```

**Spec-konform:**
- Email: Dots-Strip + `+alias`-Strip fuer alle Domains (entspricht MS Spec)
- Phone: Spaces/`-`/`()` weg, `+` bleibt (E.164-konform)
- `isHashed`-Pass-through
- Korrekte Validierungs-Asserts in Tests (Hash-Format-Check)

**Abweichungen / Empfehlungen fuer Issue/PR:**

1. **`normalizeEmail` macht NICHT `toLowerCase()` als Teil der Normalisierung.**
   Das passiert erst in `hashData()` via `trim().toLowerCase()` — also
   funktional ok, aber Reihenfolge ist anders als in der MS-Doku
   beschrieben. Edge case: `JANE.DOE+SHOPPING@CONTOSO.COM` → wird zu
   `JANEDOE@CONTOSO.COM` → in `hashData()` zu `janedoe@contoso.com` →
   passt. Aber: wenn jemand die `normalizeEmail`-Funktion isoliert nutzt
   oder die Reihenfolge umstellt, ist das fragil.
   **Vorschlag:** lowercase als ersten Schritt in `normalizeEmail`.
2. **`normalizePhoneNumber` strippt nicht alle Nicht-Ziffern (ausser `+`).**
   Wenn Phone als `"+1 (425) 555-1234 ext. 99"` reinkommt, bleibt `ext.99`
   im Hash. MS erwartet striktes E.164 ohne Erweiterungen.
   **Vorschlag:** `phoneNumber.replace(/[^\d+]/g, '')` als robusterer
   Einzeiler.
3. **Keine Diakritika-Normalisierung** — egal weil MS keine Namensfelder
   akzeptiert. Hier kein Issue.

### Untersuchtes Template — stape-io/microsoft-ads-offline-conversion-tag

Repo: [stape-io/microsoft-ads-offline-conversion-tag](https://github.com/stape-io/microsoft-ads-offline-conversion-tag).
Zweck: Offline-Conversion-Upload via Bulk-API (`OfflineConversion` und
`OfflineConversionAdjustment`-Objekte). Verwendet ebenfalls
`HashedEmailAddress` und `HashedPhoneNumber` — gleiche Normalisierungsregeln
wie CAPI.

---

## Snapchat — Pixel (Browser)

Kein Server-CAPI hier untersucht; die Extension liest den **Browser-Pixel** auf
`tr.snapchat.com/p`. Nur die **GET** `/p` traegt Identifier — die POST `/p` ist
reine Telemetrie ohne PII und wird ignoriert (das Verlangen von `pid`+`ev`
schliesst sie sauber aus). Normalisierung durchgehend **nur lowercase**
(verifiziert an `u_fn`/`u_age`/`l_*`); Telefon **ohne** `+`.

### Felder & Regeln

| Feld     | Bucket     | Hashed? | Normalisierung                                                                 |
|----------|------------|---------|--------------------------------------------------------------------------------|
| `u_hem`  | Email      | SHA256  | `trim().toLowerCase()`.                                                         |
| `u_hpn`  | Phone      | SHA256  | Ziffern, **ohne `+`**.                                                          |
| `u_fn`   | First name | SHA256  | nur lowercase (Punktuation bleibt, anders als Meta/Google).                    |
| `u_ln`   | Last name  | SHA256  | nur lowercase.                                                                  |
| `u_age`  | Age        | SHA256  | Ziffern-String, lowercase (No-op).                                             |
| `l_city` | City       | SHA256  | nur lowercase (**Spaces bleiben**).                                            |
| `l_gc`   | Country    | SHA256  | lowercase.                                                                      |
| `l_gpc`  | Postal     | SHA256  | lowercase.                                                                      |
| `l_gr`   | Region     | SHA256  | lowercase.                                                                      |
| `u_hed`  | Composite  | SHA256  | abgeleiteter Kombi-Hash, kein einzelner Klartext → hash-only, nicht validierbar. |

Snapchat hasht also **auch Geo und Alter**. E-Commerce in `e_*`, Dedup via
`cdid`, Pixel-ID in `pid`/`pids`, Event in `ev`.

Quelle: `tracking-auditor-extension/lib/snapchat.js` + beobachtete
`tr.snapchat.com/p`-Requests. Verifiziert: `sha256("test@example.com")` →
`973dfe46…`.

---

## Reddit — Pixel (Browser)

Browser-Pixel auf `alb.reddit.com/rp.gif` (GET-Beacon). Das ist der **einzige**
Beacon mit User-Identifiern (kein separater Advanced-Matching-Request). Email
`trim().toLowerCase()`, Telefon **E.164 mit `+`** (anders als Meta/Pinterest,
die ohne `+` hashen).

### Felder & Regeln

| Feld          | Bucket      | Hashed? | Normalisierung                                          |
|---------------|-------------|---------|---------------------------------------------------------|
| `em`          | Email       | SHA256  | `trim().toLowerCase()`.                                 |
| `pn`          | Phone       | SHA256  | E.164 **mit `+`**.                                      |
| `external_id` | External ID | SHA256  | opak (exact/case-preserving), nie als Leak markiert.    |
| `auto_em`     | Email       | SHA256  | **Komma-Liste** auto-erfasster Hashes.                  |
| `auto_pn`     | Phone       | SHA256  | **Pipe-Liste** `gewicht~hash` auto-erfasster Hashes.    |

Conversion/Metadaten in `m.*`; `m.valueDecimal` ist **Komma-Dezimal** (z. B.
`12,55`). Account-/Pixel-ID `id` (Format `a2_…`), Event in `event` (Default
`PageVisit`). Die Auto-Listen erscheinen als Card-Pills, werden aber nicht
einzeln validiert (Listen statt Einzel-Slots).

Quelle: `tracking-auditor-extension/lib/reddit.js` + beobachtete
`rp.gif`-Requests.

---

## Implikationen fuer die Extension

**Status (v2.8.0):** Die Extension validiert nicht mehr nur Google-EC. Sieben
**client-seitige PII-Leak-Detektoren** sind umgesetzt — Meta Pixel, TikTok
Pixel, Pinterest, Bing UET, LinkedIn Insight Tag, Snapchat Pixel und Reddit
Pixel — als optionale, default-off Dienste (`detectors.js`, provider-agnostische
Registry). Sie lesen die **Browser-Pixel-Requests** (nicht die hier
dokumentierten Server-CAPIs), verwenden aber genau die oben aufgefuehrten
Normalisierungs- und Hash-Regeln. Die pro-Plattform-Divergenzen sind damit
produktiv relevant:

1. **Phone `+` vs. ohne:** Meta + Pinterest + **Snapchat** ohne `+`, TikTok +
   Bing + **Reddit** als E.164 mit `+`. In den Detektoren als `normPhone` /
   `normPhoneNoPlus` (ohne `+`) bzw. `normPhoneE164` (mit `+`) abgebildet.
2. **Email-Spaces:** Pinterest strippt alle Leerzeichen (`normEmailNoSpace`),
   die anderen nur `trim().toLowerCase()`.
3. **Multi-Algo:** Pinterest akzeptiert SHA-256/SHA-1/MD5 — der Algorithmus
   wird per Hex-Laenge (64/40/32) erkannt und entsprechend validiert.
4. **`external_id` opak:** kein PII, wird nie als Leak markiert; gehasht
   exakt/case-preserving validiert.
5. **RAW-Diagnose:** matcht ein Hash nur gegen den **un-normalisierten**
   Eingabewert, warnt die Extension (orange „RAW · NOT NORMALIZED"), weil der
   Wert auf der Plattform-Seite nie matchen wird.

Der urspruenglich hier vorgeschlagene „zweiter Tab"-Ansatz wurde bewusst
verworfen — die Detektoren fuegen sich stattdessen in den bestehenden
einheitlichen Capture-/Decoder-Flow ein (provider-getoente Karten, Klick laedt
die Hash-Slots ins gemeinsame PII-Parameters-Feld).

**Weiterhin dokumentierte Divergenzen** (relevant fuer eine spaetere
Erweiterung auf die Server-CAPIs oben — die Detektoren lesen bisher nur die
Browser-Pixel):

- **Email Dot/`+`-Strip:** Google macht das nur fuer Gmail/Googlemail,
  Microsoft fuer **alle** Domains — derselbe Input ergibt je nach Plattform
  unterschiedliche Email-Hashes.
- **City hashen nur Meta + Pinterest** (beide mit entfernten Spaces);
  Google/TikTok/MS senden city Klartext oder gar nicht.
- **Microsoft CAPI vs. Bing UET (Pixel):** die Server-CAPI erwartet zusaetzlich
  Dot/`+`-Strip fuer alle Domains — der client-seitige Bing-UET-Detektor
  normalisiert Email dagegen wie beobachtet (`trim().toLowerCase()`).

---

## Quellen (gesammelt)

### Plattform-Dokumentationen

- Google Ads API — [Enhance conversions](https://developers.google.com/google-ads/api/docs/conversions/enhance-conversions)
- Google Ads API — [Manage online click conversions](https://developers.google.com/google-ads/api/docs/conversions/upload-online)
- Meta — [Conversions API Customer Information Parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters)
- TikTok — [Events API 2.0 Parameter Specs](https://business-api.tiktok.com/portal/docs?id=1771101151059969)
- TikTok — [Set up matching events with Events API](https://ads.tiktok.com/help/article/how-to-set-up-matching-events-with-events-api?lang=en)
- LinkedIn — [Conversions API Schema (Microsoft Learn)](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api-schema)
- LinkedIn — [Conversions API Overview](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api)
- Pinterest — [Conversions API: Track conversion events](https://developers.pinterest.com/docs/conversions/updated/)
- Pinterest — [Enhanced Match Help](https://help.pinterest.com/en/business/article/enhanced-match)
- Pinterest — [Python API Client: ConversionEventsUserData Schema](https://github.com/pinterest/pinterest-python-generated-api-client/blob/main/docs/ConversionEventsUserDataAnyOf2.md)
- Microsoft — [Conversions API (CAPI) Guide](https://learn.microsoft.com/en-us/advertising/guides/uet-conversion-api-integration?view=bingads-13)
- Microsoft — [Offline Conversion Bulk API](https://learn.microsoft.com/en-us/advertising/bulk-service/offline-conversion?view=bingads-13)

### Untersuchte Templates

- [stape-io/facebook-tag](https://github.com/stape-io/facebook-tag)
- [stape-io/tiktok-tag](https://github.com/stape-io/tiktok-tag)
- [stape-io/linkedin-tag](https://github.com/stape-io/linkedin-tag)
- [stape-io/pinterest-capi-tag](https://github.com/stape-io/pinterest-capi-tag)
- [stape-io/microsoft-capi-tag](https://github.com/stape-io/microsoft-capi-tag)
- [stape-io/microsoft-ads-offline-conversion-tag](https://github.com/stape-io/microsoft-ads-offline-conversion-tag)
