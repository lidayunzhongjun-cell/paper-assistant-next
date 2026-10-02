// Deterministic, local-only retrieval. Stored postings contain offsets into
// graph.paragraphs, never copies of the PDF text.
const STOP = new Set(`the a an and or but if then than that this these those is are was were be been being of to in on for from with without by as at into over under between among it its their his her we our they them you your can may might should would could do does did not no yes using use used based via et al figure figures table tables section sections paper study studies show shows shown which where when while also such each all both one two three more less however therefore thus because through about within across new novel`.split(' '));

export function termsOf(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const words = text.match(/[a-z][a-z0-9_-]{1,}|[\u4e00-\u9fff]+/g) || [];
  const terms = [];
  for (const word of words) {
    if (/^[\u4e00-\u9fff]+$/.test(word)) {
      if (word.length === 1) continue;
      if (word.length <= 4) terms.push(word);
      for (let i = 0; i + 1 < word.length; i++) terms.push(word.slice(i, i + 2));
    } else if (!STOP.has(word)) terms.push(word);
  }
  return terms;
}

export function buildLocalIndex(graph, sourceText) {
  const postings = Object.create(null), lengths = [], aliases = Object.create(null);
  const citationMap = new Map();
  for (let i = 0; i < graph.paragraphs.length; i++) {
    const p = graph.paragraphs[i], text = sourceText.slice(p.start, p.end);
    const tokens = termsOf(text), counts = new Map();
    lengths.push(tokens.length);
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    for (const [token, count] of counts) (postings[token] ||= []).push([i, count]);
    for (const match of text.matchAll(/\b([A-Za-z][A-Za-z -]{7,80}?)\s*\(([A-Z]{2,10})\)/g)) {
      const long = match[1].trim().toLowerCase(), short = match[2].toLowerCase();
      if (long.split(/\s+/).length >= 2) aliases[short] = long;
    }
    const chapter = graph.chapters.find(c => c.id === p.chapterId)?.title || '';
    if (/\breferences\b|\bbibliography\b|参考文献/i.test(chapter)) continue;
    for (const match of text.matchAll(/\[(\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*)\]/g)) {
      for (const number of match[1].match(/\d{1,3}/g) || []) {
        const key = `${p.id}|参考文献 ${number}`;
        citationMap.set(key, { from: p.id, target: `参考文献 ${number}`, kind: '文献引用' });
      }
    }
    for (const match of text.matchAll(/\b(Fig(?:ure)?|Table|Eq(?:uation)?|Sec(?:tion)?)\.?\s*\(?([A-Z]?\d+(?:\.\d+)*(?:[a-z])?)\)?/gi)) {
      const key = `${p.id}|${match[1].toLowerCase()} ${match[2]}`;
      citationMap.set(key, { from: p.id, target: `${match[1]} ${match[2]}`, kind: '文内交叉引用' });
    }
  }
  const count = graph.paragraphs.length;
  const scored = Object.entries(postings).map(([term, rows]) => {
    const tf = rows.reduce((sum, row) => sum + row[1], 0);
    return { term, score: tf * Math.log(1 + (count - rows.length + .5) / (rows.length + .5)), df: rows.length };
  }).filter(item => item.term.length > 2 && item.df <= Math.max(3, count * .65))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const keywords = scored.slice(0, 80).map(item => item.term);
  const keywordSet = new Set(keywords.slice(0, 50));
  const keywordByParagraph = Array.from({ length: count }, () => []);
  for (const term of keywordSet) for (const [i] of postings[term]) if (keywordByParagraph[i].length < 10) keywordByParagraph[i].push(term);
  const pairs = new Map();
  for (let i = 0; i < count; i++) {
    const present = keywordByParagraph[i];
    for (let a = 0; a < present.length; a++) for (let b = a + 1; b < present.length; b++) {
      const key = [present[a], present[b]].sort().join('\u0000');
      const value = pairs.get(key) || { terms: key.split('\u0000'), count: 0, paragraphIds: [] };
      value.count++; if (value.paragraphIds.length < 5) value.paragraphIds.push(graph.paragraphs[i].id);
      pairs.set(key, value);
    }
  }
  return { version: 1, lengths, avgLength: lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, count),
    postings, keywords, aliases,
    coWords: [...pairs.values()].filter(edge => edge.count > 1).sort((a, b) => b.count - a.count).slice(0, 80),
    citations: [...citationMap.values()].slice(0, 250) };
}

export function bm25Scores(index, query) {
  if (!index?.postings || !Array.isArray(index.lengths)) return [];
  const scores = Array(index.lengths.length).fill(0), tokens = new Set(termsOf(query));
  for (const token of [...tokens]) {
    const alias = index.aliases?.[token];
    if (alias) for (const word of termsOf(alias)) tokens.add(word);
  }
  const n = index.lengths.length, avg = Math.max(1, index.avgLength || 1);
  for (const token of tokens) {
    const rows = index.postings[token]; if (!rows) continue;
    const idf = Math.log(1 + (n - rows.length + .5) / (rows.length + .5));
    for (const [i, tf] of rows) {
      const length = index.lengths[i] || 0;
      scores[i] += idf * (tf * 2.2) / (tf + 1.2 * (.25 + .75 * length / avg));
    }
  }
  return scores;
}
