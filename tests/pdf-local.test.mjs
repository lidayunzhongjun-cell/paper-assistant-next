import test from 'node:test';
import assert from 'node:assert/strict';
import { makePdfLocalGraph, boundedPdfEvidence, enhancePdfGraph } from '../src/pdf-local-graph.mjs';
import { bm25Scores } from '../src/local-index.mjs';
import { rankParagraphs, graphContext, graphMarkdown } from '../src/graph.mjs';
import { prepareConversation } from '../src/graph-runtime.mjs';
import { makeThread } from '../src/core.mjs';

const raw = `1 Introduction
A confounder affects both treatment and outcome. This is the research problem.
2 Methods
We propose an adjustment algorithm under exchangeability. The method estimates causal effects.
3 Results
Our experiment reports 84% accuracy. However, the sample is small and confidence intervals are wide.
`;
const config = { endpoint: 'https://example.test/v1', model: 'test-model', apiKey: '' };
function mock(reply, sent) {
  return { AbortController, setTimeout, clearTimeout, fetch: async (_url, args) => {
    sent.push(JSON.parse(args.body));
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }) };
  } };
}

test('local PDF graph covers all extracted characters and stores searchable evidence without API', () => {
  const graph = makePdfLocalGraph(raw);
  assert.equal(graph.buildMode, 'pdf-local-v1');
  assert.equal(graph.enrichmentStatus, 'local-only');
  assert.equal(graph.chapters.length, 3);
  assert.equal(graph.paragraphs.map(p => raw.slice(p.start, p.end)).join(''), raw);
  assert.ok(graph.paragraphs.every(p => p.keyQuotes.every(q => raw.slice(p.start, p.end).includes(q))));
  assert.equal(graph.localIndex.lengths.length, graph.paragraphs.length);
  const scores = bm25Scores(graph.localIndex, 'exchangeability adjustment algorithm');
  assert.equal(scores.indexOf(Math.max(...scores)), 1);
  assert.equal(rankParagraphs(graph, 'exchangeability adjustment')[0].p.id, 'p2');
  const evidence = boundedPdfEvidence(graph, raw, 6000);
  assert.ok(evidence.text.length <= 6000);
  assert.ok(evidence.paragraphIds.every(id => evidence.text.includes(`[${id} |`)));
});

test('one AI request enriches only source-linked fields; follow-ups route locally', async () => {
  const graph = makePdfLocalGraph(raw), sent = [];
  const reply = JSON.stringify({
    overview: { text: '问题—调整方法—实验结果。', sourceIds: ['p1', 'p2', 'p3'] },
    knowledge: [{ role: '核心方法', text: '调整混杂因素。', sourceIds: ['p2'] },
      { role: '主要结果', text: '没有依据的结果。', sourceIds: ['p999'] }],
    chapters: [{ id: 'c2', summary: '方法章节解释调整。', sourceIds: ['p2'] }],
    relations: [{ from: 'c1', to: 'c2', type: '动机', reason: '问题引出方法。', sourceIds: ['p1', 'p2'] },
      { from: 'c1', to: 'c3', type: '支持', reason: '缺少结果原文。', sourceIds: ['p1'] }],
    terms: [{ name: 'exchangeability', definition: '可交换性。', paragraphIds: ['p2'] }]
  });
  const paper = { title: 'Causal fixture', rawText: raw, graph };
  const enriched = await enhancePdfGraph(mock(reply, sent), config, paper, graph, new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].messages[1].content.length < 46000);
  assert.equal(enriched.enrichmentStatus, 'ai-enhanced');
  assert.equal(enriched.knowledge.length, 1);
  assert.ok(enriched.edges.some(e => e.inferred && e.from === 'c1' && e.to === 'c2'));
  assert.ok(!enriched.edges.some(e => e.inferred && e.from === 'c1' && e.to === 'c3'));
  assert.deepEqual(graph.knowledge, []);
  assert.ok(graphContext(enriched, ['p2']).knowledge.length);
  assert.match(graphMarkdown(enriched), /核心方法/);
  const thread = makeThread(paper, 'adjustment algorithm under exchangeability');
  const request = await prepareConversation(mock('unexpected route call', sent), config, { ...paper, graph: enriched }, thread,
    '为什么需要可交换性？', '', new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.match(request.evidenceLabel, /BM25/);
  assert.match(request.messages[1].content, /adjustment algorithm/);
});

test('malformed enhancement has no retry and leaves local PDF index usable', async () => {
  const graph = makePdfLocalGraph(raw), sent = [];
  const result = await enhancePdfGraph(mock('not json', sent), config, { title: 'Fixture', rawText: raw }, graph, new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.equal(result.enrichmentStatus, 'local-fallback');
  assert.equal(JSON.stringify(result.localIndex), JSON.stringify(graph.localIndex));
  assert.equal(result.narrative, graph.narrative);
});

test('PDF enhancement runs when Zotero global has no structuredClone', async () => {
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = undefined;
  try {
    const graph = makePdfLocalGraph(raw), sent = [];
    const reply = JSON.stringify({ knowledge: [{ role: '核心方法', text: '调整混杂因素。', sourceIds: ['p2'] }] });
    const result = await enhancePdfGraph(mock(reply, sent), config, { title: 'Fixture', rawText: raw }, graph, new AbortController().signal);
    assert.equal(result.enrichmentStatus, 'ai-enhanced');
    assert.equal(sent.length, 1);
  } finally {
    globalThis.structuredClone = clone;
  }
});

test('long PDF sends only bounded representative original text', () => {
  const long = Array.from({ length: 150 }, (_, i) =>
    `${i + 1} Section ${i + 1}\n` + `The method compares a baseline with the proposed algorithm in experiment ${i + 1}. `.repeat(30) + '\n').join('');
  const graph = makePdfLocalGraph(long);
  const evidence = boundedPdfEvidence(graph, long);
  assert.ok(graph.paragraphs.length >= 150);
  assert.ok(evidence.text.length <= 42000);
  assert.ok(evidence.omittedNodes > 0);
  assert.ok(evidence.paragraphIds.every(id => evidence.text.includes(`[${id} |`)));
  assert.ok(evidence.paragraphIds.some(id => Number(id.slice(1)) > graph.paragraphs.length * .8));
  assert.equal(graph.paragraphs.map(p => long.slice(p.start, p.end)).join(''), long);
  const oneLine = 'Long unbroken extracted PDF text about experiments and methodology. '.repeat(300);
  const oneLineGraph = makePdfLocalGraph(oneLine);
  assert.ok(oneLineGraph.paragraphs.length > 1);
  assert.equal(oneLineGraph.paragraphs.map(p => oneLine.slice(p.start, p.end)).join(''), oneLine);
});
