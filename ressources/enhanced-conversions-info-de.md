# Felder für Enhanced Conversions
- E-Mail-Adresse: email (Klartext) oder sha256_email_address (gehasht). Dies ist das bevorzugte Feld.
- Telefonnummer: phone_number (Klartext) oder sha256_phone_number (gehasht). Sie muss im E.164-Format vorliegen (z. B. +11231234567).
- Vorname: address.first_name (Klartext) oder address.sha256_first_name (gehasht).
- Nachname: address.last_name (Klartext) oder address.sha256_last_name (gehasht).
- Straße: address.street (nur Klartext).
- Stadt: address.city (nur Klartext).
- Region/Bundesland: address.region (nur Klartext).
- Postleitzahl: address.postal_code (nur Klartext).
- Land: address.country (nur Klartext, 2-stelliger Ländercode nach ISO 3166-1 alpha-2).

## Wichtige Hinweise zur Implementierung:
- Mindestanforderungen: Sie müssen entweder die E-Mail-Adresse, die vollständige Anschrift (Vorname, Nachname, Postleitzahl und Land) oder eine Telefonnummer (zusammen mit einer E-Mail oder dem vollständigen Namen und der Adresse) angeben.

- Normalisierung: Wenn Sie Daten selbst hashen, müssen Sie diese vorher normalisieren (z. B. Leerzeichen entfernen, Kleinschreibung, E.164-Format bei Telefonnummern).

- Hintergrund: Das Hashing erfolgt immer mit dem SHA256-Algorithmus im Hex-Format.

## Beispiele 
aus https://developers.google.com/tag-platform/tag-manager/server-side/ads-setup#enhanced_conversions:


```
<script>
  dataLayer.push({
    'event': 'formSubmitted',
    'leadsUserData': {
      'email': 'name@example.com',
      'phone_number': '+11234567890',
      'address': {
         first_name: 'John',
         last_name: 'Doe',
         street: '123 Lemon',
         city: 'Some city',
         region: 'CA',
         country: 'US',
        postal_code: '12345',
       },
     },
  });
<script>
```


```
<script>
  dataLayer.push({
    'event': 'formSubmitted',
    'leadsUserData': {
      'sha256_email_address': await hashEmail(email.trim()),
      'sha256_phone_number': await hashPhoneNumber(phoneNumber),
      'address': {
        sha265_first_name: await hashString(firstname),
        sha256_last_name: await hashString(lastname),
        sha256_street: await hashString(streetAddress),
        postal_code: '12345',
       },
     },
  });
<script>
```