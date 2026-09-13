import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseImportedSummary, docxText, importedSummaryUsable, SUMMARY_MAX_CHARS } from '../src/imported-summary.mjs';
import { pickImportedSummary } from '../src/runtime.mjs';

const longText = '# 论文标题\n\n' + '这是一份按论文顺序整理的精炼内容，包含研究问题、方法、证据、结论与局限。'.repeat(12);

test('UTF-8 TXT and Markdown imports are normalized and keep source metadata', () => {
  const item = parseImportedSummary('C:\\notes\\paper-summary.txt', strToU8('\uFEFF' + longText.replace(/\n/g, '\r\n')));
  assert.equal(item.name, 'paper-summary.txt');
  assert.equal(item.type, 'txt');
  assert.ok(item.text.startsWith('# 论文标题\n\n'));
  assert.equal(item.charCount, item.text.length);
  assert.equal(importedSummaryUsable({ importedSummary: item }), true);
  assert.equal(parseImportedSummary('paper.md', strToU8(longText)).type, 'markdown');
});

test('DOCX parser reads paragraphs, tabs, breaks and XML entities from document.xml only', () => {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
    <w:p><w:r><w:t>标题 &amp; 方法</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">核心 </w:t><w:tab/><w:t>结论&#x4E2D;</w:t><w:br/><w:t>边界</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>变量</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>含义</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>${'完整论证单元。'.repeat(40)}</w:t></w:r></w:p>
  </w:body></w:document>`;
  const bytes = zipSync({ 'word/document.xml': strToU8(xml), 'word/header1.xml': strToU8('<w:t>不应读取的页眉</w:t>') });
  const text = docxText(bytes);
  assert.match(text, /标题 & 方法/);
  assert.match(text, /核心 \t结论中\n边界/);
  assert.match(text, /变量[\s\S]*含义/);
  assert.doesNotMatch(text, /页眉/);
  const item = parseImportedSummary('summary.docx', bytes);
  assert.equal(item.type, 'docx');
  assert.equal(item.text, text);
});

test('unsupported, legacy, corrupt, short, oversized and non-UTF-8 files fail explicitly', () => {
  assert.throws(() => parseImportedSummary('paper.doc', strToU8(longText)), /另存为.*docx/);
  assert.throws(() => parseImportedSummary('paper.pdf', strToU8(longText)), /不支持/);
  assert.throws(() => parseImportedSummary('paper.txt', Uint8Array.of(0xff, 0xfe, 0x00)), /UTF-8/);
  assert.throws(() => parseImportedSummary('paper.txt', strToU8('太短')), /至少需要/);
  assert.throws(() => parseImportedSummary('paper.docx', strToU8('not a zip')), /无法读取 DOCX/);
  assert.throws(() => parseImportedSummary('paper.docx', zipSync({ 'word/styles.xml': strToU8('<xml/>') })), /没有可读取的正文/);
  assert.throws(() => parseImportedSummary('paper.txt', strToU8('长'.repeat(SUMMARY_MAX_CHARS + 1))), /进一步凝练/);
});

test('Zotero file picker imports the selected file and cancellation performs no read', async () => {
  let selected = true, reads = 0;
  class FilePicker {
    constructor() { this.modeOpen = 0; this.returnOK = 0; this.returnReplace = 2; this.filterAll = 1; }
    init(parent, title, mode) { assert.equal(parent.name, 'host'); assert.match(title, /AI 精炼稿/); assert.equal(mode, 0); }
    appendFilter(title, filter) { assert.match(title, /DOCX/); assert.match(filter, /\*\.docx/); }
    appendFilters(mask) { assert.equal(mask, 1); }
    async show() { return selected ? this.returnOK : 1; }
    get file() { return 'D:\\paper\\summary.txt'; }
  }
  globalThis.ChromeUtils = { importESModule: uri => { assert.match(uri, /filePicker\.mjs/); return { FilePicker }; } };
  globalThis.IOUtils = { read: async (path, options) => { reads++; assert.match(path, /summary\.txt$/); assert.ok(options.maxBytes > 8 * 1024 * 1024); return strToU8(longText); } };
  globalThis.Zotero = { logError() {} };
  const item = await pickImportedSummary({ name: 'host' });
  assert.equal(item.name, 'summary.txt'); assert.equal(reads, 1);
  selected = false;
  assert.equal(await pickImportedSummary({ name: 'host' }), null);
  assert.equal(reads, 1);
});
