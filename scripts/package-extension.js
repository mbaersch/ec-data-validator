const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'manifest.json'), 'utf8'));
const version = manifest.version;
const zipFile = path.resolve(rootDir, `ec-data-validator-v${version}.zip`);

console.log('Cleaning up...');
if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true });
if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
fs.mkdirSync(distDir);

const filesToInclude = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png'
];

console.log('Copying files to dist...');
filesToInclude.forEach(file => {
  const src = path.join(rootDir, file);
  const dest = path.join(distDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  } else {
    console.warn(`Warning: File ${file} not found!`);
  }
});

console.log('Creating ZIP archive...');
try {
  const psCommand = `powershell -Command "Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipFile}' -Force"`;
  execSync(psCommand);
  console.log(`Success! Extension packaged to: ${zipFile}`);
} catch (error) {
  console.error('Error creating ZIP:', error.message);
  process.exit(1);
}

console.log('Cleaning up dist folder...');
fs.rmSync(distDir, { recursive: true });
