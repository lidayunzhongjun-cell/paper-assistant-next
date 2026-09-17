import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointURL, chunks, makeThread, planThreadDeletion, conversationRequest, evidence, exportMarkdown } from '../src/core.mjs';
import { markdown, answerHTML } from '../src/render.mjs';
import { callModel, PaperStore } from '../src/runtime.mjs';

test('base and complete endpoints do not duplicate chat/completions', () => {
  assert.equal(endpointURL('https://example.org/v1/'), 'https://example.org/v1/chat/completions');
  assert.equal(endpointURL('https://example.org/v1/chat/completions'), 'https://example.org/v1/chat/completions');
  assert.equal(endpointURL('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
  for (const value of ['file:///tmp/a', 'https://user:password@example.org/v1', 'https://example.org?key=x']) assert.throws(() => endpointURL(value));
});

test('all extracted characters survive chunking, including paragraph boundaries', () => {
  const text = 'a'.repeat(9000) + '\n' + '中文'.repeat(26000) + '\nEND';
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => p.length <= 12000));
  assert.throws(() => chunks('x', 0));
});

test('follow-up includes completed conversation and pinned paper, not failed replies', () => {
  const paper = { id: '1-AAA', title: 'First paper', overview: 'Full context', rawText: 'Before. Selected sentence. After.' };
  const thread = makeThread(paper, 'Selected sentence.');
  thread.messages = [
    { role: 'user', content: 'What is X?', status: 'done' },
    { role: 'assistant', content: 'X means alpha.', status: 'done' },
    { role: 'user', content: 'Bad request', status: 'done' },
    { role: 'assistant', content: 'Network error', status: 'error' }
  ];
  const req = conversationRequest(paper, thread, 'Why?', 'X means alpha.');
  assert.ok(req.messages.some(m => m.role === 'assistant' && m.content === 'X means alpha.'));
  assert.ok(!req.messages.some(m => m.content === 'Network error' || m.content === 'Bad request'));
  assert.match(req.messages[1].content, /First paper/);
  assert.match(req.messages.at(-1).content, /X means alpha/);
  assert.equal(thread.paperId, '1-AAA');
});

test('long histories drop oldest complete turns visibly, preserve newest question', () => {
  const paper = { id: '1-B', title: 'Paper', rawText: '', overview: '' };
  const thread = makeThread(paper, 'Excerpt');
  for (let i = 0; i < 20; i++) thread.messages.push({ role: 'user', content: `Q${i}`.repeat(300), status: 'done' }, { role: 'assistant', content: `A${i}`.repeat(300), status: 'done' });
  const request = conversationRequest(paper, thread, 'Final question', '', 5000);
  assert.ok(request.omitted > 0);
  assert.equal(request.messages.at(-1).content, 'Final question');
  assert.ok(request.messages.some(m => m.content.startsWith('A19')));
  assert.ok(!request.messages.some(m => m.content.startsWith('A0')));
  assert.equal(thread.messages.length, 40);
});

test('missing text never fabricates exact original location', () => {
  assert.match(evidence('', 'selection').label, /仅选段/);
  assert.match(evidence('different source', 'selection').label, /未找到/);
  assert.match(evidence('left selected right', 'selected').text, /left selected right/);
});

test('renderer escapes malicious HTML and preserves table empty cells', () => {
  const result = markdown('<script>alert(1)</script>\n![x](https://track.example)\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | | 3 |');
  assert.ok(!result.includes('<script>'));
  assert.ok(!result.includes('<img'));
  assert.ok(result.includes('<td></td>'));
  assert.match(result, /&lt;script&gt;/);
  assert.match(answerHTML('## 一句话抓重点\n**A**\n## 必要术语\nB'), /<details/);
});

test('code fences render literally and ordered lists remain ordered', () => {
  assert.match(markdown('1. First\n2. Second'), /<ol>/);
  assert.match(markdown('```js\n<strong>bad</strong>\n```'), /&lt;strong&gt;/);
});

test('inline and display LaTeX render locally while code and unsafe commands stay inert', () => {
  const inlineMath = markdown('后验为 \\(p(\\theta_i\\mid x) \\propto p(x\\mid\\theta_i)p(\\theta_i)\\)，并满足 $\\sum_i w_i=1$。');
  assert.match(inlineMath, /class="katex"/); assert.match(inlineMath, /<math/); assert.match(inlineMath, /msub/);
  const display = markdown('推导如下：\n$$\n\\hat{\\beta}=(X^\\top X)^{-1}X^\\top y\n$$\n其中变量保持不变。');
  assert.match(display, /class="math-block"/); assert.match(display, /class="katex-display"/); assert.match(display, /β/);
  const literal = markdown('`$x_i$` 与 \\href{javascript:alert(1)}{bad}');
  assert.match(literal, /<code>\$x_i\$<\/code>/); assert.doesNotMatch(literal, /href=/); assert.doesNotMatch(literal, /<script/);
});

test('exports all conversation rounds and original selection', () => {
  const paper = { id: '1-A', title: 'Paper' }; const thread = makeThread(paper, 'Original');
  thread.messages = [{ role: 'user', content: 'Q1', status: 'done' }, { role: 'assistant', content: 'A1', starred: true, status: 'done' }];
  const output = exportMarkdown(paper, thread);
  for (const fragment of ['Original', 'Q1', 'A1', '★']) assert.ok(output.includes(fragment));
});

test('thread deletion chooses a stable neighbor and always leaves a usable session', () => {
  const paper = { id: '1-A', title: 'Paper', threads: [] };
  const first = makeThread(paper, 'First'); const middle = makeThread(paper, 'Middle'); const last = makeThread(paper, 'Last');
  paper.threads.push(first, middle, last);
  const original = paper.threads;
  const activeDeleted = planThreadDeletion(paper, middle.id, middle.id);
  assert.deepEqual(activeDeleted.threads, [first, last]); assert.equal(activeDeleted.active, last);
  assert.equal(paper.threads, original); assert.deepEqual(paper.threads, [first, middle, last]);
  const inactiveDeleted = planThreadDeletion(paper, first.id, last.id);
  assert.equal(inactiveDeleted.active, last);
  const onlyPaper = { id: '1-B', title: 'Only', threads: [makeThread({ id: '1-B' }, 'Only selection')] };
  const finalDeleted = planThreadDeletion(onlyPaper, onlyPaper.threads[0].id);
  assert.equal(finalDeleted.threads.length, 1); assert.equal(finalDeleted.active, finalDeleted.threads[0]);
  assert.equal(finalDeleted.createdReplacement, true);
  assert.equal(finalDeleted.active.selection, ''); assert.equal(finalDeleted.active.title, '全文导读与问答');
  assert.throws(() => planThreadDeletion(paper, 'missing'), /不存在/);
});

test('real request payload preserves roles; empty local API key omits authorization', async () => {
  let sent;
  const win = { AbortController, setTimeout, clearTimeout, fetch: async (url, args) => { sent = { url, ...args }; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Success' }, finish_reason: 'stop' }] }) }; } };
  const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'follow-up' }];
  const answer = await callModel(win, { endpoint: 'http://localhost:11434/v1', model: 'test', apiKey: '' }, messages, new AbortController().signal);
  assert.equal(answer, 'Success'); assert.deepEqual(JSON.parse(sent.body).messages, messages);
  assert.equal(sent.headers.Authorization, undefined);
  assert.equal(sent.redirect, 'error');
});

test('HTTP errors do not expose upstream bodies or credentials; truncation is not success', async () => {
  const win = { AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: false, status: 401, text: async () => 'SECRET' }) };
  const config = { endpoint: 'https://example.org/v1', model: 'test', apiKey: 'KEY' };
  await assert.rejects(callModel(win, config, [], new AbortController().signal), e => e.message.includes('401') && !e.message.includes('SECRET'));
  win.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'Half' } }] }) });
  await assert.rejects(callModel(win, config, [], new AbortController().signal), /截断/);
});

test('stop aborts active network request', async () => {
  const win = { AbortController, setTimeout, clearTimeout, fetch: async (url, args) => new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('aborted')))) };
  const controller = new AbortController();
  const pending = callModel(win, { endpoint: 'http://localhost/v1', model: 'test' }, [], controller.signal);
  controller.abort(); await assert.rejects(pending, /已停止/);
});

test('per-library attachment storage is atomic, serialized, and survives a fresh store', async () => {
  const files = new Map(); const written = [];
  globalThis.Zotero = { DataDirectory: { dir: 'profile-data' } };
  globalThis.PathUtils = { join: (...parts) => parts.join('/') };
  globalThis.IOUtils = {
    exists: async path => files.has(path), readJSON: async path => JSON.parse(files.get(path)), makeDirectory: async () => {},
    writeUTF8: async (path, data, options) => { assert.equal(options.tmpPath, path + '.tmp'); await new Promise(r => setTimeout(r, 5)); files.set(path, data); written.push(JSON.parse(data).title); }
  };
  const store = new PaperStore();
  const identity = { id: '1-ABC', title: 'first', attachmentID: 123 };
  const paper = await store.load(identity); const first = store.save(paper);
  paper.title = 'second'; paper.threads.push(makeThread(paper, 'Selection')); const second = store.save(paper);
  await Promise.all([first, second]); assert.deepEqual(written, ['first', 'second']);
  const reopened = await new PaperStore().load(identity);
  assert.equal(reopened.threads[0].selection, 'Selection');
  assert.notEqual(store.path('1-ABC'), store.path('2-ABC'));
  assert.throws(() => store.path('../secret'));
});

test('corrupt history is reported and never silently overwritten', async () => {
  globalThis.IOUtils.readJSON = async () => ({ version: 99 }); globalThis.IOUtils.exists = async () => true;
  await assert.rejects(new PaperStore().load({ id: '1-ABC', title: 'Paper' }), /原文件已保留/);
});
