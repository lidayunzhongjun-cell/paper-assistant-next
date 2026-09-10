import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { validateManifest } from './validate-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const own = createRequire(path.join(root, 'package.json'));
const baseline = path.resolve(root, '../zotero-paper-mind');
const fallback = createRequire(path.join(baseline, 'package.json'));
function dependency(name) { try { return own(name); } catch { return fallback(name); } }
const esbuild = dependency('esbuild');
const { zipSync, unzipSync, strFromU8 } = dependency('fflate');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'addon/manifest.json'), 'utf8'));
validateManifest(manifest, pkg.version);
const dist = path.join(root, 'dist'); mkdirSync(dist, { recursive: true });

// Freeze the original source and original XPI once; never edit the baseline directory.
const backup = path.join(dist, 'original-source-preserved.zip');
if (!existsSync(backup)) {
  const files = {};
  const walk = (dir, relative = '') => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', '.scaffold', '.env', 'tsconfig.tsbuildinfo'].includes(name)) continue;
      const abs = path.join(dir, name); const rel = relative ? relative + '/' + name : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else files[rel] = new Uint8Array(readFileSync(abs));
    }
  };
  walk(baseline); writeFileSync(backup, zipSync(files, { level: 6 }));
}
const original = path.join(baseline, '.scaffold/build/paper-assistant.xpi');
const originalCopy = path.join(dist, 'paper-assistant-original.xpi');
if (existsSync(original) && !existsSync(originalCopy)) copyFileSync(original, originalCopy);

const bundle = await esbuild.build({ entryPoints: [path.join(root, 'src/main.mjs')], bundle: true,
  format: 'iife', globalName: 'PaperNext', target: 'firefox115', write: false, loader: { '.css': 'text' } });
const files = {
  'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)),
  'bootstrap.js': readFileSync(path.join(root, 'addon/bootstrap.js')),
  'content/main.js': Buffer.from(bundle.outputFiles[0].contents)
};
const output = path.join(dist, `paper-assistant-next-${pkg.version}.xpi`);
writeFileSync(output, zipSync(files, { level: 9 }));
const check = unzipSync(new Uint8Array(readFileSync(output)));
if (!check['content/main.js']) throw new Error('XPI 校验失败');
const readEntry = name => strFromU8(check[name]);
validateManifest(JSON.parse(readEntry('manifest.json')), pkg.version);
for (const name of Object.keys(check)) if (name.includes('\\')) throw new Error('XPI 路径错误');
const sha = crypto.createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(path.join(dist, 'SHA256.txt'), `${sha}  ${path.basename(output)}\n`);
console.log(`Built and verified: ${output}\nSHA256: ${sha}`);

// Exercise the packaged bootstrap through a minimal host adapter, not just source syntax.
const callbacks = []; const menus = []; const logs = [];
const popup = { append: item => menus.push(item) };
const host = { document: { getElementById: () => popup, createXULElement: () => ({ setAttribute() {}, addEventListener() {}, remove() { menus.splice(menus.indexOf(this), 1); } }) } };
const mocks = {
  URL, IOUtils: {}, PathUtils: {},
  Zotero: { initializationPromise: Promise.resolve(), uiReadyPromise: Promise.resolve(), getMainWindows: () => [host],
    Reader: { registerEventListener: (type, handler, id) => callbacks.push({ type, handler, id }) }, debug: s => logs.push(s) },
  Services: { scriptloader: { loadSubScript: (uri, target) => {
    if (uri !== 'mock://addon/content/main.js') throw new Error('bootstrap script path mismatch');
    vm.runInNewContext(readEntry('content/main.js'), target);
  } } }
};
vm.runInNewContext(readEntry('bootstrap.js'), mocks);
await mocks.startup({ rootURI: 'mock://addon/' });
if (menus.length !== 1 || callbacks.length !== 2 || !callbacks.every(c => c.id === manifest.applications.zotero.id) || !logs[0]?.includes('started')) throw new Error('startup smoke failed');
await mocks.shutdown();
if (menus.length) throw new Error('shutdown did not remove menu');
console.log('Packaged bootstrap smoke passed (mock Zotero host; not a real Zotero installation test).');

// Static preview uses the same template, renderer and styles, without Zotero or API calls.
const previewBundle = await esbuild.build({ entryPoints: [path.join(root, 'scripts/preview.mjs')], bundle: true,
  platform: 'node', format: 'esm', write: false, loader: { '.css': 'text' } });
const preview = await import('data:text/javascript;base64,' + Buffer.from(previewBundle.outputFiles[0].contents).toString('base64'));
writeFileSync(path.join(dist, 'reading-workspace-preview.html'), preview.html);
