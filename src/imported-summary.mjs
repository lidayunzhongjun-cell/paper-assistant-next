import { unzipSync, strFromU8 } from 'fflate';

export const SUMMARY_MIN_CHARS = 200;
export const SUMMARY_MAX_CHARS = 300000;
export const SUMMARY_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DOCX_XML_MAX_BYTES = 5 * 1024 * 1024;

function clean(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function decodeXML(text) {
  return text.replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (all, hex, decimal, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(parseInt(decimal, 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()];
  });
}

export function docxText(bytes) {
  let tooLarge = false;
  let files;
  try {
    files = unzipSync(bytes, { filter: file => {
      if (file.name !== 'word/document.xml') return false;
      if (file.originalSize > DOCX_XML_MAX_BYTES) { tooLarge = true; return false; }
      return true;
    } });
  } catch {
    throw new Error('无法读取 DOCX：文件可能损坏、加密，或并非有效的 Word 文档。');
  }
  if (tooLarge) throw new Error('DOCX 正文超过 5 MB，请先生成更凝练的总结。');
  const document = files['word/document.xml'];
  if (!document) throw new Error('DOCX 中没有可读取的正文。请确认文件未加密，并另存为标准 .docx。');
  const xml = strFromU8(document);
  let out = '', match;
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:(?:br|cr)\b[^>]*\/?\s*>|<\/w:p\s*>|<\/w:tc\s*>|<\/w:tr\s*>/gi;
  while ((match = token.exec(xml))) {
    if (match[1] != null) out += decodeXML(match[1]);
    else if (/^<w:tab/i.test(match[0]) || /^<\/w:tc/i.test(match[0])) out += '\t';
    else if (/^<\/w:p/i.test(match[0])) out += '\n\n';
    else out += '\n';
  }
  return clean(out);
}

function validate(text) {
  if (text.length < SUMMARY_MIN_CHARS) throw new Error(`精炼稿只有 ${text.length} 个字符，至少需要 ${SUMMARY_MIN_CHARS} 个字符。`);
  if (text.length > SUMMARY_MAX_CHARS) throw new Error(`精炼稿超过 ${SUMMARY_MAX_CHARS.toLocaleString()} 个字符，请让 AI 进一步凝练后再导入。`);
  return text;
}

export function parseImportedSummary(fileName, bytes) {
  const name = String(fileName || '').split(/[\\/]/).pop() || '未命名文件';
  const ext = name.toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (data.byteLength > SUMMARY_MAX_FILE_BYTES) throw new Error('文件超过 8 MB，请导入凝练后的 DOCX、TXT 或 Markdown。');
  let text, type;
  if (ext === 'docx') { text = docxText(data); type = 'docx'; }
  else if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    try { text = clean(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { throw new Error('文本不是 UTF-8 编码。请在编辑器中另存为 UTF-8 的 .txt 或 .md。'); }
    type = ext === 'txt' ? 'txt' : 'markdown';
  } else if (ext === 'doc') throw new Error('不支持旧版 .doc。请在 Word 中“另存为” .docx，或导出 UTF-8 的 .txt。');
  else throw new Error('不支持该文件格式。请选择 .docx、.txt 或 .md。');
  validate(text);
  return { name, type, text, charCount: text.length, byteCount: data.byteLength, importedAt: Date.now() };
}

export function importedSummaryUsable(paper) {
  const item = paper?.importedSummary;
  return Boolean(item && typeof item.text === 'string' && item.text.length >= SUMMARY_MIN_CHARS && item.text.length <= SUMMARY_MAX_CHARS);
}
