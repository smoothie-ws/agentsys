// Syntax-highlighted code editor used for the code of Custom nodes.
'use strict';

function highlightJS(code) {
  const keywords = new Set(
    'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield true false null undefined'.split(
      ' '
    )
  );
  const builtins = new Set(
    'Array Boolean Date Error JSON Map Math Number Object Promise RegExp Set String console Infinity NaN'.split(' ')
  );
  const tokens =
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b[A-Za-z_$][\w$]*\b/gim;
  let html = '',
    offset = 0;
  for (const match of code.matchAll(tokens)) {
    html += esc(code.slice(offset, match.index));
    const token = match[0],
      kind =
        token.startsWith('//') || token.startsWith('/*')
          ? 'comment'
          : /^['"`]/.test(token)
            ? 'string'
            : /^\d/.test(token)
              ? 'number'
              : keywords.has(token)
                ? 'keyword'
                : builtins.has(token)
                  ? 'builtin'
                  : '';
    html += kind ? `<span class="syntax-${kind}">${esc(token)}</span>` : esc(token);
    offset = match.index + token.length;
  }
  return html + esc(code.slice(offset)) + '\n';
}
function codeEditorHTML(code, attrs = '') {
  return `<div class="code-editor"><pre aria-hidden="true">${highlightJS(code || '')}</pre><textarea spellcheck="false" autocapitalize="off" autocomplete="off" ${attrs}>${esc(code)}</textarea></div>`;
}
function wireCodeEditors(root) {
  for (const area of $$('.code-editor textarea', root)) {
    if (area.dataset.enhanced) continue;
    area.dataset.enhanced = 'true';
    const pre = area.previousElementSibling;
    area.addEventListener('input', () => {
      pre.innerHTML = highlightJS(area.value);
    });
    area.addEventListener('scroll', () => {
      pre.scrollTop = area.scrollTop;
      pre.scrollLeft = area.scrollLeft;
    });
    tabIndent(area);
  }
}
