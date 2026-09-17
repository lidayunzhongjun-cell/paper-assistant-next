import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheControls, fullCachePatch, paragraphCachePatch, persistPatch } from '../src/cache.mjs';
import { makeGraph, sourceUnits, graphUsable, graphIndex, rankParagraphs, graphContext, graphMarkdown } from '../src/graph.mjs';
import { makeThread, planThreadDeletion } from '../src/core.mjs';
import { PaperStore } from '../src/runtime.mjs';

function fixture() {
  const rawText = 'First source paragraph.\nSecond source paragraph.\nThird source paragraph.\n';
  const graph = makeGraph(rawText, sourceUnits(rawText), [
    { first: 1, last: 1, chapter: 'A', subsection: '', continuesPrevious: false },
    { first: 2, last: 2, chapter: 'A', subsection: '', continuesPrevious: false },
    { first: 3, last: 3, chapter: 'B', subsection: '', continuesPrevious: false }
  ]);
  for (const p of graph.paragraphs) Object.assign(p, { summary: p.id === 'p1' ? 'DELETE_NODE' : 'KEEP_' + p.id, reason: 'Reason', importance: 'high', density: 'medium', keyQuotes: ['quote'] });
  graph.chapters[0].summary = 'DELETE_CHAPTER'; graph.chapters[1].summary = 'KEEP_CHAPTER'; graph.narrative = 'DELETE_NARRATIVE';
  graph.edges.push({ from: 'p1', to: 'p2', inferred: true, type: '支持', reason: 'DELETE_EDGE' },
    { from: 'p2', to: 'p3', inferred: true, type: '支持', reason: 'KEEP_EDGE' },
    { from: 'c1', to: 'c2', inferred: true, type: '支持', reason: 'DELETE_CHAPTER_EDGE' });
  graph.terms = [{ id: 't1', name: 'Solo', definition: 'DELETE_TERM', paragraphIds: ['p1'] }, { id: 't2', name: 'Shared', definition: 'KEEP_SHARED', paragraphIds: ['p1', 'p2'] }];
  const paper = { id: '1-ABC', version: 1, title: 'Paper', attachmentID: 10, rawText, graph, overview: graph.narrative, overviewTime: 100, overviewModel: 'model', threads: [] };
  const thread = makeThread(paper, 'First source paragraph.'); thread.paragraphId = 'p1'; thread.draft = 'keep draft'; thread.mastered = true;
  thread.messages = [{ role: 'user', content: 'Question', status: 'done' }, { role: 'assistant', content: 'Answer', status: 'done', starred: true }];
  paper.threads.push(thread, makeThread(paper));
  return { paper, thread };
}

test('paragraph clear control appears only for selected text and requires a unique cached node', () => {
  const { paper, thread } = fixture();
  assert.equal(cacheControls(paper, thread).canClearParagraph, true);
  assert.equal(cacheControls(paper, paper.threads[1]).showParagraph, false);
  const unmatched = makeThread(paper, 'Other text');
  assert.equal(cacheControls(paper, unmatched).showParagraph, true);
  assert.equal(cacheControls(paper, unmatched).canClearParagraph, false);
  const ambiguous = makeThread(paper, 'source paragraph.');
  assert.match(cacheControls(paper, ambiguous).paragraphHint, /多个段落/);
  assert.throws(() => paragraphCachePatch(paper, ambiguous), /多个段落/);
});

test('full cache clearing preserves all conversations, selections, drafts, bookmarks and the PDF identity', async () => {
  const { paper, thread } = fixture();
  const preserved = structuredClone(paper.threads);
  await persistPatch(paper, paper, fullCachePatch(), { save: async () => {} });
  assert.equal(paper.rawText, ''); assert.equal(paper.graph, null); assert.equal(paper.overview, '');
  assert.equal(paper.overviewTime, null); assert.equal(paper.overviewModel, null);
  assert.deepEqual(paper.threads, preserved); assert.equal(paper.attachmentID, 10);
  assert.equal(cacheControls(paper, thread).canClearFull, false);
  assert.equal(cacheControls(paper, thread).canClearParagraph, false);
});

test('paragraph clearing removes only its analysis and derived aggregates, preserving structural retrieval and unrelated nodes', () => {
  const { paper, thread } = fixture();
  const before = structuredClone(paper);
  const patch = paragraphCachePatch(paper, thread);
  assert.deepEqual(paper, before, 'preparing clear must not mutate data');
  Object.assign(paper, patch);
  assert.equal(paper.rawText, before.rawText); assert.deepEqual(paper.threads, before.threads);
  const p = paper.graph.paragraphs[0]; assert.equal(p.summary, ''); assert.equal(p.cacheCleared, true);
  assert.deepEqual(paper.graph.paragraphs.slice(1), before.graph.paragraphs.slice(1));
  assert.equal(paper.graph.chapters[1].summary, 'KEEP_CHAPTER');
  assert.equal(paper.graph.terms.length, 1); assert.deepEqual(paper.graph.terms[0].paragraphIds, ['p2']);
  assert.ok(paper.graph.edges.some(e => e.reason === 'KEEP_EDGE'));
  assert.ok(paper.graph.edges.some(e => e.from === 'c1' && e.to === 'p1' && e.type === '包含'));
  assert.equal(graphUsable(paper), true); assert.equal(cacheControls(paper, thread).canClearParagraph, false);
  const sent = graphIndex(paper.graph, rankParagraphs(paper.graph, 'source', ['p1'])).text + JSON.stringify(graphContext(paper.graph, ['p1', 'p2']));
  for (const stale of ['DELETE_NODE', 'DELETE_CHAPTER', 'DELETE_NARRATIVE', 'DELETE_EDGE', 'DELETE_TERM']) assert.ok(!sent.includes(stale), stale);
  assert.match(graphMarkdown(paper.graph), /本段精读缓存已清除/);
  assert.ok(!graphMarkdown(paper.graph).includes('undefined'));
});

test('clearing current Q&A leaves caches, other conversations, selected source and draft intact', async () => {
  const { paper, thread } = fixture();
  paper.threads[1].messages.push({ role: 'user', content: 'Keep other question' });
  const graph = paper.graph, raw = paper.rawText;
  await persistPatch(paper, thread, { messages: [], updated: 999 }, { save: async () => {} });
  assert.deepEqual(thread.messages, []); assert.equal(thread.selection, 'First source paragraph.');
  assert.equal(thread.draft, 'keep draft'); assert.equal(thread.mastered, true);
  assert.equal(paper.graph, graph); assert.equal(paper.rawText, raw);
  assert.equal(paper.threads[1].messages.length, 1);
});

test('failed clear persistence restores exact objects and leaves no partial deletion', async () => {
  for (const kind of ['full', 'paragraph', 'messages']) {
    const { paper, thread } = fixture(); const before = structuredClone(paper);
    const originalGraph = paper.graph, originalMessages = thread.messages;
    const target = kind === 'messages' ? thread : paper;
    const patch = kind === 'full' ? fullCachePatch() : kind === 'paragraph' ? paragraphCachePatch(paper, thread) : { messages: [], newField: true };
    await assert.rejects(persistPatch(paper, target, patch, { save: async () => { throw new Error('disk failure'); } }), /disk failure/);
    assert.deepEqual(paper, before); assert.equal(paper.graph, originalGraph); assert.equal(thread.messages, originalMessages);
  }
});

test('thread deletion is persisted atomically and restores the exact list on failure', async () => {
  const { paper, thread } = fixture();
  const originalThreads = paper.threads;
  const plan = planThreadDeletion(paper, thread.id, thread.id);
  await assert.rejects(persistPatch(paper, paper, { threads: plan.threads }, { save: async () => { throw new Error('disk failure'); } }), /disk failure/);
  assert.equal(paper.threads, originalThreads); assert.equal(paper.threads[0], thread); assert.equal(thread.messages.length, 2);
  await persistPatch(paper, paper, { threads: plan.threads }, { save: async () => {} });
  assert.deepEqual(paper.threads, [plan.active]); assert.ok(!paper.threads.includes(thread));
});

test('cleared paragraph stays cleared after closing and loading from disk', async () => {
  const files = new Map();
  globalThis.Zotero = { DataDirectory: { dir: 'cache-test' } };
  globalThis.PathUtils = { join: (...p) => p.join('/') };
  globalThis.IOUtils = { exists: async p => files.has(p), readJSON: async p => JSON.parse(files.get(p)), makeDirectory: async () => {}, writeUTF8: async (p, text) => files.set(p, text) };
  const { paper, thread } = fixture(); const store = new PaperStore();
  await persistPatch(paper, paper, paragraphCachePatch(paper, thread), store);
  const restored = await new PaperStore().load({ id: paper.id, title: paper.title, attachmentID: paper.attachmentID });
  assert.equal(restored.graph.paragraphs[0].cacheCleared, true);
  assert.equal(restored.threads[0].messages.length, 2); assert.equal(graphUsable(restored), true);
});
