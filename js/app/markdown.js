// Markdown to safe HTML, with no dependencies. One reader uses it:
//  - renderMarkdown(text): the `markdown` widget (the Note node). Everything typed is escaped first; the only tags that come out
//    are the ones made here, links are limited to http(s) and mailto, and images are not loaded (a note must not call out to
//    other sites).
//  markdownSlug(text) is the id/URL form of a heading or a Settings section name.
'use strict';

const MD_LIMIT = 50000; // characters rendered; the editor still holds all of it
const MD_DEPTH = 8; // nesting of quotes and lists

const mdEscape = text =>
  String(text).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

/** Bold, italic and strike-through on text that is already escaped. */
function mdEmphasis(s) {
  return s
    .replace(/\*\*(?=\S)(.+?\S|\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)__(?=\S)(.+?\S|\S)__(?=\W|$)/g, '$1<strong>$2</strong>')
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '<em>$1</em>')
    .replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)(.+?\S|\S)~~/g, '<del>$1</del>');
}

const markdownSlug = text => String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
const mdSafeLink = url => /^(https?:\/\/|mailto:)/i.test(url);
const mdAnchor = (url, inner) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

/** One line of running text (or several joined by \n). */
function mdInline(text) {
  const stash = [];
  const keep = html => `\u0000${stash.push(html) - 1}\u0000`;
  let s = String(text).replace(/\u0000/g, '');
  // Code spans first: what is inside is neither formatted nor linked.
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${mdEscape(code.trim())}</code>`));
  s = mdEscape(s);
  // A backslash makes the next punctuation character plain.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, c) => keep(c));
  // [label](url "title")
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^\n]*?&quot;)?\)/g, (all, label, url) =>
    mdSafeLink(url) ? keep(mdAnchor(url, mdEmphasis(label))) : all
  );
  // Bare addresses.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]])/g, (_, before, url) => before + keep(mdAnchor(url, url)));
  s = mdEmphasis(s);
  // Put the stashed pieces back (a piece may hold another one).
  for (let i = 0; i < 4 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[n] ?? '');
  return s;
}

const MD_FENCE = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)/;
const MD_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const MD_RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const MD_QUOTE = /^ {0,3}>/;
const MD_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const mdCells = line => {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
};

const mdStartsBlock = line =>
  MD_FENCE.test(line) || MD_HEADING.test(line) || MD_RULE.test(line) || MD_QUOTE.test(line) || MD_ITEM.test(line);

function mdList(lines, depth) {
  const first = lines[0].match(MD_ITEM),
    base = first[1].length,
    ordered = /\d/.test(first[2]),
    items = [];
  for (const line of lines) {
    const m = line.match(MD_ITEM);
    if (m && m[1].length <= base + 1) items.push({text: m[3], rest: []});
    else if (items.length) items[items.length - 1].rest.push(line);
  }
  const start = ordered ? parseInt(first[2], 10) : 1;
  const html = items.map(item => {
    let text = item.text,
      mark = '';
    const task = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      mark = `<span class="md-task">${task[1] === ' ' ? '☐' : '☑'}</span> `;
      text = task[2];
    }
    const indent = Math.min(...item.rest.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length), Infinity);
    const nested = item.rest.length ? mdBlocks(item.rest.map(l => l.slice(Number.isFinite(indent) ? indent : 0)), depth + 1) : '';
    return `<li>${mark}${mdInline(text)}${nested}</li>`;
  });
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${html.join('')}</${tag}>`;
}

function mdBlocks(lines, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (depth >= MD_DEPTH) {
      out.push(`<p>${mdInline(lines.slice(i).join('\n')).replace(/\n/g, '<br>')}</p>`);
      break;
    }
    const fence = line.match(MD_FENCE);
    if (fence) {
      const marker = fence[1][0],
        code = [];
      for (i++; i < lines.length && !new RegExp(`^\\s{0,3}${marker}{${fence[1].length},}\\s*$`).test(lines[i]); i++) code.push(lines[i]);
      i++; // the closing fence
      out.push(`<pre><code>${mdEscape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(MD_HEADING);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (MD_RULE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (MD_QUOTE.test(line)) {
      const quoted = [];
      for (; i < lines.length && MD_QUOTE.test(lines[i]); i++) quoted.push(lines[i].replace(/^ {0,3}>\s?/, ''));
      out.push(`<blockquote>${mdBlocks(quoted, depth + 1)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && MD_TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = mdCells(line),
        align = mdCells(lines[i + 1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : '')),
        rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(mdCells(lines[i]));
      const cell = (tag, text, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${mdInline(text ?? '')}</${tag}>`;
      out.push(
        `<table><thead><tr>${head.map((c, n) => cell('th', c, n)).join('')}</tr></thead><tbody>${rows
          .map(r => `<tr>${head.map((_, n) => cell('td', r[n], n)).join('')}</tr>`)
          .join('')}</tbody></table>`
      );
      continue;
    }
    if (MD_ITEM.test(line)) {
      const block = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() && (MD_ITEM.test(l) || /^\s/.test(l))) block.push(l);
        else if (!l.trim() && i + 1 < lines.length && (MD_ITEM.test(lines[i + 1]) || /^\s+\S/.test(lines[i + 1]))) block.push(l);
        else break;
        i++;
      }
      out.push(mdList(block.filter((l, n) => l.trim() || (block[n + 1] ?? '').trim()), depth));
      continue;
    }
    const paragraph = [line];
    for (i++; i < lines.length && lines[i].trim() && !mdStartsBlock(lines[i]); i++) paragraph.push(lines[i]);
    out.push(`<p>${mdInline(paragraph.map(l => l.trim()).join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}

/** The HTML of a markdown text. Safe to put into the page as it is. */
function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const cut = text.length > MD_LIMIT;
  const html = mdBlocks((cut ? text.slice(0, MD_LIMIT) : text).split('\n'));
  return cut ? `${html}<p class="md-cut">… (the rest is shown in the editor)</p>` : html;
}

if (typeof module !== 'undefined') module.exports = {renderMarkdown, markdownSlug};
