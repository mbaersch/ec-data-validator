// Base folder for Chrome profiles and test results, outside the project: on some network/VM shares
// Chrome cannot lock its profile there and the artefacts cannot be removed. EC_TMP_DIR overrides it.
const os = require('os');
const path = require('path');

const base = process.env.EC_TMP_DIR || path.join(os.tmpdir(), 'ec-data-validator');

module.exports = (name) => path.join(base, name);
