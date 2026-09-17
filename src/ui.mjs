/* global Services, Zotero, rootURI */
import styles from './workspace.css';
import katexStyles from 'katex/dist/katex.min.css';
import { escape, answerHTML } from './render.mjs';
import { makeThread, planThreadDeletion, uid, exportMarkdown } from './core.mjs';
import { getConfig, saveConfig, callModel, extract, pickImportedSummary } from './runtime.mjs';
import { buildGraph, buildImportedSummaryGraph, prepareConversation } from './graph-runtime.mjs';
import { graphUsable, importedGraphUsable, activeGraph, graphMarkdown, location } from './graph.mjs';
import { cacheControls, fullCachePatch, paragraphCachePatch, persistPatch } from './cache.mjs';
import { importedSummaryUsable } from './imported-summary.mjs';
import { SUMMARY_IMPORT_PROMPT } from './summary-prompt.mjs';
import { makeImportedSummarySkeleton } from './summary-graph.mjs';

export const SHELL = `<header><div><div class="brand">Paper Assistant <span class="small">NEXT / 精读工作台</span></div><div class="small">读懂一段，接上全文，追问到底。</div></div><div><button id="focus">专注</button> <button id="settings-toggle">API 设置</button></div></header>
<div class="layout"><aside><h2>锁定的论文</h2><div id="paper-title" class="paper-title"></div><div class="small">切换 PDF 不会改变此会话的论文来源。</div><h2>阅读路径</h2><div id="sessions" class="sessions"></div><div class="sidebar-actions"><button id="new-thread">＋ 新建全文问答</button><button id="clear-messages">清空当前会话内容</button><button id="read-paper">建立 PDF 全文图谱</button><button id="clear-full-cache">清除 PDF 全文缓存</button><button id="import-summary">导入 AI 精炼稿</button><button id="build-summary-local">本地建立精炼稿导航（0 Token）</button><button id="build-summary-graph">AI 优化精炼稿图谱（1次 API）</button><button id="copy-summary-prompt">复制精炼提示语</button><button id="remove-summary">移除精炼稿</button><div id="summary-status" class="small"></div><button id="back">回到原文</button></div></aside>
<section class="workspace"><div id="settings" class="settings" hidden><strong>模型连接</strong><label>API Base URL 或完整 Chat Completions URL<input id="endpoint" placeholder="https://api.deepseek.com/v1"></label><label>模型 ID<input id="model"></label><label>API Key（本地无认证服务可留空）<input id="api-key" type="password" autocomplete="off"></label><button id="save-settings" class="primary">保存</button><p class="small">Key 存在本机 Zotero 偏好设置中（非加密保险库）。发送问题会把选段、相关原文和对话发送至配置服务；全文导读会分块发送完整提取文字并产生多次计费请求。</p></div>
<div class="toolbar"><label>会话 <select id="thread-picker" aria-label="阅读会话"></select></label><label>图谱来源 <select id="graph-source" aria-label="图谱来源"></select></label><button id="mastered">标记读懂</button><span class="grow"></span><button id="bookmarks">只看收藏</button><button id="font">大字</button><button id="export">复制笔记</button></div>
<div id="scroll" class="scroll"><details id="knowledge" class="source"><summary id="knowledge-title">全文精读 · 树状知识图谱</summary><div id="graph-tree"></div></details><details id="source" class="source" open><summary id="source-title">锁定原文</summary><pre id="source-text"></pre><button id="clear-paragraph-cache" hidden>清除本段缓存</button></details><div id="messages" aria-label="问答记录"></div></div>
<div class="composer"><div class="quick"><button data-prompt="请精读这段：准确翻译，解释推理、全文作用和必要术语。">精读选段</button><button data-prompt="请专门核对并复原选段中的公式和数学符号：先列出 PDF 提取文字可能破坏的上下标、希腊字母、粗体向量、运算符与括号，再用 LaTeX 完整重排公式并逐项解释。行内公式使用 \\( ... \\)，独立公式使用单独成行的 $$。无法从材料唯一确定的符号请列出歧义，不要猜。">公式复原</button><button data-prompt="用一个直观的教学例子解释刚才的核心概念，并指出例子的适用边界。">举个例子</button><button data-prompt="把刚才的推导拆成逐步过程，解释每一步的依据与假设。">逐步推导</button><button data-prompt="这个结论在原文中的证据是什么？哪些是作者观点，哪些是你的推断？">核对证据</button><button data-prompt="围绕这段给我两道自测题，先不要公布答案。">自测理解</button></div><div id="quote" class="quote" hidden></div><div class="input-row"><textarea id="question" aria-label="继续追问" placeholder="继续追问；也可选中回答中的一句话，再点“引用追问”…"></textarea><button id="send" class="primary">发送</button><button id="stop" hidden>停止</button></div><div id="status" class="status" role="status" aria-live="polite">Ctrl / ⌘ + Enter 发送 · 历史记录自动保存在本机</div></div></section></div>`;

export async function openWorkspace(parent, paper, thread, store, onClose) {
  const win = Services.ww.openWindow(parent, 'about:blank', '_blank', 'chrome,dialog=no,resizable,width=1120,height=850', null);
  if (!win) throw new Error('无法打开精读工作台');
  if (win.document.readyState !== 'complete') await new Promise(resolve => win.addEventListener('load', resolve, { once: true }));
  const doc = win.document;
  const localMathStyles = katexStyles
    .replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '')
    .replace(/url\(fonts\/([^)]+)\)/g, `url("${rootURI}content/fonts/$1")`);
  doc.open(); doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>精读 · ${escape(paper.title)}</title><style>${styles}\n${localMathStyles}</style></head><body>${SHELL}</body></html>`); doc.close();
  const $ = id => doc.getElementById(id);
  let active = thread, controller = null, quoted = '', bookmarkOnly = false, closed = false;
  const status = text => { if (!closed) $('status').textContent = text; };
  const persist = () => store.save(paper).catch(error => { status('保存失败，记录仍在窗口内，请复制笔记：' + error.message); throw error; });
  const saveQuietly = () => { void persist().catch(() => {}); };
  const copy = text => { Zotero.Utilities.Internal.copyTextToClipboard(text); status('已复制为 Markdown，可粘贴到笔记中。'); };
  const stashDraft = () => { if ($('question')) active.draft = $('question').value; };
  const updateQuote = () => {
    $('quote').hidden = !quoted;
    $('quote').replaceChildren();
    if (quoted) {
      $('quote').append(doc.createTextNode('正在追问：' + quoted));
      const clear = doc.createElement('button'); clear.textContent = '取消引用';
      clear.onclick = () => { quoted = ''; updateQuote(); }; $('quote').append(clear);
    }
  };
  const renderSessions = () => {
    $('sessions').replaceChildren(); $('thread-picker').replaceChildren();
    for (const item of paper.threads) {
      const row = doc.createElement('div'); row.className = 'session-row';
      const button = doc.createElement('button'); button.className = 'session' + (item.id === active.id ? ' active' : '');
      button.textContent = (item.mastered ? '✓ ' : '') + item.title;
      const small = doc.createElement('span'); small.className = 'small';
      small.textContent = `${item.messages.filter(m => m.role === 'assistant' && m.status === 'done').length} 条回答 · ${new Date(item.updated).toLocaleDateString()}`;
      button.append(small); button.onclick = () => select(item); button.disabled = Boolean(controller);
      const remove = doc.createElement('button'); remove.className = 'session-delete'; remove.textContent = '删除';
      remove.title = `永久删除“${item.title}”`; remove.setAttribute('aria-label', `删除会话：${item.title}`);
      remove.disabled = Boolean(controller); remove.onclick = event => { event.stopPropagation(); void deleteSession(item); };
      row.append(button, remove); $('sessions').append(row);
      const option = doc.createElement('option'); option.value = item.id; option.textContent = item.title; $('thread-picker').append(option);
    }
    $('thread-picker').value = active.id;
  };
  let renderedGraph = null;
  const renderGraph = () => {
    const pdfReady = graphUsable(paper), importedReady = importedGraphUsable(paper);
    const current = activeGraph(paper);
    const graph = current?.graph || null, sourceText = current?.text || '', imported = current?.kind === 'imported';
    const picker = $('graph-source'); picker.replaceChildren();
    const choice = (value, title) => { const option = doc.createElement('option'); option.value = value; option.textContent = title; picker.append(option); };
    if (pdfReady) choice('pdf', 'PDF 原文图谱');
    if (importedReady) choice('imported', 'AI 精炼稿图谱');
    if (!pdfReady && !importedReady) choice('', '尚未建立');
    picker.value = current?.kind || ''; picker.disabled = Boolean(controller) || (!pdfReady && !importedReady);
    $('summary-status').textContent = importedSummaryUsable(paper)
      ? `${paper.importedSummary.name} · ${paper.importedSummary.charCount.toLocaleString()} 字符 · ${importedReady ? '图谱已建立' : '待建立图谱'}`
      : '支持 DOCX、TXT、Markdown；按论文单独保存。';
    $('build-summary-graph').disabled = Boolean(controller) || !importedSummaryUsable(paper);
    $('build-summary-local').disabled = Boolean(controller) || !importedSummaryUsable(paper);
    $('remove-summary').disabled = Boolean(controller) || !importedSummaryUsable(paper);
    $('read-paper').textContent = pdfReady ? '重新建立 PDF 全文图谱' : '建立 PDF 全文图谱';
    $('knowledge-title').textContent = graph ? `${imported ? 'AI 精炼稿' : 'PDF 全文'}精读 · 树状知识图谱` : '全文精读 · 树状知识图谱';
    if (graph && renderedGraph === graph && $('graph-tree').childNodes.length) return;
    renderedGraph = graph;
    const root = $('graph-tree'); root.replaceChildren();
    if (!graph) { root.textContent = '尚未建立树状知识图谱。可直接建立 PDF 全文图谱，或导入 AI 精炼稿后建立独立图谱。'; return; }
    const paragraph = (parent, text, className = '') => { const el = doc.createElement('p'); el.textContent = text; el.className = className; parent.append(el); return el; };
    const branch = (parent, title) => { const d = doc.createElement('details'); const s = doc.createElement('summary'); s.textContent = title; d.append(s); parent.append(d); return d; };
    paragraph(root, graph.boundaryNote, 'small');
    paragraph(root, graph.narrativeInvalidated ? '部分段落缓存已清除，全文串联已失效。重新建立图谱可恢复；当前仍可使用其他段落图谱和原文问答。' : graph.narrative);
    const copyGraph = doc.createElement('button'); copyGraph.textContent = '复制完整图谱与术语'; copyGraph.onclick = () => copy(graphMarkdown(graph)); root.append(copyGraph);
    const label = { low: '低', medium: '中', high: '高' };
    const showNode = (parent, id) => {
      const p = graph.paragraphs.find(p => p.id === id);
      const node = branch(parent, p.cacheCleared ? `${p.id} · 本段缓存已清除` : `${p.id} · 重要性${label[p.importance]} / 密度${label[p.density]} · ${p.summary.slice(0, 65)}`);
      paragraph(node, p.cacheCleared ? '原文保留，可重新追问；重建 PDF 全文图谱可恢复本段精读缓存。' : p.summary);
      if (!p.cacheCleared) paragraph(node, '评判依据：' + p.reason, 'small');
      for (const q of p.keyQuotes) paragraph(node, (imported ? '精炼稿摘录（非论文原引）：' : '关键原文：') + q);
      const relations = graph.edges.filter(e => e.type !== '包含' && (e.from === id || e.to === id));
      for (const e of relations) paragraph(node, `${e.from} → ${e.to} [${e.type}] ${e.reason}${e.inferred ? '（模型推断）' : ''}`, 'small');
      const original = branch(node, `查看${imported ? '精炼稿片段' : 'PDF 提取原文'} · 字符 ${p.start}–${p.end}`);
      const selected = sourceText.slice(p.start, p.end);
      const pre = doc.createElement('pre'); pre.textContent = selected; original.append(pre);
      const read = doc.createElement('button'); read.textContent = '精读 / 追问这一段';
      read.onclick = () => {
        if (controller) { status('请先完成或停止当前请求。'); return; }
        let t = paper.threads.find(t => t.paragraphId === id && t.selection === selected && t.sourceKind === graph.sourceKind);
        if (!t) { t = makeThread(paper, selected); t.paragraphId = id; t.sourceKind = graph.sourceKind; t.title = location(graph, p); paper.threads.push(t); }
        select(t); $('knowledge').open = false; $('question').focus();
      }; node.append(read);
    };
    for (const c of graph.chapters) {
      const chapter = branch(root, `${c.id} · ${c.title}`); paragraph(chapter, c.summaryInvalidated ? '章节串联因段落缓存清除而失效；其余段落仍保留。' : c.summary);
      for (const child of c.children) {
        if (child.kind === 'section') { const section = branch(chapter, child.title); for (const p of child.children) showNode(section, p.id); }
        else showNode(chapter, child.id);
      }
    }
    const relations = branch(root, `章节之间的关系${imported ? '（来自二手精炼材料）' : ''}`);
    for (const e of graph.edges.filter(e => e.inferred && e.from.startsWith('c') && e.to.startsWith('c'))) paragraph(relations, `${e.from} → ${e.to} [${e.type}] ${e.reason}（模型推断）`);
    const terms = branch(root, `独立附属术语表 · ${graph.terms.length} 项`);
    for (const t of graph.terms) paragraph(terms, `${t.name}：${t.definition} [${t.paragraphIds.join('、')}]`);
  };
  const render = () => {
    renderGraph();
    renderCacheControls();
    $('paper-title').textContent = paper.title;
    $('source-title').textContent = active.sourceKind === 'imported-summary' ? '锁定的 AI 精炼稿片段（非论文原文）' : '锁定原文';
    $('source-text').textContent = active.selection || '全文会话。可建立 PDF 全文图谱，或导入 AI 精炼稿建立独立图谱，再围绕论文主线提问。';
    $('mastered').textContent = active.mastered ? '✓ 已读懂' : '标记读懂';
    $('messages').classList.toggle('bookmarks-only', bookmarkOnly);
    $('messages').replaceChildren();
    if (!active.messages.length) $('messages').innerHTML = `<div class="empty"><h1>${active.selection ? '从这一段开始理解' : '先抓主线，再读细节'}</h1><p>${active.selection ? (active.sourceKind === 'imported-summary' ? 'AI 精炼稿片段已锁定。回答会把它作为二手材料，并尽量用 PDF 原文核对。' : '原文已锁定。点击“精读选段”，然后继续追问。') : '建立 PDF 全文图谱，或导入 AI 精炼稿后建立独立图谱。'}</p><p class="small">${activeGraph(paper) ? '已有图谱背景，会先定位相关结构再回答。' : paper.overview ? '已有旧版全文阅读背景，会自动用于问答。' : '尚无全文导读；回答会明确标注所用材料范围。'}</p></div>`;
    for (const m of active.messages) {
      const article = doc.createElement('article'); article.className = 'message' + (m.starred ? ' starred' : ''); article.dataset.message = m.id;
      const meta = doc.createElement('div'); meta.className = 'message-meta';
      meta.textContent = `${m.role === 'user' ? '你' : '精读助手'} · ${new Date(m.time).toLocaleTimeString()}${m.starred ? ' · ★ 已收藏' : ''}`;
      const body = doc.createElement('div'); body.className = m.role === 'user' ? 'question' : 'answer';
      if (m.role === 'user' || m.status !== 'done') body.textContent = m.content;
      else body.innerHTML = answerHTML(m.content);
      if (m.status === 'pending') body.classList.add('pending');
      if (['error', 'interrupted'].includes(m.status)) body.classList.add('error');
      article.append(meta, body);
      if (m.evidence) { const evidence = doc.createElement('p'); evidence.className = 'evidence'; evidence.textContent = m.evidence; article.append(evidence); }
      const actions = doc.createElement('div'); actions.className = 'message-actions';
      const action = (text, run) => { const b = doc.createElement('button'); b.textContent = text; b.onclick = run; actions.append(b); };
      if (m.role === 'assistant' && m.status === 'done') {
        let chosen = '';
        body.addEventListener('mouseup', () => { const sel = win.getSelection(); if (sel && body.contains(sel.anchorNode) && body.contains(sel.focusNode)) chosen = sel.toString().trim(); });
        action('引用追问', () => { quoted = chosen || m.content; updateQuote(); $('question').focus(); status(chosen ? '已引用选中的回答片段。' : '已引用整条回答；输入你想继续了解的内容。'); });
        action(m.starred ? '取消收藏' : '★ 收藏', () => { m.starred = !m.starred; saveQuietly(); render(); });
        action('复制回答', () => copy(m.content));
      }
      if (m.role === 'assistant' && ['error', 'interrupted'].includes(m.status)) action('重试这个问题', () => { if (!controller) { $('question').value = m.retryQuestion || ''; quoted = m.retryQuote || ''; updateQuote(); void send(); } });
      article.append(actions); $('messages').append(article);
    }
    renderSessions(); updateQuote();
  };
  function select(item) {
    if (controller) { status('当前请求进行中，请完成或停止后切换会话。'); $('thread-picker').value = active.id; return; }
    stashDraft(); saveQuietly(); active = item; quoted = ''; $('question').value = active.draft || ''; render();
    $('scroll').scrollTop = 0;
  }
  async function deleteSession(item) {
    if (controller || closed) return;
    const answerCount = item.messages.filter(message => message.role === 'assistant' && message.status === 'done').length;
    const prompt = `永久删除阅读路径“${item.title}”？\n\n将删除它绑定的选段、${answerCount} 条回答、收藏、草稿和“已读懂”状态。PDF、知识图谱及其他阅读路径会保留。此操作不能撤销。`;
    if (!win.confirm(prompt)) return;
    stashDraft();
    let plan;
    try { plan = planThreadDeletion(paper, item.id, active.id); }
    catch (error) { status(error.message); return; }
    controller = new win.AbortController(); busy(true); $('stop').hidden = true;
    try {
      await persistPatch(paper, paper, { threads: plan.threads }, store);
      if (active.id === item.id) {
        active = plan.active; quoted = ''; bookmarkOnly = false;
        $('bookmarks').textContent = '只看收藏'; $('question').value = active.draft || '';
      }
      status(plan.createdReplacement
        ? '原阅读路径已删除；已自动建立一个新的空白全文问答。'
        : '阅读路径已永久删除；PDF、图谱及其他会话均已保留。');
    } catch (error) { status('删除失败，原阅读路径已恢复：' + error.message); }
    finally { controller = null; if (!closed) { busy(false); render(); } }
  }
  const busy = value => {
    $('send').disabled = value; $('read-paper').disabled = value; $('new-thread').disabled = value;
    $('import-summary').disabled = value; $('build-summary-graph').disabled = value || !importedSummaryUsable(paper);
    $('build-summary-local').disabled = value || !importedSummaryUsable(paper);
    $('remove-summary').disabled = value || !importedSummaryUsable(paper); $('graph-source').disabled = value || !activeGraph(paper);
    $('stop').hidden = !value; $('thread-picker').disabled = value;
    for (const button of doc.querySelectorAll('[data-prompt]')) button.disabled = value;
    for (const button of doc.querySelectorAll('.session,.session-delete')) button.disabled = value;
    renderCacheControls();
  };
  function renderCacheControls() {
    const state = cacheControls(paper, active);
    $('clear-messages').disabled = Boolean(controller) || !state.canClearMessages;
    $('clear-full-cache').disabled = Boolean(controller) || !state.canClearFull;
    $('clear-paragraph-cache').hidden = !state.showParagraph;
    $('clear-paragraph-cache').disabled = Boolean(controller) || !state.canClearParagraph;
    $('clear-paragraph-cache').title = state.paragraphHint;
    $('clear-paragraph-cache').textContent = state.paragraphId ? `清除本段缓存（${state.paragraphId}）` : '清除本段缓存';
  }
  async function clearData(kind) {
    if (controller || closed) return;
    const state = cacheControls(paper, active);
    if ((kind === 'full' && !state.canClearFull) || (kind === 'paragraph' && !state.canClearParagraph) || (kind === 'messages' && !state.canClearMessages)) return;
    const prompt = kind === 'full' ? '清除当前论文的 PDF 提取文字缓存、PDF 知识图谱和术语表？PDF 文件、AI 精炼稿及其独立图谱、选段和所有问答记录会保留。'
      : kind === 'paragraph' ? `清除 ${state.paragraphId} 的摘要、重要性评判、关键引文、关联术语和语义关系？原文、其他段落及问答会保留。依赖本段的章节与全文串联将失效。`
      : '清除当前会话的全部问答记录（包括其中的收藏回答）？其他会话、全文和段落缓存、草稿均保留。';
    if (!win.confirm(prompt)) return;
    stashDraft();
    controller = new win.AbortController(); busy(true); $('stop').hidden = true;
    try {
      const target = kind === 'messages' ? active : paper;
      const patch = kind === 'full' ? fullCachePatch() : kind === 'paragraph' ? paragraphCachePatch(paper, active) : { messages: [], updated: Date.now() };
      await persistPatch(paper, target, patch, store);
      if (kind === 'messages') { quoted = ''; bookmarkOnly = false; $('bookmarks').textContent = '只看收藏'; }
      status(kind === 'messages' ? '当前问答记录已清除，缓存与其他会话保留。' : kind === 'full' ? 'PDF 全文缓存已清除；AI 精炼稿、独立图谱和问答记录保留。下次提问可重新提取 PDF 原文。' : '本段缓存已清除，原文与问答保留；相关章节及全文串联已标为失效。');
    } catch (error) { status('清除未保存，已恢复原数据：' + error.message); }
    finally { controller = null; if (!closed) { busy(false); render(); } }
  }
  async function send() {
    if (controller || closed) return;
    const question = $('question').value.trim(); if (!question) { $('question').focus(); return; }
    if (question.length > 10000 || quoted.length > 12000) { status('问题最多 10000 字符；引用最多 12000 字符，请选择回答中的具体句子。'); return; }
    controller = new win.AbortController(); busy(true); bookmarkOnly = false; $('bookmarks').textContent = '只看收藏';
    const target = active; const quote = quoted; const config = getConfig();
    const answer = { id: uid(), role: 'assistant', content: '正在准备论文上下文…', status: 'pending', time: Date.now(), retryQuestion: question, retryQuote: quote };
    try {
      // Extraction is local. A failure leaves a usable selection-only conversation, with an explicit label.
      if (!paper.rawText) { try { paper.rawText = await extract(paper); } catch (e) { status(e.message + ' 本轮仅使用选段。'); } }
      if (controller.signal.aborted) throw new Error('已停止');
      const request = await prepareConversation(win, config, paper, target, question, quote, controller.signal, status);
      if (controller.signal.aborted) throw new Error('已停止');
      const user = { id: uid(), role: 'user', content: request.messages.at(-1).content, status: 'done', time: Date.now() };
      answer.evidence = `${request.evidenceLabel} · ${activeGraph(paper) ? (activeGraph(paper).kind === 'imported' ? 'AI 精炼稿图谱＋PDF 原文核对' : 'PDF 图谱＋相关原文串读') : paper.overview ? '含旧版全文导读' : '无全文导读'} · ${config.model}${request.omitted ? ` · 早期 ${request.omitted} 条消息仅在本地保留，未发送给模型` : ''}`;
      target.messages.push(user, answer); target.draft = ''; target.updated = Date.now();
      $('question').value = ''; quoted = ''; render(); $('scroll').scrollTop = $('scroll').scrollHeight;
      await persist();
      status('正在回答，可停止；记录已保存。');
      answer.content = await callModel(win, config, request.messages, controller.signal);
      answer.status = 'done'; answer.time = Date.now(); target.updated = Date.now();
      await persist(); status('回答完成 · 记录已保存，可继续追问。');
    } catch (error) {
      if (answer.status === 'done') status('回答已生成，但保存失败。请复制笔记备份。');
      else {
        answer.status = controller.signal.aborted ? 'interrupted' : 'error'; answer.content = error.message;
        if (!target.messages.includes(answer)) { $('question').value = question; }
        await persist().catch(() => {}); status(error.message);
      }
    } finally {
      controller = null;
      if (!closed) {
        const nearBottom = $('scroll').scrollHeight - $('scroll').scrollTop - $('scroll').clientHeight < 160;
        busy(false); render();
        if (nearBottom) doc.querySelector(`[data-message="${answer.id}"]`)?.scrollIntoView({ block: 'start' });
      }
    }
  }
  async function readPaper() {
    if (controller || closed) return;
    controller = new win.AbortController(); busy(true);
    try {
      status('正在本地提取完整 PDF 文字…');
      const raw = await extract(paper);
      if (controller.signal.aborted) throw new Error('已停止');
      const config = getConfig();
      if (!win.confirm(`将约 ${raw.length.toLocaleString()} 字符发送到 ${new URL(endpointURLForDisplay(config.endpoint)).host}。会依次识别章节段落、逐段精读、串联章节与全文，产生多次计费调用，首次构建较慢。后续追问会用图谱预判后读取相关原文。继续？`)) return;
      // Build off to the side: cancellation/invalid output must not pair an old tree with new source.
      const graph = await buildGraph(win, config, { ...paper, rawText: raw }, controller.signal, status);
      paper.rawText = raw; paper.graph = graph; paper.activeGraphSource = 'pdf';
      paper.overview = graph.narrative; paper.overviewModel = config.model; paper.overviewTime = Date.now();
      let full = paper.threads.find(t => !t.selection);
      if (!full) { full = makeThread(paper); paper.threads.push(full); }
      full.messages.push({ id: uid(), role: 'user', content: '请建立章节—小节—段落的全文知识图谱。', status: 'done', time: Date.now() },
        { id: uid(), role: 'assistant', content: `## 全文图谱已建立\n${graph.chapters.length} 个章节，${graph.paragraphs.length} 个段落，${graph.terms.length} 项术语。可在上方树状知识图谱展开逐段精读并查看原文。\n\n## 全文串联\n${graph.narrative}`, status: 'done', time: Date.now(), evidence: `完整提取文字参与结构识别与逐段分析 · ${config.model} · 不含图表视觉理解` });
      stashDraft(); active = full; quoted = ''; $('question').value = active.draft || '';
      await persist(); $('knowledge').open = true; status('全文图谱和独立术语已保存，后续追问将先定位图谱再读取原文。');
    } catch (error) { status(error.message); }
    finally { controller = null; if (!closed) { busy(false); render(); } }
  }
  async function importSummary() {
    if (controller || closed) return;
    let buildNow = false;
    controller = new win.AbortController(); busy(true);
    try {
      status('请选择由 ChatGPT 等 AI 生成的 DOCX、TXT 或 Markdown 精炼稿…');
      const imported = await pickImportedSummary(win);
      if (!imported) { status('已取消导入。'); return; }
      if (importedSummaryUsable(paper) && !win.confirm(`当前论文已绑定“${paper.importedSummary.name}”。替换后，旧精炼稿图谱会一并移除，但 PDF 图谱和问答记录不受影响。继续？`)) {
        status('保留了原来的 AI 精炼稿。'); return;
      }
      await persistPatch(paper, paper, { importedSummary: imported, importedGraph: null,
        activeGraphSource: graphUsable(paper) ? 'pdf' : null }, store);
      renderedGraph = null;
      status(`已在本机导入 ${imported.name}（${imported.charCount.toLocaleString()} 字符），尚未发送给 API。`);
      const preview = imported.text.slice(0, 700) + (imported.text.length > 700 ? '\n……（仅显示前 700 字符）' : '');
      buildNow = win.confirm(`已在本机解析 ${imported.name}，共 ${imported.charCount.toLocaleString()} 字符，尚未发送。\n\n内容预览：\n${preview}\n\n是否现在用 1 次 API 调用优化图谱？选择“取消”不会丢失导入内容，之后也可点击“本地建立精炼稿导航（0 Token）”。`);
    } catch (error) { status(error.message); }
    finally {
      controller = null;
      if (!closed) { busy(false); render(); if (buildNow) void buildSummaryGraph(); }
    }
  }
  async function buildSummaryGraph() {
    if (controller || closed || !importedSummaryUsable(paper)) { if (!importedSummaryUsable(paper)) status('请先导入 DOCX、TXT 或 Markdown 精炼稿。'); return; }
    const summary = paper.importedSummary, config = getConfig();
    let host;
    try { host = new URL(endpointURLForDisplay(config.endpoint)).host; }
    catch (error) { status(error.message); return; }
    if (!win.confirm(`快速建图会先在本机解析“${summary.name}”的标题层级并建立完整导航，再向 ${host} 发起最多 1 次 API 请求，同时优化节点摘要、章节主线、术语和关键关系。超长文档只发送各导航单元的有界首尾样本，其余文字留在本机。材料仍标记为二手材料。继续？`)) return;
    controller = new win.AbortController(); busy(true);
    try {
      const graph = await buildImportedSummaryGraph(win, config, paper, controller.signal, status);
      const now = Date.now();
      await persistPatch(paper, paper, { importedGraph: graph, activeGraphSource: 'imported' }, store);
      let full = paper.threads.find(t => !t.selection);
      if (!full) { full = makeThread(paper); paper.threads.push(full); }
      full.messages.push({ id: uid(), role: 'user', content: `请根据导入的 AI 精炼稿“${summary.name}”建立独立知识图谱。`, status: 'done', time: now },
        { id: uid(), role: 'assistant', content: `## AI 精炼稿快速图谱已建立\n${graph.chapters.length} 个章节，${graph.paragraphs.length} 个导航单元，${graph.terms.length} 项术语。${graph.enrichmentStatus === 'local-fallback' ? '\n\n本次 API 优化没有采用，已直接保存本机生成的完整导航；没有自动重试。' : '\n\n本机结构解析后仅用 1 次 API 调用完成优化。'}\n\n> 这是根据外部 AI 精炼稿生成的二手图谱，不是论文原文证据。重要结论和引文应回到 PDF 核对。\n\n## 全文串联\n${graph.narrative}`, status: 'done', time: now,
          evidence: `外部 AI 精炼稿 ${summary.name} · ${summary.charCount.toLocaleString()} 字符 · ${graph.enrichmentStatus === 'local-fallback' ? '本地图谱，API优化未采用' : '1 次 API 优化'} · ${config.model} · 非 PDF 原文` });
      stashDraft(); active = full; quoted = ''; $('question').value = active.draft || '';
      await persist(); renderedGraph = null; $('knowledge').open = true;
      status(graph.enrichmentStatus === 'local-fallback'
        ? '已保存本地完整导航；API 优化未采用且没有重试。后续仍可用于定位精炼稿并核对 PDF。'
        : `快速图谱已保存：本机解析完整结构，1 次 API 调用优化 ${graph.paragraphs.length} 个导航单元。`);
    } catch (error) { status(error.message); }
    finally { controller = null; if (!closed) { busy(false); render(); } }
  }
  async function buildSummaryLocal() {
    if (controller || closed || !importedSummaryUsable(paper)) { if (!importedSummaryUsable(paper)) status('请先导入 DOCX、TXT 或 Markdown 精炼稿。'); return; }
    const summary = paper.importedSummary;
    controller = new win.AbortController(); busy(true); $('stop').hidden = true;
    try {
      status('正在本机解析标题层级并建立完整导航；不会调用 API…');
      const graph = makeImportedSummarySkeleton(summary.text, summary.name);
      graph.enrichmentStatus = 'local-only'; graph.aiCalls = 0;
      graph.boundaryNote += ' 当前为 0 Token 本地导航，节点内容直接来自精炼稿；需要更凝练的术语和关系时可再执行一次 AI 优化。';
      await persistPatch(paper, paper, { importedGraph: graph, activeGraphSource: 'imported' }, store);
      let full = paper.threads.find(t => !t.selection);
      if (!full) { full = makeThread(paper); paper.threads.push(full); }
      full.messages.push({ id: uid(), role: 'user', content: `请在本机根据“${summary.name}”建立零 Token 导航。`, status: 'done', time: Date.now() },
        { id: uid(), role: 'assistant', content: `## 本地精炼稿导航已建立\n${graph.chapters.length} 个章节，${graph.paragraphs.length} 个导航单元。没有调用 API，也没有消耗模型 Token。节点保持精炼稿原文，可展开查看；需要术语和语义关系时可再点击一次 AI 优化。`, status: 'done', time: Date.now(), evidence: `本机结构解析 · 0 Token · ${summary.name} · 非 PDF 原文` });
      await persist(); renderedGraph = null; $('knowledge').open = true;
      status(`本地导航已建立：${graph.chapters.length} 章、${graph.paragraphs.length} 个单元，0 次 API 调用。`);
    } catch (error) { status(error.message); }
    finally { controller = null; if (!closed) { busy(false); render(); } }
  }
  async function removeSummary() {
    if (controller || closed || !importedSummaryUsable(paper)) return;
    if (!win.confirm(`移除当前论文绑定的 AI 精炼稿“${paper.importedSummary.name}”及其独立图谱？PDF 图谱、PDF 文件和所有问答记录会保留。`)) return;
    controller = new win.AbortController(); busy(true); $('stop').hidden = true;
    try {
      await persistPatch(paper, paper, { importedSummary: null, importedGraph: null,
        activeGraphSource: graphUsable(paper) ? 'pdf' : null }, store);
      renderedGraph = null; status('AI 精炼稿及其独立图谱已移除；PDF 图谱和问答记录保留。');
    } catch (error) { status('移除失败，原数据已恢复：' + error.message); }
    finally { controller = null; if (!closed) { busy(false); render(); } }
  }
  $('send').onclick = () => void send();
  $('stop').onclick = () => { controller?.abort(); status('已请求停止，不再继续后续模型调用。'); };
  $('question').addEventListener('input', () => { stashDraft(); });
  $('question').addEventListener('blur', saveQuietly);
  $('question').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); void send(); } });
  $('thread-picker').onchange = () => select(paper.threads.find(t => t.id === $('thread-picker').value) || active);
  $('new-thread').onclick = () => { const t = makeThread(paper); paper.threads.push(t); select(t); saveQuietly(); };
  $('read-paper').onclick = () => void readPaper();
  $('import-summary').onclick = () => void importSummary();
  $('build-summary-local').onclick = () => void buildSummaryLocal();
  $('build-summary-graph').onclick = () => void buildSummaryGraph();
  $('copy-summary-prompt').onclick = () => { Zotero.Utilities.Internal.copyTextToClipboard(SUMMARY_IMPORT_PROMPT); status('已复制 AI 精炼稿提示语，可直接粘贴到 ChatGPT 等工具。'); };
  $('remove-summary').onclick = () => void removeSummary();
  $('graph-source').onchange = () => {
    if (!$('graph-source').value || controller) return;
    paper.activeGraphSource = $('graph-source').value; renderedGraph = null; saveQuietly(); render();
    status(`已切换到${paper.activeGraphSource === 'imported' ? ' AI 精炼稿图谱（二手材料）' : ' PDF 原文图谱'}。`);
  };
  $('clear-full-cache').onclick = () => void clearData('full');
  $('clear-paragraph-cache').onclick = () => void clearData('paragraph');
  $('clear-messages').onclick = () => void clearData('messages');
  $('back').onclick = () => { void Zotero.Reader.open(paper.attachmentID, active.pageIndex == null ? undefined : { pageIndex: active.pageIndex }).catch(e => status(e.message)); };
  $('mastered').onclick = () => { active.mastered = !active.mastered; saveQuietly(); render(); };
  $('bookmarks').onclick = () => { bookmarkOnly = !bookmarkOnly; $('bookmarks').textContent = bookmarkOnly ? '显示全部' : '只看收藏'; render(); };
  $('focus').onclick = () => doc.body.classList.toggle('focus-mode');
  $('font').onclick = () => $('messages').classList.toggle('read-size');
  $('export').onclick = () => copy(exportMarkdown(paper, active));
  $('settings-toggle').onclick = () => {
    $('settings').hidden = !$('settings').hidden;
    if (!$('settings').hidden) { const c = getConfig(); $('endpoint').value = c.endpoint; $('model').value = c.model; $('api-key').value = c.apiKey; }
  };
  $('save-settings').onclick = () => {
    try { saveConfig({ endpoint: $('endpoint').value, model: $('model').value, apiKey: $('api-key').value }); $('api-key').value = ''; $('settings').hidden = true; status('设置已保存，下次请求生效。'); }
    catch (e) { status(e.message); }
  };
  for (const button of doc.querySelectorAll('[data-prompt]')) button.onclick = () => { $('question').value = button.dataset.prompt; stashDraft(); $('question').focus(); status('已填入问题，点击发送即可。'); };
  win.addEventListener('unload', () => { closed = true; controller?.abort(); stashDraft(); saveQuietly(); onClose(); }, { once: true });
  $('question').value = active.draft || ''; render(); win.focus();
  return { win, select, close: () => { controller?.abort(); win.close(); } };
}

// Use the same validator as requests; no network call is made for this label.
import { endpointURL as endpointURLForDisplay } from './core.mjs';
