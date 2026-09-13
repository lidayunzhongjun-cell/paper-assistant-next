import { graphUsable, locateSelection } from './graph.mjs';

export function cacheControls(paper, thread) {
  const showParagraph = Boolean(thread.selection?.trim());
  const ids = showParagraph && thread.sourceKind !== 'imported-summary' && graphUsable(paper)
    ? locateSelection(paper.graph, paper.rawText, thread.selection, thread.paragraphId) : [];
  const node = ids.length === 1 ? paper.graph.paragraphs.find(p => p.id === ids[0]) : null;
  return {
    showParagraph, paragraphId: node?.id || null,
    canClearParagraph: Boolean(node && !node.cacheCleared),
    paragraphHint: !showParagraph ? '' : thread.sourceKind === 'imported-summary' ? 'AI 精炼稿段落缓存可通过“移除精炼稿”统一管理。'
      : ids.length > 1 ? '选段匹配多个段落，请从图谱选择一个具体段落。'
      : !node ? '当前选段没有可定位的段落图谱缓存。' : node.cacheCleared ? '本段缓存已清除。' : `只清除 ${node.id} 的精读缓存，保留原文与问答。`,
    canClearFull: Boolean(paper.rawText || paper.graph || paper.overview),
    canClearMessages: Boolean(thread.messages.length)
  };
}

export function fullCachePatch() {
  return { rawText: '', graph: null, overview: '', overviewModel: null, overviewTime: null };
}

export function paragraphCachePatch(paper, thread) {
  const state = cacheControls(paper, thread);
  if (!state.canClearParagraph) throw new Error(state.paragraphHint || '请先选中一个具体段落。');
  const id = state.paragraphId;
  const graph = JSON.parse(JSON.stringify(paper.graph));
  const p = graph.paragraphs.find(p => p.id === id);
  Object.assign(p, { summary: '', importance: null, density: null, reason: '', keyQuotes: [], cacheCleared: true });
  // Source bounds and structural edges remain usable for retrieving the original.
  graph.edges = graph.edges.filter(e => !e.inferred || (e.from !== id && e.to !== id && e.from !== p.chapterId && e.to !== p.chapterId));
  graph.terms = graph.terms.map(t => ({ ...t, paragraphIds: t.paragraphIds.filter(pid => pid !== id) })).filter(t => t.paragraphIds.length);
  const chapter = graph.chapters.find(c => c.id === p.chapterId);
  chapter.summary = ''; chapter.summaryInvalidated = true;
  graph.narrative = ''; graph.narrativeInvalidated = true;
  // These aggregates contained the deleted analysis and must not resurrect it in retrieval.
  return { graph, overview: '', overviewModel: null, overviewTime: null };
}

// Keep shared paper/thread objects stable; atomic file writes happen through PaperStore.
// On a failed save restore exactly the fields owned by this action.
export async function persistPatch(paper, target, patch, store) {
  const before = Object.fromEntries(Object.keys(patch).map(key => [key, target[key]]));
  const absent = Object.keys(patch).filter(key => !Object.hasOwn(target, key));
  Object.assign(target, patch);
  try { await store.save(paper); }
  catch (error) {
    Object.assign(target, before);
    for (const key of absent) delete target[key];
    throw error;
  }
}
