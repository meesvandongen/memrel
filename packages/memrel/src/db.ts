import { MemrelError } from './errors.ts';
import type { Table } from './model.ts';
import { Store } from './store.ts';
import type { CheckConfig, Db, DbConfig, InsertOptions } from './types.ts';

type Row = Record<string, unknown>;

function conflictMode(options: InsertOptions | undefined) {
  const mode = options?.onConflict ?? 'throw';
  if (mode !== 'throw' && mode !== 'ignore' && mode !== 'replace') {
    throw new MemrelError('INVALID_ARGUMENT', `Unknown onConflict mode '${String(mode)}'`);
  }
  return mode;
}

class CollectionApi {
  readonly #store: Store;
  readonly #table: Table;

  constructor(store: Store, table: Table) {
    this.#store = store;
    this.#table = table;
  }

  get(key: object) {
    return this.#store.get(this.#table, key);
  }

  where(conditions: Row) {
    return this.#store.where(this.#table, conditions);
  }

  rel(row: Row, name: string) {
    return this.#store.rel(this.#table, row, name);
  }

  insert(rows: Row | readonly Row[], options?: InsertOptions) {
    return this.#store.insert(this.#table, rows, conflictMode(options));
  }

  update(keys: object | readonly object[], patch: Row | ((row: Row) => Row)) {
    return this.#store.update(this.#table, keys, patch);
  }

  delete(keys: object | readonly object[]) {
    const list: readonly object[] = Array.isArray(keys) ? keys : [keys];
    return this.#store.delete(list.map((key) => [this.#table, key]));
  }
}

/**
 * Creates a database. The double call is deliberate: the first call fixes the row types, the
 * second infers the exact config, which TypeScript can't do in one call.
 *
 * @example
 * ```ts
 * const db = createDb<{ user: User; post: Post }>()({
 *   user: { key: ['id'], unique: [['email']] },
 *   post: {
 *     key: ['id'],
 *     refs: {
 *       author: { fields: ['authorId'], to: 'user', onDelete: 'cascade', inverse: 'posts' },
 *     },
 *   },
 * });
 * ```
 */
export function createDb<S extends { [N in keyof S]: object }>(): DefineDb<S> {
  return defineDb as DefineDb<S>;
}

/** The second step of {@link createDb}: takes the config and returns the database. */
export type DefineDb<S> = <const C extends DbConfig<S>>(config: C & CheckConfig<S, C>) => Db<S, C>;

function defineDb(config: unknown): unknown {
  const store = new Store(config);
  const db: Record<string, unknown> = {
    load(data: Record<string, readonly Row[] | undefined>, options?: InsertOptions) {
      store.load(data, conflictMode(options));
    },
    remove(keys: Record<string, readonly object[] | undefined>) {
      const roots: [Table, object][] = [];
      for (const [name, list] of Object.entries(keys)) {
        const table = store.table(name);
        for (const key of list ?? []) roots.push([table, key]);
      }
      return store.delete(roots);
    },
    transaction<T>(fn: () => T): T {
      return store.savepoint(fn);
    },
    snapshot() {
      return store.snapshot();
    },
    restore(snapshot: ReturnType<Store['snapshot']>) {
      store.restore(snapshot);
    },
  };
  for (const table of store.tables.values()) {
    db[table.name] = new CollectionApi(store, table);
  }
  return db;
}
