/* global Zotero */
import { ID, makeThread, normalize } from './core.mjs';
import { PaperStore, identify } from './runtime.mjs';
import { openWorkspace } from './ui.mjs';

const store = new PaperStore();
const windows = new Map();
const workspaces = new Map();
const opening = new Map();
let alive = true;

async function launch(win, reader = null, selection = '', pageIndex = null) {
  try {
    // Resolve identity using the originating Reader BEFORE any dialog or await that changes focus.
    const identity = await identify(reader, win);
    if (!alive) return;
    if (selection.length > 18000) throw new Error('选段超过 18000 字符，请缩小到需要理解的几段；整篇论文请使用全文导读。');
    const paper = await store.load(identity);
    let thread = paper.threads.find(t => normalize(t.selection) === normalize(selection) && t.pageIndex === pageIndex);
    if (!thread) { thread = makeThread(paper, selection, pageIndex); paper.threads.push(thread); await store.save(paper); }
    if (!alive) return;
    if (opening.has(paper.id)) await opening.get(paper.id);
    const existing = workspaces.get(paper.id);
    if (existing && !existing.win.closed) { existing.select(thread); existing.win.focus(); return; }
    const promise = openWorkspace(win, paper, thread, store, () => workspaces.delete(paper.id));
    opening.set(paper.id, promise);
    try {
      const workspace = await promise;
      if (!alive) { workspace.close(); return; }
      workspaces.set(paper.id, workspace);
    } finally { opening.delete(paper.id); }
  } catch (error) { if (alive) win.alert('Paper Assistant Next：' + error.message); }
}

export function register(win) {
  if (windows.has(win) || !alive) return;
  const popup = win.document.getElementById('menu_ToolsPopup');
  if (!popup) return;
  const item = win.document.createXULElement('menuitem');
  item.id = 'paper-assistant-next-open';
  item.setAttribute('label', 'Paper Assistant Next · 精读工作台');
  item.addEventListener('command', () => void launch(win));
  popup.append(item); windows.set(win, item);
}
export function unregister(win) { windows.get(win)?.remove(); windows.delete(win); }

export async function startup() {
  await Zotero.uiReadyPromise;
  alive = true;
  for (const win of Zotero.getMainWindows()) register(win);
  const host = () => Zotero.getMainWindow();
  Zotero.Reader.registerEventListener('renderTextSelectionPopup', event => {
    if (!alive) return;
    const text = event.params?.annotation?.text || event.params?.text || '';
    if (!text.trim()) return;
    const page = event.params?.annotation?.position?.pageIndex ?? null;
    const button = event.doc.createElement('button');
    button.textContent = '精读 / 连续追问'; button.title = '锁定这篇论文和选段，打开持久会话';
    button.style.cssText = 'margin:4px;padding:5px 9px;border:1px solid #879fd2;border-radius:6px;background:#edf2ff;color:#233e7d;cursor:pointer';
    button.onclick = () => { if (alive) void launch(host(), event.reader, text, page); };
    event.append(button);
  }, ID);
  Zotero.Reader.registerEventListener('createViewContextMenu', event => {
    if (!alive) return;
    const text = event.params?.annotation?.text || event.params?.text || '';
    event.append({ label: text ? 'Next · 精读选段' : 'Next · 打开论文工作台',
      onCommand: () => { if (alive) void launch(host(), event.reader, text, event.params?.annotation?.position?.pageIndex ?? null); } });
  }, ID);
  Zotero.debug('[Paper Assistant Next] started: 2.0.1');
}

export async function shutdown() {
  alive = false;
  for (const win of [...windows.keys()]) unregister(win);
  for (const workspace of workspaces.values()) workspace.close();
  workspaces.clear();
  // Reader cleans registrations by plugin ID on shutdown. Old callbacks are inert immediately.
  await store.queue.catch(() => {});
}
