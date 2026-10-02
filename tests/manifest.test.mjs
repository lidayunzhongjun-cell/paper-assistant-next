import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest, supportsZoteroVersion } from '../scripts/validate-manifest.mjs';

const manifest = JSON.parse(readFileSync(new URL('../addon/manifest.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('release manifest is complete and matches package version', () => {
  assert.doesNotThrow(() => validateManifest(manifest, pkg.version));
  assert.throws(() => validateManifest(manifest, '0.0.0'), /版本不一致/);
});

test('missing or empty Zotero fields fail before packaging, including update_url regression', () => {
  for (const field of ['id', 'update_url', 'strict_min_version', 'strict_max_version']) {
    for (const value of [undefined, '', '   ']) {
      const broken = structuredClone(manifest);
      broken.applications.zotero[field] = value;
      assert.throws(() => validateManifest(broken), { message: `applications.zotero.${field} not provided` });
    }
  }
  assert.throws(() => validateManifest({ ...manifest, applications: undefined }), /applications.zotero.id/);
});

test('update feed must be a valid credential-free HTTPS URL', () => {
  for (const url of ['__updateURL__', 'http://example.org/update.json', 'https://user:secret@example.org/update.json']) {
    const broken = structuredClone(manifest);
    broken.applications.zotero.update_url = url;
    assert.throws(() => validateManifest(broken));
  }
});

test('Next stays separate from original and rejects wildcard minimum versions', () => {
  const broken = structuredClone(manifest);
  broken.applications.zotero.id = 'paper-assistant@astralscarsmoonshadow';
  assert.throws(() => validateManifest(broken), /original plugin ID/);
  broken.applications.zotero.id = manifest.applications.zotero.id;
  broken.applications.zotero.strict_min_version = '9.*';
  assert.throws(() => validateManifest(broken), /cannot contain/);
});

test('Zotero 10.0.3 is included and the former 9.* ceiling is rejected', () => {
  assert.equal(supportsZoteroVersion(manifest, '9.0'), true);
  assert.equal(supportsZoteroVersion(manifest, '10.0.3'), true);
  assert.equal(supportsZoteroVersion(manifest, '10.1.0'), false);
  const old = structuredClone(manifest);
  old.applications.zotero.strict_max_version = '9.*';
  assert.equal(supportsZoteroVersion(old, '10.0.3'), false);
});
