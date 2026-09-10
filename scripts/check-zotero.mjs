import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { validateManifest } from './validate-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const own = createRequire(path.join(root, 'package.json'));
const fallback = createRequire(path.resolve(root, '../zotero-paper-mind/package.json'));
let fflate;
try { fflate = own('fflate'); } catch { fflate = fallback('fflate'); }
const { unzipSync, strFromU8 } = fflate;
function zipEntries(file, names) {
  const wanted = new Set(names);
  return unzipSync(new Uint8Array(readFileSync(file)), {
    filter: entry => wanted.has(entry.name)
  });
}
const readEntry = (entries, name) => strFromU8(entries[name]);

// Read-only diagnostic: execute the Zotero-specific manifest gate from the
// installed host, not a reimplementation. This does NOT run the full installer.
const omniPath = process.argv[2] || path.join(process.env.ProgramFiles || 'C:/Program Files', 'Zotero/omni.ja');
const omni = zipEntries(omniPath, ['modules/Extension.sys.mjs']);
const source = readEntry(omni, 'modules/Extension.sys.mjs');
const anchor = source.indexOf('manifest = normalized.value;');
const start = source.indexOf('if (this.type == "extension") {', anchor);
const end = source.indexOf('const isMV2 =', start);
if (anchor < 0 || start < anchor || end <= start) {
  throw new Error('Cannot locate this Zotero version\'s manifest gate; review the host source manually.');
}
const gate = source.slice(start, end);
assert.ok(gate.includes('applications.zotero.update_url not provided'), 'Host manifest gate has changed');
function errorsFor(manifest) {
  const errors = [];
  vm.runInNewContext(`(function (manifest) { ${gate} }).call(host, manifest)`, {
    manifest: structuredClone(manifest),
    host: { type: 'extension', manifestError: message => errors.push(message) }
  }, { timeout: 1000 });
  return errors;
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const xpiPath = path.join(root, `dist/paper-assistant-next-${pkg.version}.xpi`);
const xpi = zipEntries(xpiPath, ['manifest.json']);
assert.ok(xpi['manifest.json'], 'XPI integrity check failed');
const manifest = JSON.parse(readEntry(xpi, 'manifest.json'));
validateManifest(manifest, pkg.version);
const feed = JSON.parse(readFileSync(path.join(root, 'update.json'), 'utf8'));
const release = feed.addons?.[manifest.applications.zotero.id]?.updates?.find(item => item.version === pkg.version);
assert.ok(release, 'update.json does not contain this release');
assert.equal(release.update_link, `https://github.com/AstralScarsMoonshadow/paper-assistant-next/releases/download/v${pkg.version}/paper-assistant-next-${pkg.version}.xpi`);
const releaseHash = crypto.createHash('sha512').update(readFileSync(xpiPath)).digest('hex');
assert.equal(release.update_hash, `sha512:${releaseHash}`, 'update.json hash does not match XPI');

const oldPath = path.join(root, 'dist/paper-assistant-next-2.0.0.xpi');
const missingUpdate = structuredClone(manifest);
delete missingUpdate.applications.zotero.update_url;
const regression = existsSync(oldPath)
  ? JSON.parse(readEntry(zipEntries(oldPath, ['manifest.json']), 'manifest.json')) : missingUpdate;
const oldErrors = errorsFor(regression);
assert.ok(oldErrors.includes('applications.zotero.update_url not provided'), 'Missing-update-url control did not fail');
console.log(`Regression control rejected by installed Zotero gate: ${oldErrors.join('; ')}`);
const errors = errorsFor(manifest);
assert.deepEqual(errors, [], 'Packaged manifest rejected by installed Zotero gate');
console.log(`PASS: ${xpiPath}`);
console.log('PASS: update.json release URL and SHA-512 match the packaged XPI.');
console.log(`Host source: ${omniPath} -> modules/Extension.sys.mjs`);
console.log('Scope: actual Zotero-specific manifest gate only; NOT a real installation or UI acceptance test.');
