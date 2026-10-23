import { MemrelError } from '@mvd/memrel';
import { collections, rowKey, type CollectionName, type PlaygroundDb } from './db.ts';

type Row = Record<string, unknown>;
export type TableState = Map<CollectionName, Map<string, Row>>;

export interface Diff {
  added: Map<CollectionName, Set<string>>;
  /** Changed rows by key, with their previous version. */
  changed: Map<CollectionName, Map<string, Row>>;
  removed: Map<CollectionName, Map<string, Row>>;
}

export interface RunResult {
  ok: boolean;
  value?: unknown;
  error?: { name: string; code?: string; message: string };
  logs: unknown[][];
  diff: Diff;
  ms: number;
}

/** The rows of every collection by primary key. Rows are never mutated, so identity tracks changes. */
export function capture(db: PlaygroundDb): TableState {
  const state: TableState = new Map();
  for (const info of collections) {
    const rows = new Map<string, Row>();
    for (const row of (db[info.name] as { where(c: object): readonly Row[] }).where({})) {
      rows.set(rowKey(info, row), row);
    }
    state.set(info.name, rows);
  }
  return state;
}

export function diff(before: TableState, after: TableState): Diff {
  const out: Diff = { added: new Map(), changed: new Map(), removed: new Map() };
  for (const info of collections) {
    const a = before.get(info.name)!;
    const b = after.get(info.name)!;
    const added = new Set<string>();
    const changed = new Map<string, Row>();
    const removed = new Map<string, Row>();
    for (const [k, row] of b) {
      const old = a.get(k);
      if (!old) added.add(k);
      else if (old !== row) changed.set(k, old);
    }
    for (const [k, row] of a) if (!b.has(k)) removed.set(k, row);
    out.added.set(info.name, added);
    out.changed.set(info.name, changed);
    out.removed.set(info.name, removed);
  }
  return out;
}

export function countChanges(d: Diff): { added: number; changed: number; removed: number } {
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const s of d.added.values()) added += s.size;
  for (const m of d.changed.values()) changed += m.size;
  for (const m of d.removed.values()) removed += m.size;
  return { added, changed, removed };
}

function compile(code: string): (db: PlaygroundDb, log: (...args: unknown[]) => void) => unknown {
  // A lone expression returns its value, like a REPL; anything else runs as a function body.
  const expression = code.trim().replace(/;$/, '');
  try {
    // oxlint-disable-next-line typescript/no-implied-eval -- running user code is the point
    return new Function(
      'db',
      'log',
      'MemrelError',
      `"use strict";\nreturn (\n${expression}\n);`,
    ) as never;
  } catch {
    // oxlint-disable-next-line typescript/no-implied-eval -- running user code is the point
    return new Function('db', 'log', 'MemrelError', `"use strict";\n${code}`) as never;
  }
}

/** Runs user code against the database and reports what it returned and changed. */
export function run(db: PlaygroundDb, code: string): RunResult {
  const logs: unknown[][] = [];
  const before = capture(db);
  const start = performance.now();
  let result: Pick<RunResult, 'ok' | 'value' | 'error'>;
  try {
    const fn = compile(code) as (
      db: PlaygroundDb,
      log: (...args: unknown[]) => void,
      error: typeof MemrelError,
    ) => unknown;
    result = { ok: true, value: fn(db, (...args) => logs.push(args), MemrelError) };
  } catch (error) {
    result = {
      ok: false,
      error:
        error instanceof MemrelError
          ? { name: error.name, code: error.code, message: error.message }
          : error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: 'Thrown', message: String(error) },
    };
  }
  const ms = performance.now() - start;
  return { ...result, logs, diff: diff(before, capture(db)), ms };
}
