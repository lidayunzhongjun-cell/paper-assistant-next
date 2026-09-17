import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceUnits, batches, validatePlan, reconcileContinuations, makeGraph, paragraphParts, verifiedSourceQuote, validateDescriptions, attachDescriptions, graphUsable, importedGraphUsable, activeGraph, locateSelection, rankParagraphs, graphEvidence, graphContext, graphMarkdown, graphIndex } from '../src/graph.mjs';
import { buildGraph, buildImportedSummaryGraph, prepareConversation } from '../src/graph-runtime.mjs';
import { makeImportedSummarySkeleton, boundedSummaryMaterial } from '../src/summary-graph.mjs';
import { makeThread, conversationRequest } from '../src/core.mjs';
import { PaperStore } from '../src/runtime.mjs';

const raw = '1 Introduction\nA confounder affects both treatment and outcome.\n\n2 Methods\nWe adjust for the confounder under exchangeability.\n\n3 Results\nThe adjusted effect is small, with wide confidence intervals.\n';
function fixture(text = raw) {
  const units = sourceUnits(text);
  const plan = [{ first: 1, last: 3, chapter: '1 Introduction', subsection: '', continuesPrevious: false },
    { first: 4, last: 6, chapter: '2 Methods', subsection: '2.1 Adjustment', continuesPrevious: false },
    { first: 7, last: 8, chapter: '3 Results', subsection: '', continuesPrevious: false }];
  return makeGraph(text, units, validatePlan({ paragraphs: plan }, units));
}
function describe(graph, text = raw) {
  const parts = paragraphParts(graph, text);
  const nodes = parts.map(p => ({ id: p.id, importance: 'high', density: 'medium', reason: 'Provides the premise for adjustment.',
    summary: p.paragraphId === 'p1' ? '混杂因素同时影响处理和结局。' : p.paragraphId === 'p2' ? '方法通过调整混杂因素识别效应，依赖可交换性。' : '调整后效应小，置信区间宽。',
    keyQuotes: [p.text.trim()], relations: p.paragraphId === 'p2' ? [{ to: 'p1', type: '依赖', reason: '调整以混杂定义为前提。' }] : [],
    terms: [{ name: 'confounder', definition: '混杂因素；同时影响处理和结局。' }] }));
  attachDescriptions(graph, validateDescriptions({ nodes }, parts, graph));
  graph.chapters.forEach(c => { c.summary = c.title + '：' + graph.paragraphs.filter(p => p.chapterId === c.id).map(p => p.summary).join(''); });
  graph.narrative = '从混杂问题到调整方法，再到效应估计与不确定性。';
  return graph;
}
function mockWin(replies, sent = []) {
  return { AbortController, setTimeout, clearTimeout, fetch: async (url, args) => {
    const payload = JSON.parse(args.body); sent.push(payload);
    const next = typeof replies === 'function' ? replies(payload, sent.length) : replies.shift();
    if (next instanceof Error) throw next;
    assert.notEqual(next, undefined, 'Unexpected model call');
    return { ok: true, json: async () => ({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) }, finish_reason: 'stop' }] }) };
  } };
}
const config = { endpoint: 'http://localhost/v1', model: 'fixture-model' };

test('source units and paragraph leaves preserve every character and hierarchy', () => {
  const graph = fixture();
  assert.equal(sourceUnits(raw).map(u => u.text).join(''), raw);
  assert.equal(graph.paragraphs.map(p => raw.slice(p.start, p.end)).join(''), raw);
  assert.equal(graph.chapters[1].children[0].kind, 'section');
  assert.equal(graph.chapters[1].children[0].children[0].id, 'p2');
  assert.ok(graph.edges.some(e => e.from === 'c2s1' && e.to === 'p2'));
  const long = 'X'.repeat(26000) + '\r\n末行';
  assert.equal(sourceUnits(long).map(u => u.text).join(''), long);
});

test('missing, overlapping, out-of-range structure and false continuation are rejected', () => {
  const units = sourceUnits(raw);
  for (const [first, last] of [[2, 8], [1, 7], [1, 9]]) assert.throws(() => validatePlan({ paragraphs: [{ first, last, chapter: 'A', subsection: '', continuesPrevious: false }] }, units));
  assert.throws(() => makeGraph(raw, units, [{ first: 1, last: 8, chapter: 'A', subsection: '', continuesPrevious: true }]), /延续/);
});

test('cross-batch continuation joins source ranges without duplicate leaf', () => {
  const units = sourceUnits(raw);
  const g = makeGraph(raw, units, [{ first: 1, last: 4, chapter: 'A', subsection: '', continuesPrevious: false }, { first: 5, last: 8, chapter: 'A', subsection: '', continuesPrevious: true }]);
  assert.equal(g.paragraphs.length, 1); assert.equal(g.paragraphs[0].end, raw.length);
});

test('cross-batch continuation inherits the previous path instead of failing on model label drift', () => {
  const previous = [{ first: 1, last: 2, chapter: '2 Methods', subsection: '2.1 Data', continuesPrevious: false }];
  const next = [{ first: 3, last: 4, chapter: 'Methods', subsection: 'Data collection', continuesPrevious: true },
    { first: 5, last: 6, chapter: '2 Methods', subsection: '2.2 Analysis', continuesPrevious: false }];
  const repaired = reconcileContinuations(previous, next);
  assert.equal(repaired[0].chapter, '2 Methods');
  assert.equal(repaired[0].subsection, '2.1 Data');
  assert.equal(repaired[1].subsection, '2.2 Analysis');
  assert.equal(next[0].chapter, 'Methods', 'model response remains unchanged for diagnostics');
  assert.throws(() => reconcileContinuations([], [{ ...next[0] }]), /缺少前一段位置/);
});

test('a batch boundary inside one physical source line forces continuation', () => {
  const previous = [{ first: 1, last: 1, chapter: 'Appendix', subsection: '', continuesPrevious: false }];
  const next = [{ first: 2, last: 2, chapter: 'Invented heading', subsection: 'Wrong', continuesPrevious: false }];
  assert.deepEqual(reconcileContinuations(previous, next, true)[0], {
    first: 2, last: 2, chapter: 'Appendix', subsection: '', continuesPrevious: true
  });
});

test('full graph pipeline survives cross-batch continuation label drift', async () => {
  const text = Array.from({ length: 15 }, (_, i) => `${i} ${'source '.repeat(145)}\n`).join('');
  const units = sourceUnits(text);
  const structureGroups = batches(units, u => u.text.length + 25);
  assert.ok(structureGroups.length > 1, 'fixture must cross the structure request budget');
  const planReplies = structureGroups.map((group, i) => ({ paragraphs: [{
    first: group[0].id, last: group.at(-1).id,
    chapter: i ? 'Methods' : '2 Methods', subsection: i ? 'Data collection' : '2.1 Data',
    continuesPrevious: i > 0
  }] }));
  const expectedGraph = makeGraph(text, units, [{
    first: units[0].id, last: units.at(-1).id,
    chapter: '2 Methods', subsection: '2.1 Data', continuesPrevious: false
  }]);
  const parts = paragraphParts(expectedGraph, text);
  const readingGroups = batches(parts, part => part.text.length + 350, 10500);
  const nodeReplies = readingGroups.map(group => ({ nodes: group.map(part => ({
    id: part.id, importance: 'medium', density: 'medium', reason: '跨批段落测试。',
    summary: `摘要 ${part.id}`, keyQuotes: [], relations: [], terms: []
  })) }));
  const result = await buildGraph(mockWin([...planReplies, ...nodeReplies, '章节串联 p1', '全文串联 p1', { relations: [] }]),
    config, { id: '1-LONG', title: 'Long fixture', rawText: text }, new AbortController().signal);
  assert.equal(result.paragraphs.length, 1);
  assert.equal(result.chapters.length, 1);
  assert.equal(result.chapters[0].title, '2 Methods');
  assert.equal(result.chapters[0].children[0].title, '2.1 Data');
  assert.equal(result.paragraphs[0].end, text.length);
});

test('descriptions reject missing nodes and excessive low-priority detail', () => {
  const graph = fixture(); const parts = paragraphParts(graph, raw);
  const base = { nodes: parts.map(p => ({ id: p.id, importance: 'low', density: 'low', reason: 'Transition.', summary: '一句过渡。', keyQuotes: [], relations: [], terms: [] })) };
  assert.doesNotThrow(() => validateDescriptions(structuredClone(base), parts, graph));
  for (const mutate of [d => d.nodes.pop(), d => { d.nodes[0].summary = '长'.repeat(181); }]) {
    const invalid = structuredClone(base); mutate(invalid); assert.throws(() => validateDescriptions(invalid, parts, graph));
  }
});

test('optional key quotes are restored to exact source text and unverifiable claims are dropped', () => {
  const graph = fixture(); const parts = paragraphParts(graph, raw);
  const nodes = parts.map(p => ({ id: p.id, importance: 'medium', density: 'medium', reason: '有效段落说明。', summary: '有效摘要。', keyQuotes: [], relations: [], terms: [] }));
  nodes[0].keyQuotes = ['A   CONFOUNDER affects both treatment and outcome.', 'Invented causal conclusion.'];
  const validated = validateDescriptions({ nodes }, parts, graph);
  assert.deepEqual(validated[0].keyQuotes, ['A confounder affects both treatment and outcome.']);
  assert.equal(validated[0]._droppedQuotes, 1);
  const typographic = 'The “causal effect” is inter-\nnational.';
  assert.equal(verifiedSourceQuote(typographic, 'the "causal effect" is inter- national.'), typographic);
  assert.equal(verifiedSourceQuote(typographic, 'the causal association is international.'), null);
});

test('optional paragraph relations normalize part IDs and drop malformed edges without losing nodes', () => {
  const graph = fixture(); const parts = paragraphParts(graph, raw);
  const nodes = parts.map(p => ({ id: p.id, importance: 'medium', density: 'medium', reason: '有效段落说明。', summary: '有效摘要。', keyQuotes: [], relations: [], terms: [] }));
  nodes[0].relations = [
    { to: 'P2.1', type: ' 支持 ', reason: ' 有明确依据。 ' },
    { to: 'p999', type: '支持', reason: '目标不存在。' },
    { to: 'p3', type: '支持' },
    { to: 'p1.1', type: '内部', reason: '同一段的片段不建边。' }
  ];
  const validated = validateDescriptions({ nodes }, parts, graph);
  assert.deepEqual(validated[0].relations, [{ to: 'p2', type: '支持', reason: '有明确依据。' }]);
  assert.equal(validated[0]._droppedRelations, 3);
  assert.equal(validated.length, parts.length);
});

test('independent terms, semantic edges and exact paragraph locations survive export', () => {
  const graph = describe(fixture());
  assert.equal(graph.terms.length, 1);
  assert.deepEqual(graph.terms[0].paragraphIds, ['p1', 'p2', 'p3']);
  assert.ok(graph.edges.some(e => e.from === 'p2' && e.to === 'p1' && e.type === '依赖'));
  assert.deepEqual(locateSelection(graph, raw, 'We   adjust for the confounder'), ['p2']);
  const md = graphMarkdown(graph);
  for (const x of ['全文串联', '附属术语表', 'p2 → p1', '2.1 Adjustment', '重要性高']) assert.ok(md.includes(x));
  assert.equal(graphUsable({ rawText: raw, graph }), true);
  assert.equal(graphUsable({ rawText: raw.replace('small', 'large'), graph }), false);
});

test('retrieval prefers matched source, preserves source IDs and bounds raw text', () => {
  const graph = describe(fixture()); const paper = { rawText: raw, graph };
  const ranked = rankParagraphs(graph, '混杂定义', ['p2']);
  assert.equal(ranked[0].p.id, 'p2');
  const evidence = graphEvidence(paper, ranked, ['p1'], ['p2'], 10000);
  assert.equal(evidence.records[0].id, 'p2');
  assert.match(evidence.text, /exchangeability/);
  assert.ok(evidence.records.every(r => r.text === raw.slice(r.start, r.end)));
  const ctx = graphContext(graph, ['p2']);
  assert.ok(ctx.terms.length); assert.ok(ctx.relations.length);
});

test('full pipeline builds graph before returning and does not mutate saved source/tree', async () => {
  const graph = fixture(); const parts = paragraphParts(graph, raw);
  const plans = [{ first: 1, last: 3, chapter: '1 Introduction', subsection: '', continuesPrevious: false }, { first: 4, last: 6, chapter: '2 Methods', subsection: '2.1 Adjustment', continuesPrevious: false }, { first: 7, last: 8, chapter: '3 Results', subsection: '', continuesPrevious: false }];
  const nodes = parts.map(p => ({ id: p.id, importance: 'high', density: 'high', reason: 'Core premise.', summary: '段落的核心叙述。', keyQuotes: [p.text.trim()], relations: [], terms: [{ name: 'confounder', definition: '混杂因素。' }] }));
  const sent = [];
  const win = mockWin([{ paragraphs: plans }, { nodes }, '章一主线 p1', '章二主线 p2', '章三主线 p3', '从问题到方法和结论。', { relations: [{ from: 'c1', to: 'c2', type: '动机', reason: '问题引出方法。' }] }], sent);
  const paper = { id: '1-A', title: 'Fixture', rawText: raw, graph: { old: true } };
  const before = structuredClone(paper);
  const result = await buildGraph(win, config, paper, new AbortController().signal);
  assert.deepEqual(paper, before);
  assert.equal(sent.length, 7); assert.equal(result.paragraphs.length, 3);
  assert.ok(result.edges.some(e => e.from === 'c1' && e.to === 'c2' && e.type === '动机'));
  assert.equal(result.model, config.model);
  await assert.rejects(buildGraph(mockWin([{ paragraphs: [] }]), config, paper, new AbortController().signal), /段落/);
  assert.deepEqual(paper, before);
});

test('follow-up first routes over graph, then supplies raw evidence and independent terms for answer', async () => {
  const paper = { id: '1-A', title: 'Fixture', rawText: raw, graph: describe(fixture()), overview: 'OLD_OVERVIEW' };
  const thread = makeThread(paper, 'We adjust for the confounder');
  const sent = [];
  const request = await prepareConversation(mockWin([{ paragraphIds: ['p1'], chapterIds: ['c3'] }], sent), config, paper, thread, '为何调整？不确定性如何？', '', new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.match(sent[0].messages[1].content, /全文串联/);
  const context = JSON.parse(request.messages[1].content.split('\n').slice(1).join('\n'));
  assert.match(context.originalEvidence, /exchangeability/);
  assert.match(context.originalEvidence, /wide confidence intervals/);
  assert.ok(context.knowledgeGraph.terms.length);
  assert.equal(context.paperOverview, undefined);
  assert.match(request.evidenceLabel, /图谱预判/);
});

test('invalid router falls back visibly; cancellation does not initiate answer', async () => {
  const paper = { id: '1-A', title: 'Fixture', rawText: raw, graph: describe(fixture()) };
  const thread = makeThread(paper, 'confounder');
  const req = await prepareConversation(mockWin([{ paragraphIds: ['p999'], chapterIds: [] }]), config, paper, thread, 'Explain', '', new AbortController().signal);
  assert.match(req.evidenceLabel, /预判失败/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareConversation(mockWin([]), config, paper, thread, 'Explain', '', controller.signal), /已停止/);
});

test('legacy records work without router, and oversized context fails explicitly', async () => {
  const paper = { id: '1-A', title: 'Old', rawText: raw, overview: 'Legacy summary' };
  const thread = makeThread(paper, 'confounder');
  const req = await prepareConversation(mockWin([]), config, paper, thread, 'Explain', '', new AbortController().signal);
  assert.match(req.messages[1].content, /Legacy summary/);
  thread.selection = 'X'.repeat(30000);
  assert.throws(() => conversationRequest(paper, thread, 'Explain'), /预算/);
});

test('large graph keeps routing context bounded and partial original excerpts labeled', () => {
  const text = 'long text '.repeat(5000);
  const units = sourceUnits(text);
  const graph = makeGraph(text, units, [{ first: 1, last: units.length, chapter: 'Long', subsection: '', continuesPrevious: false }]);
  const p = graph.paragraphs[0]; Object.assign(p, { summary: 'S'.repeat(6000), importance: 'high', density: 'high', reason: 'R', keyQuotes: [] });
  graph.narrative = 'N'.repeat(4000); graph.chapters[0].summary = 'C'.repeat(4000);
  const ranked = rankParagraphs(graph, 'long', ['p1']);
  assert.ok(graphIndex(graph, ranked).text.length <= 10000);
  const evidence = graphEvidence({ rawText: text, graph }, ranked, [], ['p1'], 10000);
  assert.ok(evidence.records[0].partial); assert.equal(evidence.records[0].text.length, 10000);
  assert.match(evidence.label, /截取/);
});

test('saved graph and raw source round-trip through paper storage', async () => {
  const files = new Map();
  globalThis.Zotero = { DataDirectory: { dir: 'fixture-data' } };
  globalThis.PathUtils = { join: (...parts) => parts.join('/') };
  globalThis.IOUtils = { exists: async p => files.has(p), readJSON: async p => JSON.parse(files.get(p)), makeDirectory: async () => {}, writeUTF8: async (p, text) => files.set(p, text) };
  const identity = { id: '1-ABC', title: 'Fixture', attachmentID: 99 };
  const store = new PaperStore(); const paper = await store.load(identity);
  paper.rawText = raw; paper.graph = describe(fixture());
  await store.save(paper);
  const restored = await new PaperStore().load(identity);
  assert.deepEqual(restored.graph, paper.graph); assert.equal(graphUsable(restored), true);
});

test('imported summary graph stays separate from PDF graph and is explicitly secondary evidence', async () => {
  const pdfGraph = describe(fixture());
  const importedGraph = structuredClone(pdfGraph);
  Object.assign(importedGraph, { sourceKind: 'imported-summary', sourceName: 'summary.docx' });
  const paper = { id: '1-A', title: 'Fixture', rawText: raw, graph: pdfGraph,
    importedSummary: { name: 'summary.docx', text: raw, charCount: raw.length }, importedGraph, activeGraphSource: 'imported' };
  assert.equal(graphUsable(paper), true);
  assert.equal(importedGraphUsable(paper), true);
  assert.equal(activeGraph(paper).kind, 'imported');
  const thread = makeThread(paper, 'We adjust for the confounder');
  const sent = [];
  const request = await prepareConversation(mockWin([], sent), config, paper, thread, '为何调整？', '', new AbortController().signal);
  assert.equal(sent.length, 0, 'imported graph routing is local and consumes no extra model call');
  const context = JSON.parse(request.messages[1].content.split('\n').slice(1).join('\n'));
  assert.equal(context.knowledgeGraph.sourceKind, 'imported-summary');
  assert.match(context.secondaryMaterial, /不是论文原文证据/);
  assert.match(context.originalEvidence, /exchangeability/);
  assert.match(request.evidenceLabel, /AI 精炼稿图谱/);
  assert.match(request.evidenceLabel, /0 次路由调用/);
  const markdown = graphMarkdown(importedGraph);
  assert.match(markdown, /外部 AI 精炼稿树状知识图谱/);
  assert.match(markdown, /二手凝练材料/);
  paper.activeGraphSource = 'pdf';
  assert.equal(activeGraph(paper).graph, pdfGraph);
});

test('imported summary fast path builds complete local structure and uses exactly one API call', async () => {
  const summaryText = `# A Study\n\n## 1. 研究问题与贡献\n${'研究问题、缺口与贡献。'.repeat(45)}\n\n## 2. 方法与实验\n### 2.1 数据\n${'样本、变量、模型和评价指标。'.repeat(55)}\n\n## 3. 结果与局限\n${'结果、证据强度、限定条件与局限。'.repeat(50)}`;
  const skeleton = makeImportedSummarySkeleton(summaryText, 'summary.md');
  assert.equal(skeleton.paragraphs.map(p => summaryText.slice(p.start, p.end)).join(''), summaryText);
  assert.ok(skeleton.chapters.some(c => /研究问题/.test(c.title)));
  assert.ok(skeleton.chapters.some(c => /方法/.test(c.title)));
  assert.ok(skeleton.paragraphs.length < 20);
  const parts = paragraphParts(skeleton, summaryText);
  const reply = { narrative: '问题引出方法，方法支持结果，并由局限限定。',
    chapters: skeleton.chapters.map(c => ({ id: c.id, summary: `${c.title} 的导航摘要。` })),
    nodes: parts.map(part => ({ id: part.id, importance: 'medium', density: 'medium', reason: '快速导航单元。', summary: `节点 ${part.id} 的凝练。`, keyQuotes: [], relations: [], terms: [] })),
    chapterRelations: [] };
  const sent = [];
  const paper = { id: '1-A', title: 'Fixture', importedSummary: { name: 'summary.md', text: summaryText, charCount: summaryText.length } };
  const graph = await buildImportedSummaryGraph(mockWin([reply], sent), config, paper, new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.equal(graph.buildMode, 'summary-fast-ai');
  assert.equal(graph.enrichmentStatus, 'ai-complete');
  assert.equal(graph.aiCalls, 1);
  assert.match(graph.narrative, /问题引出方法/);
  assert.deepEqual(paper.importedGraph, undefined, 'builder remains side-effect free');
});

test('fast summary graph bounds very long API material and never retries malformed output', async () => {
  const longSummary = `# Long\n\n## Methods\n${'A'.repeat(90000)}\n\n## Results\n${'B'.repeat(90000)}`;
  const skeleton = makeImportedSummarySkeleton(longSummary, 'long.txt');
  const material = boundedSummaryMaterial(skeleton, longSummary);
  assert.equal(material.sampled, true);
  assert.ok(material.text.length <= 42000);
  assert.equal(skeleton.paragraphs.map(p => longSummary.slice(p.start, p.end)).join(''), longSummary);
  const sent = [];
  const graph = await buildImportedSummaryGraph(mockWin(['not json'], sent), config,
    { title: 'Long', importedSummary: { name: 'long.txt', text: longSummary } }, new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.equal(graph.enrichmentStatus, 'local-fallback');
  assert.equal(graph.buildMode, 'summary-fast-local');
  assert.match(graph.boundaryNote, /没有自动重试|零额外请求/);
  assert.ok(graph.paragraphs.every(p => p.summary));
  const denseHeadings = Array.from({ length: 600 }, (_, i) => `## ${i + 1}. Section ${i + 1}\n内容 ${i + 1}：方法、结果和局限。`).join('\n\n');
  const denseGraph = makeImportedSummarySkeleton(denseHeadings, 'dense.md');
  const bounded = boundedSummaryMaterial(denseGraph, denseHeadings);
  assert.ok(denseGraph.paragraphs.length >= 500, 'local graph keeps dense source structure');
  assert.ok(bounded.paragraphIds.length <= 48);
  assert.ok(bounded.omittedNodes > 0);
  assert.ok(bounded.text.length <= 42000);
});
