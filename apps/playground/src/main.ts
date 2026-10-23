import './style.css';
// oxlint-disable-next-line import/default -- Vite's `?raw` import of the schema source
import dbSource from './db.ts?raw';
import {
  collectionInfo,
  collections,
  createPlaygroundDb,
  rowKey,
  seed,
  type CollectionInfo,
  type CollectionName,
} from './db.ts';
import { escapeHtml, formatValue, highlight } from './highlight.ts';
import { capture, countChanges, diff, run, type Diff, type RunResult } from './runner.ts';
import { scenarios, type Scenario } from './scenarios.ts';

type Row = Record<string, unknown>;
type LooseCollection = {
  where(conditions: object): readonly Row[];
  rel(row: object, name: string): unknown;
};

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const db = createPlaygroundDb();
db.load(seed);
const seeded = db.snapshot();
const history: ReturnType<typeof db.snapshot>[] = [];
let lastDiff: Diff | undefined;
let current: Scenario | undefined = scenarios[0];

const collection = (name: CollectionName) => db[name] as unknown as LooseCollection;

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (name === 'html') el.innerHTML = String(value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

/** Display text for a cell value. */
function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? 'undefined';
}

/** A JavaScript literal for a value, as it would be written in code. */
function literal(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return cellText(value);
}

function objectLiteral(row: Row, fields: string[]): string {
  return `{ ${fields.map((f) => `${f}: ${literal(row[f])}`).join(', ')} }`;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const app = $('#app');
app.append(
  h(
    'header',
    { class: 'hero' },
    h(
      'div',
      { class: 'hero-inner' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'logo', 'aria-hidden': true, html: logoSvg() }),
        h(
          'div',
          {},
          h('h1', {}, 'memrel ', h('span', { class: 'tag' }, 'playground')),
          h(
            'p',
            { class: 'tagline' },
            'A tiny, synchronous, in-memory relational store for typed mock data. ',
            'Composite keys, foreign keys, cascades, transactions and snapshots.',
          ),
        ),
      ),
      h(
        'div',
        { class: 'hero-actions' },
        h(
          'button',
          { class: 'install', type: 'button', title: 'Copy install command' },
          h('code', {}, 'npm i -D @mvd/memrel'),
          h('span', { class: 'copy', 'aria-hidden': true }, '⧉'),
        ),
        h(
          'a',
          { class: 'button ghost', href: 'https://github.com/meesvandongen/memrel' },
          'GitHub',
        ),
        h('a', { class: 'button ghost', href: 'https://www.npmjs.com/package/@mvd/memrel' }, 'npm'),
      ),
    ),
  ),
  h(
    'nav',
    { class: 'scenario-bar', 'aria-label': 'Scenarios' },
    h(
      'div',
      { class: 'scenario-bar-inner' },
      h('h2', {}, 'Try a scenario'),
      h('div', { class: 'scenarios', id: 'scenarios' }),
    ),
  ),
  h(
    'main',
    { class: 'layout' },
    h(
      'section',
      { class: 'side' },
      h(
        'div',
        { class: 'panel editor-panel' },
        h(
          'div',
          { class: 'editor-head' },
          h('h2', { id: 'editor-title' }),
          h('p', { class: 'explain', id: 'editor-explain' }),
        ),
        h(
          'div',
          { class: 'editor' },
          h('pre', { class: 'editor-hl', 'aria-hidden': true }, h('code', { id: 'editor-hl' })),
          h('textarea', {
            id: 'editor',
            spellcheck: 'false',
            autocapitalize: 'off',
            autocomplete: 'off',
            'aria-label': 'Code to run against db',
          }),
        ),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'button primary', id: 'run', type: 'button' }, '▶ Run'),
          h(
            'span',
            { class: 'hint' },
            h('kbd', {}, '⌘'),
            '/',
            h('kbd', {}, 'Ctrl'),
            ' + ',
            h('kbd', {}, '↵'),
          ),
          h('span', { class: 'spacer' }),
          h(
            'button',
            { class: 'button ghost', id: 'undo', type: 'button', disabled: true },
            '↶ Undo',
          ),
          h('button', { class: 'button ghost', id: 'reset', type: 'button' }, '⟲ Reset data'),
        ),
        h(
          'p',
          { class: 'globals' },
          'In scope: ',
          h('code', {}, 'db'),
          ', ',
          h('code', {}, 'log(...)'),
          ' and ',
          h('code', {}, 'MemrelError'),
          '. A lone expression shows its value; otherwise use ',
          h('code', {}, 'return'),
          '.',
        ),
      ),
      h(
        'div',
        { class: 'panel output-panel' },
        h('h2', {}, 'Output'),
        h(
          'div',
          { id: 'output', class: 'output' },
          h('p', { class: 'empty' }, 'Run something to see its result and what it changed.'),
        ),
      ),
    ),
    h(
      'section',
      { class: 'data' },
      h(
        'div',
        { class: 'data-head' },
        h('h2', {}, 'Live data'),
        h(
          'div',
          { class: 'legend' },
          h('span', { class: 'swatch added' }, 'added'),
          h('span', { class: 'swatch changed' }, 'changed'),
          h('span', { class: 'swatch removed' }, 'removed'),
          h('span', { class: 'swatch related' }, 'related on hover'),
        ),
      ),
      h(
        'details',
        { class: 'schema' },
        h('summary', {}, 'View the schema code'),
        h('pre', {}, h('code', { html: highlight(schemaSource()) })),
      ),
      h('div', { id: 'tables', class: 'tables' }),
    ),
  ),
  h(
    'footer',
    {},
    'memrel is MIT licensed. This page runs entirely in your browser; ',
    h(
      'a',
      { href: 'https://github.com/meesvandongen/memrel/tree/main/apps/playground' },
      'view its source',
    ),
    '.',
  ),
);

function schemaSource(): string {
  const start = dbSource.indexOf('createDb<');
  const end = dbSource.indexOf('\n}\n', start);
  return `const db = ${dbSource
    .slice(start, end)
    .replace(/\n {2}/g, '\n')
    .trim()}`;
}

function logoSvg(): string {
  return `<svg viewBox="0 0 32 32" width="40" height="40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs><rect x="2" y="2" width="12" height="12" rx="3" fill="url(#g)"/><rect x="18" y="2" width="12" height="12" rx="3" fill="url(#g)" opacity=".55"/><rect x="18" y="18" width="12" height="12" rx="3" fill="url(#g)"/><path d="M14 8h4M24 14v4" stroke="url(#g)" stroke-width="2.5" stroke-linecap="round"/></svg>`;
}

// ---------------------------------------------------------------------------------------------
// Scenarios and editor
// ---------------------------------------------------------------------------------------------

const editor = $<HTMLTextAreaElement>('#editor');
const editorHl = $('#editor-hl');

function setCode(code: string): void {
  editor.value = code;
  syncEditor();
}

function syncEditor(): void {
  // The trailing newline keeps the overlay as tall as the textarea.
  editorHl.innerHTML = `${highlight(editor.value)}\n`;
  editor.style.height = 'auto';
  editor.style.height = `${editor.scrollHeight}px`;
}

function selectScenario(scenario: Scenario | undefined, code?: string): void {
  current = scenario;
  $('#editor-title').textContent = scenario?.title ?? 'Your code';
  $('#editor-explain').innerHTML = scenario
    ? escapeHtml(scenario.explain).replace(/`([^`]+)`/g, '<code>$1</code>')
    : 'Edit the code and run it. Changes show up in the tables.';
  for (const button of document.querySelectorAll<HTMLButtonElement>('.scenario')) {
    button.classList.toggle('active', button.dataset.id === scenario?.id);
  }
  setCode(code ?? scenario?.code ?? '');
}

function renderScenarios(): void {
  const root = $('#scenarios');
  const groups = new Map<Scenario['group'], Scenario[]>();
  for (const s of scenarios) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  for (const [group, list] of groups) {
    root.append(
      h(
        'div',
        { class: 'group' },
        h('h3', {}, group),
        ...list.map((s) => {
          const button = h(
            'button',
            { class: 'scenario', type: 'button', 'data-id': s.id },
            s.title,
          );
          button.addEventListener('click', () => {
            selectScenario(s);
            execute();
          });
          return button;
        }),
      ),
    );
  }
}

editor.addEventListener('input', () => {
  if (current && editor.value !== current.code) {
    current = undefined;
    $('#editor-title').textContent = 'Your code';
    for (const b of document.querySelectorAll('.scenario.active')) b.classList.remove('active');
  }
  syncEditor();
});

editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    execute();
  } else if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end } = editor;
    editor.setRangeText('  ', start, end, 'end');
    syncEditor();
  }
});

$('#run').addEventListener('click', () => execute());

$('#undo').addEventListener('click', () => {
  const snapshot = history.pop();
  if (!snapshot) return;
  const before = capture(db);
  db.restore(snapshot);
  lastDiff = diff(before, capture(db));
  appendSystem('↶ Undone', lastDiff);
  renderTables();
});

$('#reset').addEventListener('click', () => {
  const before = capture(db);
  db.restore(seeded);
  history.length = 0;
  lastDiff = diff(before, capture(db));
  appendSystem('⟲ Data reset to the seed', lastDiff);
  renderTables();
});

$('.install').addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  try {
    await navigator.clipboard.writeText('npm i -D @mvd/memrel');
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1200);
  } catch {
    // Clipboard access can be denied; the command is visible anyway.
  }
});

// ---------------------------------------------------------------------------------------------
// Running code
// ---------------------------------------------------------------------------------------------

function execute(code = editor.value, title = current?.title ?? 'Your code'): void {
  const snapshot = db.snapshot();
  const result = run(db, code);
  const changes = countChanges(result.diff);
  if (changes.added + changes.changed + changes.removed > 0) history.push(snapshot);
  lastDiff = result.diff;
  appendResult(title, code, result);
  renderTables();
}

function changeChips(d: Diff): HTMLElement {
  const { added, changed, removed } = countChanges(d);
  const chips = h('span', { class: 'chips' });
  if (added) chips.append(h('span', { class: 'chip added' }, `+${added}`));
  if (changed) chips.append(h('span', { class: 'chip changed' }, `~${changed}`));
  if (removed) chips.append(h('span', { class: 'chip removed' }, `−${removed}`));
  if (!added && !changed && !removed) chips.append(h('span', { class: 'chip none' }, 'no changes'));
  return chips;
}

function changeDetail(d: Diff): HTMLElement | null {
  const parts: string[] = [];
  for (const info of collections) {
    const a = d.added.get(info.name)!.size;
    const c = d.changed.get(info.name)!.size;
    const r = d.removed.get(info.name)!.size;
    const bits = [a && `+${a}`, c && `~${c}`, r && `−${r}`].filter(Boolean);
    if (bits.length) parts.push(`${info.name} ${bits.join(' ')}`);
  }
  return parts.length ? h('div', { class: 'detail' }, parts.join(' · ')) : null;
}

function appendResult(title: string, code: string, result: RunResult): void {
  const output = $('#output');
  output.querySelector('.empty')?.remove();
  const entry = h(
    'article',
    { class: `entry ${result.ok ? 'ok' : 'error'}` },
    h(
      'header',
      {},
      h('span', { class: 'status', 'aria-hidden': true }, result.ok ? '✓' : '✕'),
      h('strong', {}, title),
      changeChips(result.diff),
      h(
        'span',
        { class: 'ms' },
        `${result.ms < 1 ? result.ms.toFixed(2) : result.ms.toFixed(1)} ms`,
      ),
    ),
    changeDetail(result.diff),
    h(
      'details',
      { class: 'code' },
      h('summary', {}, 'code'),
      h('pre', {}, h('code', { html: highlight(code) })),
    ),
    ...result.logs.map((args) =>
      h(
        'pre',
        { class: 'log' },
        h('code', {
          html: args.map((a) => (typeof a === 'string' ? escapeHtml(a) : formatValue(a))).join(' '),
        }),
      ),
    ),
    result.ok
      ? result.value === undefined
        ? null
        : h('pre', { class: 'value' }, h('code', { html: formatValue(result.value) }))
      : h(
          'div',
          { class: 'error-box' },
          h('span', { class: 'error-name' }, result.error!.code ?? result.error!.name),
          h('span', {}, result.error!.message),
          result.error!.code
            ? h('p', { class: 'note' }, 'Nothing changed: every write is atomic.')
            : null,
        ),
  );
  output.prepend(entry);
  while (output.children.length > 30) output.lastElementChild!.remove();
}

function appendSystem(title: string, d: Diff): void {
  const output = $('#output');
  output.querySelector('.empty')?.remove();
  output.prepend(
    h(
      'article',
      { class: 'entry system' },
      h('header', {}, h('strong', {}, title), changeChips(d)),
    ),
  );
  ($('#undo') as HTMLButtonElement).disabled = history.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

const INSERT_TEMPLATES: Record<CollectionName, string> = {
  user: `db.user.insert({ id: 'u6', email: 'fay@acme.dev', name: 'Fay' })`,
  org: `db.org.insert({ id: 3, name: 'Initech' })`,
  orgUser: `db.orgUser.insert({ orgId: 2, userId: 'u2', role: 'member' })`,
  orgUserPermission: `db.orgUserPermission.insert({ memberOrgId: 2, memberUserId: 'u1', permission: 'deploy' })`,
  post: `db.post.insert({ id: 'p6', authorId: 'u2', reviewerId: 'u1', title: 'A new post' })`,
};

function ruleBadge(kind: 'delete' | 'update', rule: string): HTMLElement {
  return h(
    'span',
    { class: `rule rule-${rule}`, title: `on ${kind}: ${rule}` },
    `${kind}: ${rule}`,
  );
}

function renderTables(): void {
  ($('#undo') as HTMLButtonElement).disabled = history.length === 0;
  const root = $('#tables');
  root.replaceChildren(...collections.map(renderTable));
}

function fkFor(info: CollectionInfo, field: string) {
  return info.refs.find((r) => r.fields.includes(field));
}

function renderTable(info: CollectionInfo): HTMLElement {
  const rows = collection(info.name).where({});
  const added = lastDiff?.added.get(info.name);
  const changed = lastDiff?.changed.get(info.name);
  const removed = lastDiff?.removed.get(info.name);

  const insert = h('button', { class: 'button small', type: 'button' }, '+ Insert');
  insert.addEventListener('click', () => {
    selectScenario(undefined, INSERT_TEMPLATES[info.name]);
    editor.focus();
  });

  const head = h(
    'tr',
    {},
    ...info.fields.map((f) => {
      const isKey = info.key.includes(f);
      const fk = fkFor(info, f);
      const isUnique = info.unique.some((u) => u.includes(f));
      return h(
        'th',
        { title: isKey ? 'primary key' : fk ? `foreign key → ${fk.to}` : undefined },
        isKey ? h('span', { class: 'icon key', 'aria-label': 'key' }, '🔑') : null,
        fk ? h('span', { class: 'icon fk', 'aria-label': 'foreign key' }, '↗') : null,
        f,
        isUnique ? h('span', { class: 'badge' }, 'unique') : null,
      );
    }),
    h('th', { class: 'actions' }),
  );

  const body = h('tbody', {});
  for (const row of rows) {
    const k = rowKey(info, row);
    const old = changed?.get(k);
    body.append(renderRow(info, row, added?.has(k) ? 'added' : old ? 'changed' : '', old));
  }
  for (const row of removed?.values() ?? []) body.append(renderRow(info, row, 'removed'));

  return h(
    'article',
    { class: 'table-card', id: `table-${info.name}` },
    h(
      'header',
      {},
      h(
        'div',
        { class: 'title' },
        h('h3', {}, info.name),
        h('span', { class: 'count' }, `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`),
        h('span', { class: 'spacer' }),
        insert,
      ),
      h('p', { class: 'blurb' }, info.blurb),
      info.refs.length
        ? h(
            'ul',
            { class: 'refs' },
            ...info.refs.map((r) =>
              h(
                'li',
                {},
                h('code', {}, `${r.name}: (${r.fields.join(', ')}) → ${r.to}`),
                ruleBadge('delete', r.onDelete),
                ruleBadge('update', r.onUpdate),
              ),
            ),
          )
        : null,
    ),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, head), body)),
  );
}

function renderRow(info: CollectionInfo, row: Row, state: string, old?: Row): HTMLElement {
  const k = rowKey(info, row);
  const tr = h('tr', { class: state || undefined, 'data-table': info.name, 'data-key': k });

  for (const f of info.fields) {
    const value = row[f];
    const fk = fkFor(info, f);
    const cellChanged = old && old[f] !== value;
    const td = h('td', {
      class:
        [info.key.includes(f) ? 'key' : '', cellChanged ? 'cell-changed' : '']
          .filter(Boolean)
          .join(' ') || undefined,
      title: cellChanged ? `was ${literal(old![f])}` : undefined,
    });
    if (value === null) td.append(h('span', { class: 'null' }, 'null'));
    else if (fk && state !== 'removed') {
      const link = h(
        'button',
        { class: 'fk-link', type: 'button', title: `Go to ${fk.to}` },
        cellText(value),
      );
      link.addEventListener('click', () => jumpTo(info, row, fk.name));
      td.append(link);
    } else td.append(cellText(value));
    tr.append(td);
  }

  const actions = h('td', { class: 'actions' });
  if (state !== 'removed') {
    const keyCode = objectLiteral(row, info.key);
    const field = info.fields.find((f) => !info.key.includes(f) && !fkFor(info, f)) ?? info.key[0]!;
    const edit = h(
      'button',
      { class: 'icon-button', type: 'button', title: 'Update this row' },
      '✎',
    );
    edit.addEventListener('click', () => {
      selectScenario(
        undefined,
        `db.${info.name}.update(${keyCode}, { ${field}: ${literal(row[field])} })`,
      );
      editor.focus();
    });
    const del = h(
      'button',
      { class: 'icon-button danger', type: 'button', title: 'Delete this row' },
      '✕',
    );
    del.addEventListener('click', () => {
      const code = `db.${info.name}.delete(${keyCode})`;
      selectScenario(undefined, code);
      execute(code, `Delete ${info.name} ${k}`);
    });
    actions.append(edit, del);
    tr.addEventListener('mouseenter', () => showRelated(info, row, tr));
    tr.addEventListener('mouseleave', clearRelated);
  }
  tr.append(actions);
  return tr;
}

function rowElement(name: CollectionName, key: string): HTMLElement | null {
  return document.querySelector(
    `tr[data-table="${name}"][data-key="${CSS.escape(key)}"]:not(.removed)`,
  );
}

function relatedRows(info: CollectionInfo, row: Row): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const name of info.rels) {
    const result = collection(info.name).rel(row, name);
    const list = Array.isArray(result) ? result : result ? [result] : [];
    const target = info.refs.find((r) => r.name === name)?.to ?? inverseTarget(info.name, name);
    if (!target) continue;
    const targetInfo = collectionInfo.get(target)!;
    for (const r of list as Row[]) {
      const el = rowElement(target, rowKey(targetInfo, r));
      if (el) out.push(el);
    }
  }
  return out;
}

/** The child collection behind an inverse relation name. */
function inverseTarget(name: CollectionName, inverse: string): CollectionName | undefined {
  return collections.find((c) => c.refs.some((r) => r.to === name && r.inverse === inverse))?.name;
}

function showRelated(info: CollectionInfo, row: Row, tr: HTMLElement): void {
  clearRelated();
  tr.classList.add('hovered');
  for (const el of relatedRows(info, row)) el.classList.add('related');
}

function clearRelated(): void {
  for (const el of document.querySelectorAll('tr.related, tr.hovered')) {
    el.classList.remove('related', 'hovered');
  }
}

function jumpTo(info: CollectionInfo, row: Row, refName: string): void {
  const target = collection(info.name).rel(row, refName) as Row | null;
  const ref = info.refs.find((r) => r.name === refName)!;
  if (!target) return;
  const el = rowElement(ref.to, rowKey(collectionInfo.get(ref.to)!, target));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

renderScenarios();
selectScenario(current);
renderTables();
