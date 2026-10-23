/**
 * The engine: storage, index maintenance, reads, writes, the undo log and snapshots.
 *
 * Every write runs inside a savepoint of the undo log. Each primitive change (store a row,
 * remove a row, add to or remove from an index) appends its inverse, so a write that throws
 * midway is rolled back and the store is unchanged. Integrity checks run at the end of each
 * write against the final state, which is what lets a batch reference rows later in the same
 * batch, and a delete remove a row together with the rows `restrict`-ing it.
 */

import { displayKey, encodeFields, encodeValue } from './encode.ts';
import { MemrelError } from './errors.ts';
import { buildModel, type Entry, type Ref, type Table, type TableState } from './model.ts';
import type { OnConflict } from './types.ts';

type Row = Record<string, unknown>;
type Undo = () => void;

export interface DeleteOutcome {
  deleted: Record<string, Row[]>;
  nulled: Record<string, Row[]>;
}

/** State of one write: what to check once it is complete. */
interface Op {
  /** Rows this write stored, by table and primary key. Their refs are checked at the end. */
  readonly touched: [Table, string][];
  /** Referenced values that disappeared while `restrict` children still pointed at them. */
  readonly vacated: Vacated[];
}

interface Vacated {
  readonly ref: Ref;
  readonly value: string;
  readonly verb: 'delete' | 'update';
  readonly row: Row;
}

/** A way to find rows by the values of some fields: a primary, unique, reverse or secondary index. */
interface AccessPath {
  readonly fields: readonly string[];
  /** Unique and reverse indexes leave out rows with nulls, so they can't answer null conditions. */
  readonly skipsNulls: boolean;
  lookup(state: TableState, key: string): string | ReadonlySet<string> | undefined;
}

interface Condition {
  readonly field: string;
  readonly encoded: readonly string[];
  readonly set: ReadonlySet<string>;
  readonly hasNull: boolean;
}

const MAX_CASCADE_DEPTH = 1000;

interface SnapshotData {
  readonly store: Store;
  readonly states: ReadonlyMap<Table, TableState>;
}

function bySeq(a: Entry, b: Entry): number {
  return a.seq - b.seq;
}

/** Sorts entries into insertion order, skipping the sort when they already are. */
function inOrder(entries: Entry[]): Entry[] {
  for (let i = 1; i < entries.length; i++) {
    if (entries[i - 1]!.seq > entries[i]!.seq) return entries.sort(bySeq);
  }
  return entries;
}

function isInCondition(value: unknown): value is { in: readonly unknown[] } {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'in' && Array.isArray((value as { in: unknown }).in);
}

/** Every combination of one encoded value per field, encoded as a tuple. */
function combine(parts: readonly (readonly string[])[]): string[] {
  if (parts.length === 1) return [...parts[0]!];
  let out: string[][] = [[]];
  for (const part of parts) {
    const next: string[][] = [];
    for (const prefix of out) for (const v of part) next.push([...prefix, v]);
    out = next;
  }
  return out.map((tuple) => `[${tuple.map((v) => JSON.stringify(v)).join(',')}]`);
}

function cloneBuckets(map: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [k, s] of map) out.set(k, new Set(s));
  return out;
}

function cloneState(state: TableState): TableState {
  return {
    rows: new Map(state.rows),
    uniques: state.uniques.map((m) => new Map(m)),
    indexes: state.indexes.map(cloneBuckets),
    reverse: state.reverse.map(cloneBuckets),
    seq: state.seq,
  };
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function push(target: Record<string, Row[]>, name: string, row: Row): void {
  const list = target[name];
  if (list) list.push(row);
  else target[name] = [row];
}

export class Store {
  readonly tables: Map<string, Table>;
  private readonly paths = new Map<Table, AccessPath[]>();
  private journal: Undo[] | null = null;

  constructor(config: unknown) {
    this.tables = buildModel(config);
    for (const table of this.tables.values()) {
      const paths: AccessPath[] = [
        { fields: table.key, skipsNulls: false, lookup: (s, k) => (s.rows.has(k) ? k : undefined) },
      ];
      for (const u of table.uniques) {
        paths.push({
          fields: u.fields,
          skipsNulls: true,
          lookup: (s, k) => s.uniques[u.index]!.get(k),
        });
      }
      for (const ref of table.refs) {
        paths.push({
          fields: ref.fields,
          skipsNulls: true,
          lookup: (s, k) => s.reverse[ref.index]!.get(k),
        });
      }
      for (const idx of table.indexes) {
        paths.push({
          fields: idx.fields,
          skipsNulls: false,
          lookup: (s, k) => s.indexes[idx.index]!.get(k),
        });
      }
      this.paths.set(table, paths);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Undo log
  // -------------------------------------------------------------------------------------------

  /** Runs `fn`; if it throws, undoes everything it changed. Nests. */
  savepoint<T>(fn: () => T): T {
    const outer = this.journal;
    const journal = outer ?? [];
    const mark = journal.length;
    this.journal = journal;
    try {
      const result = fn();
      if (
        typeof result === 'object' &&
        result !== null &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        throw new MemrelError('INVALID_ARGUMENT', 'Transaction callbacks must be synchronous');
      }
      return result;
    } catch (error) {
      while (journal.length > mark) journal.pop()!();
      throw error;
    } finally {
      this.journal = outer;
    }
  }

  private log(undo: Undo): void {
    this.journal?.push(undo);
  }

  private mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (map.has(key)) {
      const prev = map.get(key) as V;
      this.log(() => map.set(key, prev));
    } else {
      this.log(() => map.delete(key));
    }
    map.set(key, value);
  }

  private mapDelete<K, V>(map: Map<K, V>, key: K): void {
    if (!map.has(key)) return;
    const prev = map.get(key) as V;
    map.delete(key);
    this.log(() => map.set(key, prev));
  }

  private bucketAdd(map: Map<string, Set<string>>, key: string, member: string): void {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new Set();
      this.mapSet(map, key, bucket);
    }
    if (bucket.has(member)) return;
    bucket.add(member);
    const b = bucket;
    this.log(() => b.delete(member));
  }

  private bucketDelete(map: Map<string, Set<string>>, key: string, member: string): void {
    const bucket = map.get(key);
    if (!bucket?.delete(member)) return;
    this.log(() => bucket.add(member));
    if (bucket.size === 0) this.mapDelete(map, key);
  }

  /** Runs one write: rolled back as a whole, and checked once complete. */
  private write<T>(fn: (op: Op) => T): T {
    return this.savepoint(() => {
      const op: Op = { touched: [], vacated: [] };
      const result = fn(op);
      this.verify(op);
      return result;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Keys and references
  // -------------------------------------------------------------------------------------------

  /**
   * The encoded foreign key of `row` for `ref`: `null` when it references nothing (all of the
   * ref's null fields are null), `undefined` when it is partly null, which is an error.
   */
  private foreignKey(ref: Ref, row: Row): string | null | undefined {
    if (ref.nullFields.every((f) => isNullish(row[f]))) return null;
    if (ref.fields.some((f) => isNullish(row[f]))) return undefined;
    return encodeFields(row, ref.fields);
  }

  /** The encoded values of `row` that `ref` points at, or `null` when they aren't indexed. */
  private referencedValue(ref: Ref, row: Row): string | null {
    if (ref.targetUnique && ref.references.some((f) => isNullish(row[f]))) return null;
    return encodeFields(row, ref.references);
  }

  private findTarget(ref: Ref, value: string): Entry | undefined {
    const state = ref.to.state;
    if (!ref.targetUnique) return state.rows.get(value);
    const pk = state.uniques[ref.targetUnique.index]!.get(value);
    return pk === undefined ? undefined : state.rows.get(pk);
  }

  private describe(table: Table, row: Row): string {
    return `${table.name} ${displayKey(row, table.key)}`;
  }

  private verify(op: Op): void {
    for (const v of op.vacated) {
      const children = v.ref.from.state.reverse[v.ref.index]!.get(v.value);
      if (!children || children.size === 0 || this.findTarget(v.ref, v.value)) continue;
      const n = children.size;
      throw new MemrelError(
        'RESTRICT_VIOLATION',
        `Cannot ${v.verb} ${this.describe(v.ref.to, v.row)}: restricted by ${n} ${
          n === 1 ? 'row' : 'rows'
        } in ${v.ref.id}`,
      );
    }
    for (const [table, pk] of op.touched) {
      const entry = table.state.rows.get(pk);
      if (entry) this.checkRefs(table, entry.row);
    }
  }

  private checkRefs(table: Table, row: Row): void {
    for (const ref of table.refs) {
      const fk = this.foreignKey(ref, row);
      if (fk === null) continue;
      if (fk === undefined) {
        throw new MemrelError(
          'FOREIGN_KEY_VIOLATION',
          `${this.describe(table, row)}: foreign key ${ref.id} ${displayKey(row, ref.fields)} is partly null`,
        );
      }
      if (!this.findTarget(ref, fk)) {
        throw new MemrelError(
          'FOREIGN_KEY_VIOLATION',
          `${this.describe(table, row)}: ${ref.id} references missing ${ref.to.name} ${displayKey(
            row,
            ref.fields,
          )}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Index maintenance
  // -------------------------------------------------------------------------------------------

  private uniqueValue(row: Row, fields: readonly string[]): string | null {
    return fields.some((f) => isNullish(row[f])) ? null : encodeFields(row, fields);
  }

  private addRow(op: Op, table: Table, pk: string, row: Row, seq: number): void {
    const s = table.state;
    for (const u of table.uniques) {
      const value = this.uniqueValue(row, u.fields);
      if (value === null) continue;
      const map = s.uniques[u.index]!;
      const holder = map.get(value);
      if (holder !== undefined && holder !== pk) {
        throw new MemrelError(
          'UNIQUE_VIOLATION',
          `${this.describe(table, row)}: unique key (${u.fields.join(', ')}) ${displayKey(
            row,
            u.fields,
          )} is already taken by ${this.describe(table, s.rows.get(holder)!.row)}`,
        );
      }
      this.mapSet(map, value, pk);
    }
    for (const idx of table.indexes) {
      this.bucketAdd(s.indexes[idx.index]!, encodeFields(row, idx.fields), pk);
    }
    for (const ref of table.refs) {
      const fk = this.foreignKey(ref, row);
      if (typeof fk === 'string') this.bucketAdd(s.reverse[ref.index]!, fk, pk);
    }
    this.mapSet(s.rows, pk, { row, seq });
    op.touched.push([table, pk]);
  }

  private removeRow(table: Table, pk: string, row: Row): void {
    const s = table.state;
    for (const u of table.uniques) {
      const value = this.uniqueValue(row, u.fields);
      if (value !== null && s.uniques[u.index]!.get(value) === pk) {
        this.mapDelete(s.uniques[u.index]!, value);
      }
    }
    for (const idx of table.indexes) {
      this.bucketDelete(s.indexes[idx.index]!, encodeFields(row, idx.fields), pk);
    }
    for (const ref of table.refs) {
      const fk = this.foreignKey(ref, row);
      if (typeof fk === 'string') this.bucketDelete(s.reverse[ref.index]!, fk, pk);
    }
    this.mapDelete(s.rows, pk);
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  get(table: Table, key: object): Row | undefined {
    return table.state.rows.get(encodeFields(key, table.key))?.row;
  }

  where(table: Table, conditions: Row): Row[] {
    const state = table.state;
    const conds = new Map<string, Condition>();
    for (const field of Object.keys(conditions)) {
      const raw = conditions[field];
      if (raw === undefined) continue;
      const values = isInCondition(raw) ? raw.in : [raw];
      const encoded = [...new Set(values.map(encodeValue))];
      conds.set(field, { field, encoded, set: new Set(encoded), hasNull: values.some(isNullish) });
    }
    if (conds.size === 0) return inOrder([...state.rows.values()]).map((e) => e.row);

    let best: { path: AccessPath; keys: string[]; size: number } | undefined;
    for (const path of this.paths.get(table)!) {
      const parts: (readonly string[])[] = [];
      for (const f of path.fields) {
        const c = conds.get(f);
        if (!c || (path.skipsNulls && c.hasNull)) break;
        parts.push(c.encoded);
      }
      if (parts.length !== path.fields.length) continue;
      const keys = combine(parts);
      let size = 0;
      for (const k of keys) {
        const hit = path.lookup(state, k);
        if (hit !== undefined) size += typeof hit === 'string' ? 1 : hit.size;
      }
      if (!best || size < best.size) best = { path, keys, size };
      if (size === 0) return [];
    }

    let candidates: Iterable<Entry>;
    if (best) {
      const found: Entry[] = [];
      for (const k of best.keys) {
        const hit = best.path.lookup(state, k);
        if (hit === undefined) continue;
        if (typeof hit === 'string') found.push(state.rows.get(hit)!);
        else for (const pk of hit) found.push(state.rows.get(pk)!);
      }
      candidates = found;
    } else {
      candidates = state.rows.values();
    }

    const checks = [...conds.values()];
    const out: Entry[] = [];
    for (const entry of candidates) {
      if (checks.every((c) => c.set.has(encodeValue(entry.row[c.field])))) out.push(entry);
    }
    return inOrder(out).map((e) => e.row);
  }

  rel(table: Table, input: Row, name: string): unknown {
    const resolve = (fields: readonly string[]): Row | undefined => {
      if (fields.every((f) => f in input)) return input;
      return table.state.rows.get(encodeFields(input, table.key))?.row;
    };

    const ref = table.refsByName.get(name);
    if (ref) {
      const row = resolve(ref.fields);
      if (!row) {
        throw new MemrelError(
          'NOT_FOUND',
          `${table.name} ${displayKey(input, table.key)} not found`,
        );
      }
      const fk = this.foreignKey(ref, row);
      if (fk === null) return null;
      const target = fk === undefined ? undefined : this.findTarget(ref, fk);
      if (!target) {
        throw new MemrelError(
          'FOREIGN_KEY_VIOLATION',
          `${this.describe(table, row)}: ${ref.id} references missing ${ref.to.name} ${displayKey(
            row,
            ref.fields,
          )}`,
        );
      }
      return target.row;
    }

    const inverse = table.inverses.get(name);
    if (inverse) {
      const row = resolve(inverse.references);
      const value = row ? this.referencedValue(inverse, row) : null;
      const child = inverse.from;
      const bucket = value === null ? undefined : child.state.reverse[inverse.index]!.get(value);
      if (inverse.inverseSingle) {
        if (!bucket) return undefined;
        for (const pk of bucket) return child.state.rows.get(pk)!.row;
        return undefined;
      }
      if (!bucket) return [];
      const entries: Entry[] = [];
      for (const pk of bucket) entries.push(child.state.rows.get(pk)!);
      return inOrder(entries).map((e) => e.row);
    }

    const names = [...table.refsByName.keys(), ...table.inverses.keys()];
    throw new MemrelError(
      'INVALID_ARGUMENT',
      `'${name}' is not a relation of ${table.name}${
        names.length ? `; expected one of: ${names.join(', ')}` : ''
      }`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Insert
  // -------------------------------------------------------------------------------------------

  private insertRow(op: Op, table: Table, input: Row, mode: OnConflict): string {
    const row = { ...input };
    const pk = encodeFields(row, table.key);
    const existing = table.state.rows.get(pk);
    if (!existing) {
      this.addRow(op, table, pk, row, table.state.seq++);
    } else if (mode === 'replace') {
      this.updateRows(op, table, [[pk, row]], 0);
    } else if (mode === 'throw') {
      throw new MemrelError('DUPLICATE_KEY', `${this.describe(table, row)} already exists`);
    }
    return pk;
  }

  insert(table: Table, input: Row | readonly Row[], mode: OnConflict): Row | Row[] {
    return this.write((op) => {
      if (!Array.isArray(input)) {
        const pk = this.insertRow(op, table, input as Row, mode);
        return () => table.state.rows.get(pk)!.row;
      }
      const pks = input.map((row) => this.insertRow(op, table, row, mode));
      return () => pks.map((pk) => table.state.rows.get(pk)!.row);
    })();
  }

  load(data: Record<string, readonly Row[] | undefined>, mode: OnConflict): void {
    this.write((op) => {
      for (const [name, rows] of Object.entries(data)) {
        if (rows === undefined) continue;
        const table = this.table(name);
        for (const row of rows) this.insertRow(op, table, row, mode);
      }
    });
  }

  table(name: string): Table {
    const table = this.tables.get(name);
    if (!table) throw new MemrelError('INVALID_ARGUMENT', `'${name}' is not a collection`);
    return table;
  }

  // -------------------------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------------------------

  update(
    table: Table,
    keys: object | readonly object[],
    patch: Row | ((row: Row) => Row),
  ): Row | Row[] {
    return this.write((op) => {
      const many = Array.isArray(keys);
      const list: readonly object[] = many ? keys : [keys];
      const changes = new Map<string, Row>();
      const pks = list.map((key) => {
        const pk = encodeFields(key, table.key);
        const entry = table.state.rows.get(pk);
        if (!entry) {
          throw new MemrelError(
            'NOT_FOUND',
            `${table.name} ${displayKey(key, table.key)} not found`,
          );
        }
        if (!changes.has(pk)) {
          const p = typeof patch === 'function' ? patch(entry.row) : patch;
          changes.set(pk, { ...entry.row, ...p });
        }
        return pk;
      });
      const newPks = this.updateRows(op, table, [...changes], 0);
      const moved = new Map([...changes.keys()].map((pk, i) => [pk, newPks[i]!]));
      return () => {
        const rows = pks.map((pk) => table.state.rows.get(moved.get(pk)!)!.row);
        return many ? rows : rows[0]!;
      };
    })();
  }

  /**
   * Replaces rows and applies the `onUpdate` rules of refs pointing at changed values. All old
   * rows leave the indexes before the new ones enter, so rows in one call may swap keys.
   * Returns the new primary keys, in order.
   */
  private updateRows(op: Op, table: Table, changes: [string, Row][], depth: number): string[] {
    if (depth > MAX_CASCADE_DEPTH) {
      throw new MemrelError('INVALID_ARGUMENT', `Cascade through ${table.name} doesn't terminate`);
    }
    const s = table.state;
    const olds = changes.map(([pk]) => s.rows.get(pk)!);
    for (let i = 0; i < changes.length; i++) this.removeRow(table, changes[i]![0], olds[i]!.row);

    const newPks = changes.map(([, row], i) => {
      const pk = encodeFields(row, table.key);
      if (s.rows.has(pk)) {
        throw new MemrelError(
          'DUPLICATE_KEY',
          `Cannot update ${this.describe(table, olds[i]!.row)}: ${this.describe(table, row)} already exists`,
        );
      }
      this.addRow(op, table, pk, row, olds[i]!.seq);
      return pk;
    });

    for (const ref of table.incoming) {
      const child = ref.from;
      const childChanges = new Map<string, Row>();
      for (let i = 0; i < changes.length; i++) {
        const row = changes[i]![1];
        const oldRow = olds[i]!.row;
        const before = this.referencedValue(ref, oldRow);
        if (before === null || before === this.referencedValue(ref, row)) continue;
        const bucket = child.state.reverse[ref.index]!.get(before);
        if (!bucket || bucket.size === 0) continue;

        if (ref.onUpdate === 'restrict') {
          op.vacated.push({ ref, value: before, verb: 'update', row: oldRow });
          continue;
        }
        for (const childPk of bucket) {
          const next = { ...(childChanges.get(childPk) ?? child.state.rows.get(childPk)!.row) };
          if (ref.onUpdate === 'cascade') {
            for (let j = 0; j < ref.fields.length; j++) {
              next[ref.fields[j]!] = row[ref.references[j]!];
            }
          } else {
            for (const f of ref.nullFields) next[f] = null;
          }
          childChanges.set(childPk, next);
        }
      }
      if (childChanges.size > 0) this.updateRows(op, child, [...childChanges], depth + 1);
    }

    return newPks;
  }

  // -------------------------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------------------------

  delete(roots: [Table, object][]): DeleteOutcome {
    return this.write((op) => {
      // Plan: the rows to delete, in visiting order, and the set-null updates.
      const plan = new Map<Table, Map<string, Row>>();
      const queue: [Table, Row][] = [];
      const planned = (table: Table): Map<string, Row> => {
        let rows = plan.get(table);
        if (!rows) {
          rows = new Map();
          plan.set(table, rows);
        }
        return rows;
      };

      for (const [table, key] of roots) {
        const pk = encodeFields(key, table.key);
        const entry = table.state.rows.get(pk);
        if (!entry) {
          throw new MemrelError(
            'NOT_FOUND',
            `${table.name} ${displayKey(key, table.key)} not found`,
          );
        }
        const rows = planned(table);
        if (rows.has(pk)) continue;
        rows.set(pk, entry.row);
        queue.push([table, entry.row]);
      }

      const nulls = new Map<Table, Map<string, Ref[]>>();
      for (let i = 0; i < queue.length; i++) {
        const [table, row] = queue[i]!;
        for (const ref of table.incoming) {
          const value = this.referencedValue(ref, row);
          if (value === null) continue;
          const child = ref.from;
          const bucket = child.state.reverse[ref.index]!.get(value);
          if (!bucket || bucket.size === 0) continue;

          if (ref.onDelete === 'restrict') {
            op.vacated.push({ ref, value, verb: 'delete', row });
          } else if (ref.onDelete === 'cascade') {
            const rows = planned(child);
            for (const childPk of bucket) {
              if (rows.has(childPk)) continue;
              const childRow = child.state.rows.get(childPk)!.row;
              rows.set(childPk, childRow);
              queue.push([child, childRow]);
            }
          } else {
            let byPk = nulls.get(child);
            if (!byPk) {
              byPk = new Map();
              nulls.set(child, byPk);
            }
            for (const childPk of bucket) {
              const refs = byPk.get(childPk);
              if (refs) refs.push(ref);
              else byPk.set(childPk, [ref]);
            }
          }
        }
      }

      // Execute.
      const outcome: DeleteOutcome = { deleted: {}, nulled: {} };
      for (const [table, rows] of plan) {
        for (const [pk, row] of rows) {
          this.removeRow(table, pk, row);
          push(outcome.deleted, table.name, row);
        }
      }
      const nulled: [Table, string[]][] = [];
      for (const [table, byPk] of nulls) {
        const changes: [string, Row][] = [];
        for (const [pk, refs] of byPk) {
          const entry = table.state.rows.get(pk);
          if (!entry) continue; // deleted by the plan after all
          const next = { ...entry.row };
          for (const ref of refs) for (const f of ref.nullFields) next[f] = null;
          changes.push([pk, next]);
        }
        if (changes.length > 0) nulled.push([table, this.updateRows(op, table, changes, 0)]);
      }
      return () => {
        for (const [table, pks] of nulled) {
          for (const pk of pks) {
            const entry = table.state.rows.get(pk);
            if (entry) push(outcome.nulled, table.name, entry.row);
          }
        }
        return outcome;
      };
    })();
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------------------------

  snapshot(): SnapshotData {
    const states = new Map<Table, TableState>();
    for (const table of this.tables.values()) states.set(table, cloneState(table.state));
    return { store: this, states };
  }

  restore(snapshot: SnapshotData): void {
    if (snapshot?.store !== this) {
      throw new MemrelError('INVALID_ARGUMENT', 'Snapshot was not taken from this database');
    }
    this.savepoint(() => {
      for (const table of this.tables.values()) {
        const prev = table.state;
        table.state = cloneState(snapshot.states.get(table)!);
        this.log(() => {
          table.state = prev;
        });
      }
    });
  }
}
