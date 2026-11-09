// Base folder for Chrome profiles and test results. EC_TMP_DIR moves them off the project folder:
// on some network/VM shares Chrome cannot lock its profile and the artefacts cannot be removed.
const path = require('path');

const base = process.env.EC_TMP_DIR || path.resolve(__dirname, '..');

module.exports = (name) => path.join(base, name);
