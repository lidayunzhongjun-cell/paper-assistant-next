/* global Services, Zotero */
import styles from './workspace.css';
import { escape, answerHTML } from './render.mjs';
import { makeThread, uid, conversationRequest, exportMarkdown } from './core.mjs';
import { getConfig, saveConfig, callModel, extract, overview } from './runtime.mjs';

export const SHELL = `<header><div><div class="brand">Paper Assistant <span class="small">NEXT / 精读工作台</span></div><div class="small">读懂一段，接上全文，追问到底。</div></div><div><button id="focus">专注</button> <button id="settings-toggle">API 设置</button></div></header>
<div class="layout"><aside><h2>锁定的论文</h2><div id="paper-title" class="paper-title"></div><div class="small">切换 PDF 不会改变此会话的论文来源。</div><h2>阅读路径</h2><div id="sessions" class="sessions"></div><div class="sidebar-actions"><button id="new-thread">＋ 新建全文问答</button><button id="read-paper">建立全文导读</button><button id="back">回到原文</button></div></aside>
<section class="workspace"><div id="settings" class="settings" hidden><strong>模型连接</strong><label>API Base URL 或完整 Chat Completions URL<input id="endpoint" placeholder="https://api.deepseek.com/v1"></label><label>模型 ID<input id="model"></label><label>API Key（本地无认证服务可留空）<input id="api-key" type="password" autocomplete="off"></label><button id="save-settings" class="primary">保存</button><p class="small">Key 存在本机 Zotero 偏好设置中（非加密保险库）。发送问题会把选段、相关原文和对话发送至配置服务；全文导读会分块发送完整提取文字并产生多次计费请求。</p></div>
<div class="toolbar"><label>会话 <select id="thread-picker" aria-label="阅读会话"></select></label><button id="mastered">标记读懂</button><span class="grow"></span><button id="bookmarks">只看收藏</button><button id="font">大字</button><button id="export">复制笔记</button></div>
<div id="scroll" class="scroll"><details id="source" class="source" open><summary>锁定原文</summary><pre id="source-text"></pre></details><div id="messages" aria-label="问答记录"></div></div>
<div class="composer"><div class="quick"><button data-prompt="请精读这段：准确翻译，解释推理、全文作用和必要术语。">精读选段</button><button data-prompt="用一个直观的教学例子解释刚才的核心概念，并指出例子的适用边界。">举个例子</button><button data-prompt="把刚才的推导拆成逐步过程，解释每一步的依据与假设。">逐步推导</button><button data-prompt="这个结论在原文中的证据是什么？哪些是作者观点，哪些是你的推断？">核对证据</button><button data-prompt="围绕这段给我两道自测题，先不要公布答案。">自测理解</button></div><div id="quote" class="quote" hidden></div><div class="input-row"><textarea id="question" aria-label="继续追问" placeholder="继续追问；也可选中回答中的一句话，再点“引用追问”…"></textarea><button id="send" class="primary">发送</button><button id="stop" hidden>停止</button></div><div id="status" class="status" role="status" aria-live="polite">Ctrl / ⌘ + Enter 发送 · 历史记录自动保存在本机</div></div></section></div>`;

export async function openWorkspace(parent, paper, thread, store, onClose) {
  const win = Services.ww.openWindow(parent, 'about:blank', '_blank', 'chrome,dialog=no,resizable,width=1120,height=850', null);
  if (!win) throw new Error('无法打开精读工作台');
  if (win.document.readyState !== 'complete') await new Promise(resolve => win.addEventListener('load', resolve, { once: true }));
  const doc = win.document;
  doc.open(); doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>精读 · ${escape(paper.title)}</title><style>${styles}</style></head><body>${SHELL}</body></html>`); doc.close();
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
      const button = doc.createElement('button'); button.className = 'session' + (item.id === active.id ? ' active' : '');
      button.textContent = (item.mastered ? '✓ ' : '') + item.title;
      const small = doc.createElement('span'); small.className = 'small';
      small.textContent = `${item.messages.filter(m => m.role === 'assistant' && m.status === 'done').length} 条回答 · ${new Date(item.updated).toLocaleDateString()}`;
      button.append(small); button.onclick = () => select(item); $('sessions').append(button);
      const option = doc.createElement('option'); option.value = item.id; option.textContent = item.title; $('thread-picker').append(option);
    }
    $('thread-picker').value = active.id;
  };
  const render = () => {
    $('paper-title').textContent = paper.title;
    $('source-text').textContent = active.selection || '全文会话。点击“建立全文导读”后，可围绕论文主线继续提问。';
    $('mastered').textContent = active.mastered ? '✓ 已读懂' : '标记读懂';
    $('messages').classList.toggle('bookmarks-only', bookmarkOnly);
    $('messages').replaceChildren();
    if (!active.messages.length) $('messages').innerHTML = `<div class="empty"><h1>${active.selection ? '从这一段开始理解' : '先抓主线，再读细节'}</h1><p>${active.selection ? '原文已锁定。点击“精读选段”，然后继续追问。' : '建立全文导读，或直接输入你对论文的问题。'}</p><p class="small">${paper.overview ? '已有全文导读，会自动用于问答。' : '尚无全文导读；回答会明确标注所用材料范围。'}</p></div>`;
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
  const busy = value => {
    $('send').disabled = value; $('read-paper').disabled = value; $('new-thread').disabled = value;
    $('stop').hidden = !value; $('thread-picker').disabled = value;
    for (const button of doc.querySelectorAll('[data-prompt]')) button.disabled = value;
  };
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
      const request = conversationRequest(paper, target, question, quote);
      const user = { id: uid(), role: 'user', content: request.messages.at(-1).content, status: 'done', time: Date.now() };
      answer.evidence = `${request.evidenceLabel} · ${paper.overview ? '含分块全文导读' : '无全文导读'} · ${config.model}${request.omitted ? ` · 早期 ${request.omitted} 条消息仅在本地保留，未发送给模型` : ''}`;
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
      const count = Math.ceil(raw.length / 12000);
      if (!win.confirm(`将约 ${raw.length.toLocaleString()} 字符发送到 ${new URL(endpointURLForDisplay(config.endpoint)).host}，预计至少 ${count + 1} 次模型调用，可能计费。继续？`)) return;
      paper.rawText = raw;
      const result = await overview(win, config, paper, controller.signal, status);
      paper.overview = result; paper.overviewModel = config.model; paper.overviewTime = Date.now();
      let full = paper.threads.find(t => !t.selection);
      if (!full) { full = makeThread(paper); paper.threads.push(full); }
      full.messages.push({ id: uid(), role: 'user', content: '请生成全文导读。', status: 'done', time: Date.now() },
        { id: uid(), role: 'assistant', content: result, status: 'done', time: Date.now(), evidence: `全文提取文字分块分析 · ${config.model} · 不含图表视觉理解` });
      stashDraft(); active = full; quoted = ''; $('question').value = active.draft || '';
      await persist(); status('全文导读已保存，后续问答将引用它。');
    } catch (error) { status(error.message); }
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
