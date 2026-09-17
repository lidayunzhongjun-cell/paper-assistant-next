import { sourceUnits, makeGraph, compact } from './graph.mjs';

function heading(line) {
  const value = String(line || '').replace(/\r?\n$/, '').trim();
  let match = value.match(/^(#{1,6})\s+(.{1,180})$/);
  if (match) return { level: match[1].length <= 2 ? 1 : 2, title: compact(match[2].replace(/\*\*/g, '')) };
  match = value.match(/^((?:第[一二三四五六七八九十百\d]+[章节部分])|(?:[一二三四五六七八九十]+[、.．])|(?:(?:\d+\.)+\d*[、\s]))\s*(.{1,140})$/);
  if (match && !/[。；;]$/.test(value)) return { level: /(?:\d+\.){2,}/.test(match[1]) ? 2 : 1, title: compact(value) };
  if (/^(abstract|introduction|background|methods?|methodology|results?|discussion|conclusions?|limitations?|references|摘要|引言|背景|方法|结果|讨论|结论|局限|参考文献)$/i.test(value)) {
    return { level: 1, title: value };
  }
  return null;
}

function localSummary(text, max = 420) {
  const value = compact(text.replace(/^#{1,6}\s+/gm, '').replace(/^[-*+]\s+/gm, ''));
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

export function makeImportedSummarySkeleton(text, sourceName = '外部 AI 精炼稿') {
  const units = sourceUnits(text);
  if (!units.length) throw new Error('AI 精炼稿没有可建立图谱的文字。');
  // Bound model output by keeping roughly 32–48 navigation nodes even for a
  // long imported document. Structure itself remains local and covers every character.
  const target = Math.max(900, Math.min(5600, Math.ceil(text.length / 32)));
  const hardMax = 6500;
  const plans = [];
  let chapter = '精炼稿导览', subsection = '', current = null;
  const close = () => { if (current) { plans.push(current); current = null; } };
  for (const unit of units) {
    if (!unit.text.trim() && current) { current.last = unit.id; continue; }
    const found = heading(unit.text);
    if (found) {
      close();
      if (found.level === 1) { chapter = found.title; subsection = ''; }
      else subsection = found.title;
    }
    const changed = current && (current.chapter !== chapter || current.subsection !== subsection);
    const size = current ? units[current.last - 1].end - units[current.first - 1].start : 0;
    if (changed || (current && (size + unit.text.length > hardMax || (size >= target && /\n\s*$/.test(units[current.last - 1].text))))) close();
    if (!current) current = { first: unit.id, last: unit.id, chapter, subsection, continuesPrevious: false };
    else current.last = unit.id;
  }
  close();
  const graph = makeGraph(text, units, plans, { sourceKind: 'imported-summary', sourceName });
  graph.buildMode = 'summary-fast-local';
  for (const p of graph.paragraphs) {
    const source = text.slice(p.start, p.end);
    Object.assign(p, {
      importance: /研究问题|贡献|方法|结果|结论|局限|假设|证据|experiment|result|conclusion|limitation/i.test(source) ? 'high' : 'medium',
      density: source.length > 1800 ? 'high' : source.length > 700 ? 'medium' : 'low',
      summary: localSummary(source), reason: '根据精炼稿标题层级与连续内容在本机建立的导航单元。', keyQuotes: []
    });
  }
  for (const c of graph.chapters) {
    const nodes = graph.paragraphs.filter(p => p.chapterId === c.id);
    c.summary = localSummary(nodes.map(p => p.summary).join(' '), 850);
  }
  graph.narrative = graph.chapters.map(c => `${c.id} ${c.title}`).join(' → ');
  graph.boundaryNote += ` 本地结构完整覆盖 ${graph.paragraphs.length} 个导航单元；AI 优化最多调用一次。`;
  return graph;
}

export function boundedSummaryMaterial(graph, text, limit = 42000) {
  const all = graph.paragraphs;
  const maximumNodes = 48;
  const selected = all.length <= maximumNodes ? all : Array.from({ length: maximumNodes }, (_, index) => {
    const at = Math.round(index * (all.length - 1) / (maximumNodes - 1));
    return all[at];
  }).filter((p, index, items) => !index || p.id !== items[index - 1].id);
  const overhead = selected.reduce((n, p) => {
    const chapter = graph.chapters.find(c => c.id === p.chapterId);
    const section = chapter?.children.find(s => s.id === p.sectionId);
    return n + 40 + (chapter?.title.length || 0) + (section?.title.length || 0);
  }, 0);
  const each = Math.max(120, Math.floor((limit - overhead) / Math.max(1, selected.length)));
  let sampled = selected.length < all.length;
  const blocks = selected.map(p => {
    const source = text.slice(p.start, p.end);
    let visible = source;
    if (source.length > each) {
      sampled = true;
      const front = Math.floor(each * .68), back = each - front;
      visible = `${source.slice(0, front)}\n[…本单元中部仅保留在本机，未发送…]\n${source.slice(-back)}`;
    }
    const chapter = graph.chapters.find(c => c.id === p.chapterId);
    const section = chapter?.children.find(s => s.id === p.sectionId);
    return `[${p.id}.1 | ${(chapter?.title || '').slice(0, 180)}${section ? ' / ' + section.title.slice(0, 220) : ''}]\n${visible}`;
  });
  const joined = blocks.join('\n\n');
  return { text: joined.length <= limit ? joined : joined.slice(0, limit), sampled,
    paragraphIds: selected.map(p => p.id), omittedNodes: all.length - selected.length };
}
