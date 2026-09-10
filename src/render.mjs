export const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inline = text => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

// Deliberately small, escaped Markdown subset; model text never creates active HTML.
export function markdown(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  let out = '', list = '', code = null;
  const close = () => { if (list) { out += `</${list}>`; list = ''; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      close();
      if (code !== null) { out += '<pre><code>' + escape(code.join('\n')) + '</code></pre>'; code = null; }
      else code = [];
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      close();
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      out += '<div class="table-scroll"><table><thead><tr>' + cells(line).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
      i++;
      while ((lines[i + 1] || '').includes('|')) {
        out += '<tr>' + cells(lines[++i]).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
      }
      out += '</tbody></table></div>'; continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const bullet = line.match(/^\s*([-*+]\s+|\d+[.)、]\s+)(.+)$/);
    if (heading) { close(); out += `<h3>${inline(heading[2])}</h3>`; }
    else if (bullet) {
      const type = /^\d/.test(bullet[1]) ? 'ol' : 'ul';
      if (list !== type) { close(); out += `<${type}>`; list = type; }
      out += `<li>${inline(bullet[2])}</li>`;
    } else { close();
      if (line.startsWith('> ')) out += `<blockquote>${inline(line.slice(2))}</blockquote>`;
      else if (line.trim()) out += `<p>${inline(line)}</p>`;
    }
  }
  close();
  if (code !== null) out += '<pre><code>' + escape(code.join('\n')) + '</code></pre>';
  return out;
}

export function answerHTML(text) {
  const sections = String(text).split(/(?=^#{1,3}\s)/m).filter(s => s.trim());
  if (sections.length < 2) return `<div class="answer-content">${markdown(text)}</div>`;
  return sections.map((section, i) => {
    const match = section.match(/^#{1,3}\s+([^\n]+)\n?([\s\S]*)/);
    if (!match) return `<div class="takeaway">${markdown(section)}</div>`;
    if (i === 0) return `<section class="takeaway"><h3>${inline(match[1])}</h3>${markdown(match[2])}</section>`;
    return `<details ${/翻译|为什么|推理|对照/.test(match[1]) ? 'open' : ''}><summary>${inline(match[1])}</summary>${markdown(match[2])}</details>`;
  }).join('');
}
