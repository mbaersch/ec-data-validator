const crypto = require('crypto');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Note: Die vom User aus echtem Google-Output gelieferten Hashes (524899ca... / I0jOm3nf...)
// entsprechen SHA256("m.baersch+test@gmail.com") — Google macht NUR lowercase, KEINE Gmail-
// Normalisierung (dots/+alias bleiben). Die Extension dagegen normalisiert Gmail auch noch.
// Fuer die Tests brauchen wir Hashes der von der Extension erwarteten Form ("mbaersch@gmail.com"),
// damit die Verification ein Match liefert.
const HASHES = {
  emailGmail: {
    raw: 'M.baersch+Test@Gmail.com',
    normalized: 'mbaersch@gmail.com',
    hex: '064967230e3ff731599a2247b93401d2ffde612b098ccc9705cd4425c43bb1c0',
    b64url: 'BklnIw4_9zFZmiJHuTQB0v_eYSsJjMyXBc1EJcQ7scA'
  },
  emailNonGmail: {
    raw: 'a.b+x@example.com',
    normalized: 'a.b+x@example.com',
    hex: sha256hex('a.b+x@example.com')
  },
  phoneE164: {
    raw: '+49123456789',
    normalized: '+49123456789',
    hex: 'b02af0a5d0a84d9c47b6f7a85d84c50b05f89a3df3493b59c011297b2ba87a14',
    b64url: 'sCrwpdCoTZxHtveoXYTFCwX4mj3zSTtZwBEpeyuoehQ'
  },
  phoneNoPlus: {
    raw: '+49123456789',
    normalized: '49123456789',
    hex: sha256hex('49123456789')
  },
  nameTest: {
    raw: 'Test',
    normalized: 'test',
    hex: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    b64url: 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg'
  }
};

const USER_DATA_FULL_JS = `{
  sha256_email_address: "${HASHES.emailGmail.hex}",
  sha256_phone_number: "${HASHES.phoneE164.hex}",
  address: {
    sha256_first_name: "${HASHES.nameTest.hex}",
    sha256_last_name: "${HASHES.nameTest.hex}"
  }
}`;

const USER_DATA_B64URL_JS = `{
  sha256_email_address: "${HASHES.emailGmail.b64url}",
  sha256_phone_number: "${HASHES.phoneE164.b64url}",
  address: {
    sha256_first_name: "${HASHES.nameTest.b64url}",
    sha256_last_name: "${HASHES.nameTest.b64url}"
  }
}`;

const USER_DATA_PHONE_META_JS = `{
  sha256_email_address: "${HASHES.emailGmail.hex}",
  sha256_phone_number: "${HASHES.phoneNoPlus.hex}",
  address: {
    sha256_first_name: "${HASHES.nameTest.hex}",
    sha256_last_name: "${HASHES.nameTest.hex}"
  }
}`;

const USER_DATA_NON_GMAIL_JS = `{
  sha256_email_address: "${HASHES.emailNonGmail.hex}"
}`;

const USER_DATA_EMPTY_JS = `{
  address: {
    country: "DE"
  }
}`;

const USER_DATA_MISPLACED_JS = `{
  sha256_email_address: "${HASHES.emailGmail.hex}",
  city: "Berlin",
  address: {
    sha256_first_name: "${HASHES.nameTest.hex}"
  }
}`;

const USER_DATA_COUNTRY_WARN_JS = `{
  sha256_email_address: "${HASHES.emailGmail.hex}",
  address: {
    sha256_first_name: "${HASHES.nameTest.hex}",
    country: "Germany"
  }
}`;

const USER_DATA_PLAINTEXT_EMAIL_JS = `{
  sha256_email_address: "not-a-hash@example.com"
}`;

const ECID_STRING_HEX =
  `tv.1~em.${HASHES.emailGmail.hex}~pn.${HASHES.phoneE164.hex}` +
  `~fn0.${HASHES.nameTest.hex}~ln0.${HASHES.nameTest.hex}`;

const ECID_STRING_B64URL =
  `tv.1~em.${HASHES.emailGmail.b64url}~pn.${HASHES.phoneE164.b64url}` +
  `~fn0.${HASHES.nameTest.b64url}~ln0.${HASHES.nameTest.b64url}`;

module.exports = {
  HASHES,
  ECID_STRING_HEX,
  ECID_STRING_B64URL,
  USER_DATA_FULL_JS,
  USER_DATA_B64URL_JS,
  USER_DATA_PHONE_META_JS,
  USER_DATA_NON_GMAIL_JS,
  USER_DATA_EMPTY_JS,
  USER_DATA_MISPLACED_JS,
  USER_DATA_COUNTRY_WARN_JS,
  USER_DATA_PLAINTEXT_EMAIL_JS
};
