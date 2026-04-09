#!/usr/bin/env node
/**
 * setup.js — one-time project setup.
 * Generates extension icons from Icon.svg and a TLS cert for local WSS.
 * Run once: node setup.js
 */

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---------- Icons from Icon.svg ----------

const svgSrc   = path.join(__dirname, 'Icon.svg');
const iconsDir = path.join(__dirname, 'extension', 'icons');

if (!fs.existsSync(svgSrc)) {
  console.error('✗ Icon.svg not found in project root');
  process.exit(1);
}

fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const out = path.join(iconsDir, `icon${size}.png`);
  try {
    execSync(
      `convert -background none -resize ${size}x${size} "${svgSrc}" "${out}"`,
      { stdio: 'pipe' }
    );
    console.log(`✓ icon${size}.png  (${fs.statSync(out).size} bytes)`);
  } catch (e) {
    console.error(`✗ icon${size}.png failed:`, e.stderr?.toString().trim() || e.message);
  }
}

console.log('\nIcons written to extension/icons/');

// ---------- TLS cert for local WSS (Firefox requires WSS even on localhost) ----------

const certDir  = path.join(__dirname, 'server', '.cert');
const certFile = path.join(certDir, 'cert.pem');
const keyFile  = path.join(certDir, 'key.pem');

if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  console.log('\n✓ TLS cert already exists (server/.cert/)');
} else {
  try {
    fs.mkdirSync(certDir, { recursive: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes` +
      ` -keyout "${keyFile}" -out "${certFile}"` +
      ` -subj "/CN=localhost"` +
      ` -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: 'pipe' }
    );
    console.log('\n✓ TLS cert generated (server/.cert/)');
  } catch (e) {
    console.error('\n✗ Could not generate TLS cert:', e.message);
    console.error('  Make sure openssl is installed, or run manually:');
    console.error('  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \\');
    console.error('    -keyout server/.cert/key.pem -out server/.cert/cert.pem -subj "/CN=localhost"');
  }
}

console.log('\nNext steps:');
console.log('  cd server && npm install');
console.log('  node server/index.js            # start both WS (8080) and WSS (8443)');
console.log('');
console.log('Firefox one-time cert trust:');
console.log('  1. Open https://localhost:8443 in Firefox');
console.log('  2. Click Advanced → Accept the Risk and Continue');
console.log('  3. Done — the extension can now connect via WSS');
