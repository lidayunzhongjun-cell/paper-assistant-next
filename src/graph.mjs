// Source-grounded knowledge trees; offsets always refer to the unchanged extracted text.
export const GRAPH_VERSION = 1;
export const compact = text => String(text || '').replace(/\s+/g, ' ').trim();
export function sourceFingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
export function sourceUnits(text) {
  const units = [];
  const re = /[^\n]*\n|[^\n]+$/g;
  for (const match of text.matchAll(re)) {
    for (let start = match.index; start < match.index + match[0].length; start += 1200) {
      const end = Math.min(match.index + match[0].length, start + 1200);
      units.push({ id: units.length + 1, start, end, text: text.slice(start, end) });
    }
  }
  return units;
}
export function batches(items, sizeOf, limit = 12000) {
  const groups = []; let group = [], size = 0;
  for (const item of items) {
    const n = sizeOf(item);
    if (group.length && (size + n > limit || group.length >= 70)) { groups.push(group); group = []; size = 0; }
    group.push(item); size += n;
  }
  if (group.length) groups.push(group);
  return groups;
}
export function parseJSON(text) {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('模型未返回有效的图谱 JSON，未替换已保存图谱，请重试。'); }
}
function field(value, name, max = 1500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`图谱字段 ${name} 缺失或过长。`);
  return value.trim();
}
export function validatePlan(data, units) {
  if (!Array.isArray(data.paragraphs) || !data.paragraphs.length) throw new Error('结构识别未返回段落。');
  let cursor = units[0].id;
  const end = units.at(-1).id;
  for (const p of data.paragraphs) {
    if (p.first !== cursor || !Number.isInteger(p.last) || p.last < p.first || p.last > end) throw new Error('段落范围遗漏、重叠或越界，未保存不完整图谱。');
    p.chapter = field(p.chapter, 'chapter', 180);
    if (typeof p.subsection !== 'string' || p.subsection.length > 240) throw new Error('小节标题格式错误。');
    if (typeof p.continuesPrevious !== 'boolean') throw new Error('缺少段落跨块延续标记。');
    cursor = p.last + 1;
  }
  if (cursor !== end + 1) throw new Error('结构识别没有覆盖全部原文。');
  return data.paragraphs;
}
// A continued paragraph belongs to the exact path of the preceding range.
// Models often repeat that path with harmless spelling/numbering differences;
// the boolean continuation decision and immutable source offsets are the
// authoritative signals, so inherit the prior path instead of aborting an
// otherwise complete (and potentially expensive) graph build.
export function reconcileContinuations(previousPlans, nextPlans, forceFirst = false) {
  const result = nextPlans.map(plan => ({ ...plan }));
  const previous = previousPlans.at(-1);
  if (forceFirst && result.length && previous) result[0].continuesPrevious = true;
  for (let i = 0; i < result.length; i++) {
    const current = result[i];
    if (!current.continuesPrevious) continue;
    const before = i ? result[i - 1] : previous;
    if (!before) throw new Error('跨块段落延续缺少前一段位置。');
    current.chapter = before.chapter;
    current.subsection = before.subsection;
  }
  return result;
}
export function makeGraph(text, units, plans, options = {}) {
  const imported = options.sourceKind === 'imported-summary';
  const graph = { version: GRAPH_VERSION, sourceLength: text.length, sourceFingerprint: sourceFingerprint(text), created: Date.now(), chapters: [], paragraphs: [], edges: [], terms: [], narrative: '',
    sourceKind: imported ? 'imported-summary' : 'pdf', sourceName: options.sourceName || (imported ? '外部 AI 精炼稿' : 'PDF 提取文字'),
    boundaryNote: imported
      ? '本图谱由模型根据外部 AI 精炼稿生成，属于二手凝练材料，不是论文原文证据。字符位置仅对应导入文档；结论、关系和引文仍须回到 PDF 核对。'
      : '章节与段落由模型根据 PDF 提取文字识别；换行、双栏、标题或跨页可能影响边界，请对照原文。字符位置不是页码。' };
  let chapter, section;
  for (const p of plans) {
    const start = units[p.first - 1].start, end = units[p.last - 1].end;
    const previous = graph.paragraphs.at(-1);
    if (p.continuesPrevious) {
      if (!previous || chapter.title !== p.chapter || (section?.title || '') !== p.subsection || previous.end !== start) throw new Error('跨块段落延续与章节位置不一致。');
      previous.end = end; continue;
    }
    if (!chapter || chapter.title !== p.chapter) {
      chapter = { id: `c${graph.chapters.length + 1}`, title: p.chapter, summary: '', children: [] };
      graph.chapters.push(chapter); section = null;
    }
    if (p.subsection && section?.title !== p.subsection) {
      section = { id: `${chapter.id}s${chapter.children.filter(x => x.kind === 'section').length + 1}`, kind: 'section', title: p.subsection, children: [] };
      chapter.children.push(section);
      graph.edges.push({ from: chapter.id, to: section.id, type: '包含', reason: '章节—小节' });
    } else if (!p.subsection) section = null;
    const node = { id: `p${graph.paragraphs.length + 1}`, chapterId: chapter.id, sectionId: section?.id || null, start, end };
    graph.paragraphs.push(node); (section || chapter).children.push({ kind: 'paragraph', id: node.id });
    graph.edges.push({ from: section?.id || chapter.id, to: node.id, type: '包含', reason: imported ? '精炼稿顺序中的导航单元' : '原文顺序中的段落' });
    if (previous) graph.edges.push({ from: previous.id, to: node.id, type: '顺序', reason: imported ? '精炼稿相邻导航单元；不代表因果关系' : '原文相邻段落；不代表因果关系' });
  }
  if (!graph.paragraphs.length || graph.paragraphs[0].start !== 0 || graph.paragraphs.at(-1).end !== text.length) throw new Error('图谱未覆盖完整提取文字。');
  return graph;
}
export function paragraphParts(graph, text) {
  const result = [];
  for (const p of graph.paragraphs) {
    for (let start = p.start, part = 1; start < p.end; start += 7000, part++) {
      result.push({ id: `${p.id}.${part}`, paragraphId: p.id, text: text.slice(start, Math.min(p.end, start + 7000)) });
    }
  }
  return result;
}
function quoteIndex(text) {
  const chars = []; const starts = []; const ends = [];
  const punctuation = new Map([
    ['“', '"'], ['”', '"'], ['„', '"'], ['‟', '"'], ['‘', "'"], ['’', "'"], ['‚', "'"], ['‛', "'"],
    ['‐', '-'], ['‑', '-'], ['‒', '-'], ['–', '-'], ['—', '-'], ['―', '-'], ['−', '-'], ['…', '...']
  ]);
  for (let i = 0; i < text.length;) {
    const raw = String.fromCodePoint(text.codePointAt(i));
    const end = i + raw.length;
    for (const normalized of raw.normalize('NFKC')) {
      if (/\s/u.test(normalized) || normalized === '\u00ad') continue;
      const mapped = punctuation.get(normalized) || normalized;
      for (const char of mapped.toLowerCase()) { chars.push(char); starts.push(i); ends.push(end); }
    }
    i = end;
  }
  return { key: chars.join(''), starts, ends };
}
export function verifiedSourceQuote(source, candidate, max = 700) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > max) return null;
  const haystack = quoteIndex(source); const needle = quoteIndex(candidate).key;
  if (!needle) return null;
  const at = haystack.key.indexOf(needle);
  if (at < 0) return null;
  const exact = source.slice(haystack.starts[at], haystack.ends[at + needle.length - 1]);
  return exact.length <= max + 200 ? exact : null;
}
export function validateDescriptions(data, parts, graph) {
  if (!Array.isArray(data.nodes) || data.nodes.length !== parts.length) throw new Error('逐段精读遗漏了段落，未保存。');
  const seen = new Set(); const ids = new Set(graph.paragraphs.map(p => p.id));
  const canonicalIds = new Map([...ids].map(id => [id.toLowerCase(), id]));
  for (const n of data.nodes) {
    const part = parts.find(p => p.id === n.id);
    if (!part || seen.has(n.id)) throw new Error('逐段精读返回未知或重复段落。');
    seen.add(n.id);
    if (!['low', 'medium', 'high'].includes(n.importance) || !['low', 'medium', 'high'].includes(n.density)) throw new Error('缺少重要性或信息密度评判。');
    n.summary = field(n.summary, 'summary', n.importance === 'low' ? 180 : 1000);
    n.reason = field(n.reason, 'reason', 300);
    const invalidQuoteContainer = n.keyQuotes == null || Array.isArray(n.keyQuotes) ? 0 : 1;
    const rawQuotes = Array.isArray(n.keyQuotes) ? n.keyQuotes : [];
    n.keyQuotes = [...new Set(rawQuotes.slice(0, 5).map(q => verifiedSourceQuote(part.text, q)).filter(Boolean))];
    n._droppedQuotes = invalidQuoteContainer + rawQuotes.length - n.keyQuotes.length;
    // Relations are optional model inferences. Preserve valid relations without
    // discarding verified structure/summaries when one optional edge is bad.
    // Models commonly return a part ID (p2.1) even though graph edges use the
    // parent paragraph ID (p2), so normalize that unambiguous case.
    const invalidRelationContainer = n.relations == null || Array.isArray(n.relations) ? 0 : 1;
    const rawRelations = Array.isArray(n.relations) ? n.relations : [];
    n.relations = rawRelations.slice(0, 8).flatMap(r => {
      const match = typeof r?.to === 'string' ? r.to.trim().match(/^(p\d+)(?:\.\d+)?$/i) : null;
      const to = match ? canonicalIds.get(match[1].toLowerCase()) : null;
      const type = typeof r?.type === 'string' ? r.type.trim() : '';
      const reason = typeof r?.reason === 'string' ? r.reason.trim() : '';
      return to && to !== part.paragraphId && type && type.length <= 40 && reason && reason.length <= 300
        ? [{ to, type, reason }] : [];
    });
    n._droppedRelations = invalidRelationContainer + rawRelations.length - n.relations.length;
    if (!Array.isArray(n.terms) || n.terms.length > 12) throw new Error('术语表格式错误。');
    for (const t of n.terms) { t.name = field(t.name, 'term', 120); t.definition = field(t.definition, 'definition', 500); }
  }
  return data.nodes;
}
export function attachDescriptions(graph, descriptions) {
  const rank = { low: 0, medium: 1, high: 2 };
  for (const p of graph.paragraphs) {
    const parts = descriptions.filter(n => n.id.split('.')[0] === p.id);
    if (!parts.length) throw new Error(`段落 ${p.id} 缺少精读。`);
    p.importance = parts.reduce((v, n) => rank[n.importance] > rank[v] ? n.importance : v, 'low');
    p.density = parts.reduce((v, n) => rank[n.density] > rank[v] ? n.density : v, 'low');
    p.summary = parts.map(n => n.summary).join('\n');
    p.reason = [...new Set(parts.map(n => n.reason))].join('；');
    p.keyQuotes = [...new Set(parts.flatMap(n => n.keyQuotes))];
    for (const n of parts) {
      for (const r of n.relations) graph.edges.push({ from: p.id, ...r, inferred: true });
      for (const t of n.terms) {
        // Keep contextual definitions separate: identical spellings can have different meanings.
        let term = graph.terms.find(x => x.name.toLowerCase() === t.name.toLowerCase() && x.definition === t.definition);
        if (!term) { term = { id: `t${graph.terms.length + 1}`, ...t, paragraphIds: [] }; graph.terms.push(term); }
        if (!term.paragraphIds.includes(p.id)) term.paragraphIds.push(p.id);
      }
    }
  }
  return graph;
}
export function location(graph, p) {
  const c = graph.chapters.find(c => c.id === p.chapterId);
  const s = c?.children.find(s => s.id === p.sectionId);
  return `${c?.title || p.chapterId}${s ? ' / ' + s.title : ''} / ${p.id}`;
}
export function locateSelection(graph, text, selection, paragraphId) {
  if (paragraphId) {
    const p = graph.paragraphs.find(p => p.id === paragraphId);
    if (p && (!selection || compact(text.slice(p.start, p.end)).includes(compact(selection)))) return [p.id];
  }
  if (!compact(selection)) return [];
  const hits = graph.paragraphs.filter(p => compact(text.slice(p.start, p.end)).includes(compact(selection))).map(p => p.id);
  if (hits.length) return hits;
  const at = text.indexOf(selection);
  return at < 0 ? [] : graph.paragraphs.filter(p => p.start < at + selection.length && p.end > at).map(p => p.id);
}
export function graphUsable(paper) {
  const g = paper.graph;
  // Source and graph are committed together; legacy summaries remain a separate fallback.
  return g?.version === GRAPH_VERSION && g.sourceLength === paper.rawText?.length && g.sourceFingerprint === sourceFingerprint(paper.rawText) && g.paragraphs?.length > 0 && g.chapters?.length > 0;
}
export function importedGraphUsable(paper) {
  const g = paper.importedGraph, text = paper.importedSummary?.text;
  return g?.version === GRAPH_VERSION && g.sourceKind === 'imported-summary' && typeof text === 'string'
    && g.sourceLength === text.length && g.sourceFingerprint === sourceFingerprint(text)
    && g.paragraphs?.length > 0 && g.chapters?.length > 0;
}
export function activeGraph(paper) {
  const imported = importedGraphUsable(paper), pdf = graphUsable(paper);
  if (paper.activeGraphSource === 'imported' && imported) return { graph: paper.importedGraph, text: paper.importedSummary.text, kind: 'imported' };
  if (paper.activeGraphSource === 'pdf' && pdf) return { graph: paper.graph, text: paper.rawText, kind: 'pdf' };
  if (imported) return { graph: paper.importedGraph, text: paper.importedSummary.text, kind: 'imported' };
  if (pdf) return { graph: paper.graph, text: paper.rawText, kind: 'pdf' };
  return null;
}
export function rankParagraphs(graph, query, located = []) {
  const tokens = [...new Set((query.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]/g) || []))].slice(0, 160);
  const linked = new Set(graph.edges.filter(e => e.type !== '包含' && located.includes(e.from)).map(e => e.to));
  for (const e of graph.edges) if (e.type !== '包含' && located.includes(e.to)) linked.add(e.from);
  return graph.paragraphs.map(p => {
    const terms = graph.terms.filter(t => t.paragraphIds.includes(p.id)).map(t => t.name + ' ' + t.definition).join(' ');
    const hay = `${location(graph, p)} ${p.summary} ${terms}`.toLowerCase();
    return { p, score: (located.includes(p.id) ? 10000 : 0) + (linked.has(p.id) ? 15 : 0) + tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score || a.p.start - b.p.start);
}
export function graphIndex(graph, ranked, limit = 10000) {
  let text = `全文串联：${graph.narrativeInvalidated ? '部分段落缓存已清除，串联已失效；须重新核对原文。' : graph.narrative.slice(0, 2200)}\n章节索引：\n`;
  // All chapter IDs remain available to the router, even for very large trees.
  const perChapter = Math.max(0, Math.floor(3500 / graph.chapters.length) - 40);
  for (const c of graph.chapters) text += `${c.id}: ${c.title.slice(0, 80)} ${c.summary.slice(0, perChapter)}\n`;
  text += '候选段落（非全文逐段清单）：\n';
  const offered = [];
  for (const { p } of ranked) {
    const line = `${p.id} [${location(graph, p)}] ${p.cacheCleared ? '本段精读缓存已清除，可检索原文。' : p.summary.slice(0, 400)}\n`;
    if (text.length + line.length > limit - 2000) break;
    text += line; offered.push(p.id);
  }
  const displayed = new Set(offered);
  const add = line => { if (text.length + line.length > limit) return false; text += line; return true; };
  add('附属术语（相关项）：\n');
  for (const t of graph.terms.filter(t => t.paragraphIds.some(id => offered.slice(0, 6).includes(id))).slice(0, 8)) {
    const ids = t.paragraphIds.slice(0, 8);
    if (add(`${t.name}：${t.definition.slice(0, 160)} [${ids.join(',')}]\n`)) ids.forEach(id => displayed.add(id));
  }
  add('关系（语义关系为模型推断）：\n');
  for (const e of graph.edges.filter(e => e.inferred && (offered.includes(e.from) || offered.includes(e.to) || e.from.startsWith('c')))) {
    if (add(`${e.from}→${e.to} ${e.type}：${e.reason.slice(0, 120)}\n`)) for (const id of [e.from, e.to]) if (id.startsWith('p')) displayed.add(id);
  }
  if (text.length > limit) throw new Error('章节索引超过路由预算，请拆分附件。');
  return { text, offered: [...displayed] };
}
export function graphEvidence(paper, ranked, requested = [], located = [], limit = 10000, focus = '', sourceKind = 'pdf') {
  const imported = sourceKind === 'imported';
  const g = imported ? paper.importedGraph : paper.graph;
  const sourceText = imported ? paper.importedSummary?.text || '' : paper.rawText || '';
  const chosen = [...new Set([...located, ...requested, ...ranked.slice(0, 4).map(x => x.p.id)])];
  const records = []; let used = 0;
  for (const id of chosen) {
    const p = g.paragraphs.find(p => p.id === id); if (!p) continue;
    let start = p.start, end = p.end;
    const remaining = Math.min(limit - used, chosen.length > 1 ? 3500 : limit);
    if (remaining < 400) break;
    if (end - start > remaining) {
      const at = focus ? sourceText.indexOf(focus, start) : -1;
      start = at >= start && at < end ? Math.max(start, at - 500) : start;
      end = Math.min(p.end, start + remaining);
    }
    records.push({ id, path: location(g, p), start, end, partial: start !== p.start || end !== p.end, text: sourceText.slice(start, end) });
    used += end - start;
  }
  return { records, text: records.map(r => `[${r.id} | ${r.path} | 字符 ${r.start}–${r.end}${r.partial ? ' | 节选，非完整段落' : ''}]\n${r.text}`).join('\n\n'),
    label: `${imported ? 'AI 精炼稿图谱' : 'PDF 图谱'}定位${located.length === 1 ? '已匹配选段' : located.length > 1 ? '选段存在多个匹配' : '未精确匹配选段'} · ${imported ? '精炼稿片段' : '原文'} ${records.map(r => r.id).join('、') || '无'}${records.some(r => r.partial) ? ' · 含截取片段' : ''}` };
}
export function graphContext(graph, ids, limit = 5500) {
  const imported = graph.sourceKind === 'imported-summary';
  const result = { sourceKind: graph.sourceKind || 'pdf', sourceName: graph.sourceName || 'PDF 提取文字', narrative: graph.narrative.slice(0, 1800), nodes: [], relations: [], terms: [],
    note: imported ? '图谱和片段来自外部 AI 精炼稿，是二手材料；不得把它当作论文原文证据，重要结论须结合提供的 PDF 原文检索片段核对。'
      : '图谱为模型凝练和关系推断，原文才是证据；本轮仅传入相关图谱和原文区域，完整原文保留在本地。' };
  const add = (list, item) => { list.push(item); if (JSON.stringify(result).length > limit) list.pop(); };
  for (const id of ids) { const p = graph.paragraphs.find(p => p.id === id); if (p) add(result.nodes, { id, path: location(graph, p), summary: p.cacheCleared ? '精读缓存已清除，须依据原文分析。' : p.summary.slice(0, 700), importance: p.importance, density: p.density }); }
  for (const t of graph.terms.filter(t => t.paragraphIds.some(id => ids.includes(id)))) add(result.terms, t);
  for (const e of graph.edges.filter(e => e.type !== '包含' && (ids.includes(e.from) || ids.includes(e.to)))) add(result.relations, e);
  return result;
}
export function graphMarkdown(graph) {
  const level = { high: '高', medium: '中', low: '低' };
  const imported = graph.sourceKind === 'imported-summary';
  let out = `# ${imported ? '外部 AI 精炼稿' : 'PDF 全文'}树状知识图谱\n\n来源：${graph.sourceName || (imported ? '外部 AI 精炼稿' : 'PDF 提取文字')}\n\n${imported ? '**证据边界：这是二手凝练材料，不是论文原文；重要结论、关系与摘录须回到 PDF 核对。**\n\n' : ''}${graph.boundaryNote}\n\n## 全文串联\n${graph.narrativeInvalidated ? '部分段落缓存已清除，全文串联已失效，需重新建立图谱。' : graph.narrative}\n`;
  for (const c of graph.chapters) {
    out += `\n## ${c.title} [${c.id}]\n${c.summaryInvalidated ? '章节串联已失效，其他段落缓存保留。' : c.summary}\n`;
    for (const child of c.children) {
      if (child.kind === 'section') out += `\n### ${child.title} [${child.id}]\n`;
      for (const ref of child.kind === 'section' ? child.children : [child]) {
        const p = graph.paragraphs.find(p => p.id === ref.id);
        if (p.cacheCleared) { out += `\n#### ${p.id} · 本段精读缓存已清除\n原文位置保留：字符 ${p.start}–${p.end}。\n`; continue; }
        out += `\n#### ${p.id} · 重要性${level[p.importance]} / 信息密度${level[p.density]}\n${p.summary}\n\n评判：${p.reason}\n`;
        for (const q of p.keyQuotes) out += `\n> ${imported ? '[精炼稿摘录] ' : ''}${q.replace(/\n/g, '\n> ')}\n`;
      }
    }
  }
  out += '\n## 关系（模型推断须核对原文）\n';
  for (const e of graph.edges) out += `- ${e.from} → ${e.to}：${e.type}；${e.reason}\n`;
  out += '\n## 附属术语表\n';
  for (const t of graph.terms) out += `- **${t.name}**：${t.definition} [${t.paragraphIds.join(', ')}]\n`;
  return out;
}
