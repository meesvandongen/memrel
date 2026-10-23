/**
 * The runtime model built from a config: one {@link Table} per collection, with its refs, the
 * refs pointing at it, and its mutable index state. The config is validated here, once, when
 * the database is created.
 */

import { MemrelError } from './errors.ts';
import type { Action } from './types.ts';

/** A stored row with its insertion sequence number, which `update` keeps. */
export interface Entry {
  readonly row: Record<string, unknown>;
  readonly seq: number;
}

/** All mutable state of one collection. Rows are never mutated, only replaced. */
export interface TableState {
  /** Primary index: encoded primary key → entry. */
  rows: Map<string, Entry>;
  /** One per unique key: encoded values → encoded primary key. */
  uniques: Map<string, string>[];
  /** One per declared index: encoded values → encoded primary keys. */
  indexes: Map<string, Set<string>>[];
  /** One per outgoing ref: encoded referenced values → encoded primary keys of children. */
  reverse: Map<string, Set<string>>[];
  /** Next insertion sequence number. */
  seq: number;
}

export interface UniqueKey {
  readonly fields: readonly string[];
  readonly index: number;
}

export interface SecondaryIndex {
  readonly fields: readonly string[];
  readonly index: number;
}

export interface Ref {
  /** Ref name, unique within its collection. */
  readonly name: string;
  /** `collection.ref`, for messages. */
  readonly id: string;
  /** Position in `from.refs` and `from.state.reverse`. */
  readonly index: number;
  readonly from: Table;
  readonly to: Table;
  readonly fields: readonly string[];
  readonly references: readonly string[];
  /** The target's unique key this ref points at, or `null` for its primary key. */
  readonly targetUnique: UniqueKey | null;
  readonly onDelete: Action;
  readonly onUpdate: Action;
  /** Fields cleared by `setNull`. When these are all null, the row references nothing. */
  readonly nullFields: readonly string[];
  readonly inverse: string | undefined;
  /** Whether the inverse yields at most one row (the foreign key is a key of the child). */
  readonly inverseSingle: boolean;
}

export interface Table {
  readonly name: string;
  readonly key: readonly string[];
  readonly uniques: UniqueKey[];
  readonly indexes: SecondaryIndex[];
  readonly refs: Ref[];
  readonly refsByName: Map<string, Ref>;
  /** Refs of any collection that point at this one. */
  readonly incoming: Ref[];
  /** Inverse relation name → the ref it reverses. */
  readonly inverses: Map<string, Ref>;
  state: TableState;
}

const ACTIONS: readonly Action[] = ['cascade', 'restrict', 'setNull'];
const COLLECTION_OPTIONS = new Set(['key', 'unique', 'indexes', 'refs']);
const REF_OPTIONS = new Set([
  'fields',
  'to',
  'references',
  'onDelete',
  'onUpdate',
  'setNullFields',
  'inverse',
]);

/** Names used by database-wide methods, which collections can't take. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'load',
  'remove',
  'transaction',
  'snapshot',
  'restore',
]);

function fail(message: string): never {
  throw new MemrelError('INVALID_SCHEMA', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where} must be a non-empty array of field names`);
  }
  for (const f of value) {
    if (typeof f !== 'string') fail(`${where} must only contain field names`);
  }
  if (new Set(value).size !== value.length) fail(`${where} contains a field twice`);
  return [...value];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f) => b.includes(f));
}

/** Creates empty state for a table. */
export function emptyState(table: Table): TableState {
  return {
    rows: new Map(),
    uniques: table.uniques.map(() => new Map()),
    indexes: table.indexes.map(() => new Map()),
    reverse: table.refs.map(() => new Map()),
    seq: 0,
  };
}

/** Validates a config and builds the runtime model. */
export function buildModel(config: unknown): Map<string, Table> {
  if (!isRecord(config)) fail('config must be an object of collections');
  const tables = new Map<string, Table>();

  for (const [name, raw] of Object.entries(config)) {
    if (RESERVED_NAMES.has(name)) fail(`'${name}' is reserved and can't be a collection name`);
    if (!isRecord(raw)) fail(`${name}: config must be an object`);
    for (const option of Object.keys(raw)) {
      if (!COLLECTION_OPTIONS.has(option)) fail(`${name}: unknown option '${option}'`);
    }
    const key = fieldList(raw.key, `${name}.key`);
    const lists = (value: unknown, label: string): string[][] => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) fail(`${name}.${label} must be an array of field lists`);
      return value.map((v, i) => fieldList(v, `${name}.${label}[${i}]`));
    };
    tables.set(name, {
      name,
      key,
      uniques: lists(raw.unique, 'unique').map((fields, index) => ({ fields, index })),
      indexes: lists(raw.indexes, 'indexes').map((fields, index) => ({ fields, index })),
      refs: [],
      refsByName: new Map(),
      incoming: [],
      inverses: new Map(),
      state: undefined as unknown as TableState,
    });
  }

  for (const [name, raw] of Object.entries(config as Record<string, Record<string, unknown>>)) {
    const from = tables.get(name)!;
    if (raw.refs === undefined) continue;
    if (!isRecord(raw.refs)) fail(`${name}.refs must be an object of refs`);

    for (const [refName, r] of Object.entries(raw.refs)) {
      const id = `${name}.${refName}`;
      if (!isRecord(r)) fail(`${id}: ref must be an object`);
      for (const option of Object.keys(r)) {
        if (!REF_OPTIONS.has(option)) fail(`${id}: unknown option '${option}'`);
      }
      const fields = fieldList(r.fields, `${id}.fields`);
      const to = typeof r.to === 'string' ? tables.get(r.to) : undefined;
      if (!to) fail(`${id}.to must name a collection`);

      let references: string[];
      if (r.references === undefined) {
        if (fields.length !== 1 || to.key.length !== 1) {
          fail(`${id}: composite foreign keys need explicit 'references'`);
        }
        references = [...to.key];
      } else {
        references = fieldList(r.references, `${id}.references`);
      }
      if (references.length !== fields.length) {
        fail(`${id}: 'fields' and 'references' must have the same length`);
      }

      let targetUnique: UniqueKey | null = null;
      if (!sameList(references, to.key)) {
        targetUnique = to.uniques.find((u) => sameList(u.fields, references)) ?? null;
        if (!targetUnique) {
          fail(`${id}: 'references' must be the key or a unique key of '${to.name}', in order`);
        }
      }

      const onDelete = r.onDelete as Action;
      if (!ACTIONS.includes(onDelete)) fail(`${id}.onDelete must be one of ${ACTIONS.join(', ')}`);
      const onUpdate = (r.onUpdate ?? 'restrict') as Action;
      if (!ACTIONS.includes(onUpdate)) fail(`${id}.onUpdate must be one of ${ACTIONS.join(', ')}`);

      const nullFields =
        r.setNullFields === undefined ? fields : fieldList(r.setNullFields, `${id}.setNullFields`);
      if (!nullFields.every((f) => fields.includes(f))) {
        fail(`${id}: 'setNullFields' must be a subset of 'fields'`);
      }

      if (r.inverse !== undefined && typeof r.inverse !== 'string') {
        fail(`${id}.inverse must be a string`);
      }

      const ref: Ref = {
        name: refName,
        id,
        index: from.refs.length,
        from,
        to,
        fields,
        references,
        targetUnique,
        onDelete,
        onUpdate,
        nullFields,
        inverse: r.inverse,
        inverseSingle:
          sameSet(fields, from.key) || from.uniques.some((u) => sameSet(u.fields, fields)),
      };
      from.refs.push(ref);
      from.refsByName.set(refName, ref);
      to.incoming.push(ref);
    }
  }

  for (const table of tables.values()) {
    for (const ref of table.refs) {
      if (ref.inverse === undefined) continue;
      const target = ref.to;
      if (target.refsByName.has(ref.inverse) || target.inverses.has(ref.inverse)) {
        fail(`${ref.id}: inverse '${ref.inverse}' is already a relation of '${target.name}'`);
      }
      target.inverses.set(ref.inverse, ref);
    }

    // A setNull rule must not clear a column another foreign key shares.
    for (const ref of table.refs) {
      if (ref.onDelete !== 'setNull' && ref.onUpdate !== 'setNull') continue;
      for (const other of table.refs) {
        if (other !== ref && other.fields.some((f) => ref.nullFields.includes(f))) {
          fail(
            `${ref.id}: setNull would clear a column ${other.id} shares; ` +
              `use 'setNullFields' to clear only the others`,
          );
        }
      }
    }

    table.state = emptyState(table);
  }

  return tables;
}
