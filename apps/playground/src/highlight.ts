/** A tiny JavaScript highlighter for the editor overlay and the output log. */

const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'return',
  'if',
  'else',
  'for',
  'of',
  'in',
  'new',
  'try',
  'catch',
  'finally',
  'throw',
  'function',
  'true',
  'false',
  'null',
  'undefined',
  'typeof',
  'await',
  'async',
]);

const TOKEN =
  /(\/\/[^\n]*)|('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\.|[^`\\])*`?)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d'"`/]+|\/)/g;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlight(code: string): string {
  let out = '';
  for (const m of code.matchAll(TOKEN)) {
    const [text, comment, string, number, word] = m;
    const html = escapeHtml(text);
    if (comment) out += `<span class="tk-comment">${html}</span>`;
    else if (string) out += `<span class="tk-string">${html}</span>`;
    else if (number) out += `<span class="tk-number">${html}</span>`;
    else if (word) {
      if (KEYWORDS.has(word)) out += `<span class="tk-keyword">${html}</span>`;
      else if (word === 'db' || word === 'log') out += `<span class="tk-db">${html}</span>`;
      else if (code[m.index + word.length] === '(') out += `<span class="tk-fn">${html}</span>`;
      else out += html;
    } else out += html;
  }
  return out;
}

/** Pretty-prints a value as highlighted, JSON-like text. */
export function formatValue(value: unknown): string {
  if (value === undefined) return '<span class="tk-keyword">undefined</span>';
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    },
    2,
  );
  if (json === undefined) return escapeHtml(typeof value === 'function' ? 'function' : 'undefined');
  return escapeHtml(json)
    .replace(/(&quot;|")((?:\\.|[^"\\])*)"(\s*:)?/g, (_m, _q, body: string, colon?: string) =>
      colon
        ? `<span class="tk-prop">${body}</span>${colon}`
        : `<span class="tk-string">"${body}"</span>`,
    )
    .replace(/\b(-?\d+(?:\.\d+)?)\b(?![^<]*<\/span>)/g, '<span class="tk-number">$1</span>')
    .replace(/\b(true|false|null)\b(?![^<]*<\/span>)/g, '<span class="tk-keyword">$1</span>');
}
