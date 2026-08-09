'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outputDirectory = path.resolve(process.argv[2] || 'dist');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const fileName = `CoreShift-Setup-${packageJson.version}.exe`;
const installerPath = path.join(outputDirectory, fileName);

if (!fs.existsSync(installerPath)) throw new Error(`Installer not found: ${installerPath}`);

const installer = fs.readFileSync(installerPath);
const sha512 = crypto.createHash('sha512').update(installer).digest('base64');
const size = installer.length;
const manifest = [
  `version: ${packageJson.version}`,
  'files:',
  `  - url: ${fileName}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${fileName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n');

fs.writeFileSync(path.join(outputDirectory, 'latest.yml'), manifest, 'utf8');
console.log(`Created ${path.join(outputDirectory, 'latest.yml')}`);
