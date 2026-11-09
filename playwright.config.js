const { defineConfig } = require('playwright/test');
const tmpDir = require('./tests/tmp-dir.js');

module.exports = defineConfig({
  testDir: './tests',
  outputDir: tmpDir('test-results'),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: false,
    actionTimeout: 5_000
  }
});
