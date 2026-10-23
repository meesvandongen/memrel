/**
 * Public types: the schema config, the compile-time checks run against it, and the typed
 * database API derived from it.
 *
 * Relation types are computed per collection rather than over the whole database at once,
 * which keeps editor performance acceptable with dozens of collections.
 */

declare const snapshotBrand: unique symbol;

/** What happens to referencing rows when the referenced row is deleted or its key changes. */
export type Action = 'cascade' | 'restrict' | 'setNull';

/** What `insert` does when a primary key is already taken. */
export type OnConflict = 'throw' | 'ignore' | 'replace';

/** Options for `insert` and `load`. */
export interface InsertOptions {
  /**
   * What to do when a row's primary key already exists:
   * `'throw'` (default), `'ignore'` (keep the existing row) or `'replace'` (PUT semantics).
   * Unique key conflicts always throw.
   */
  readonly onConflict?: OnConflict;
}

type Field<Row> = Extract<keyof Row, string>;

/** A non-empty, ordered list of fields of `Row`. */
export type FieldList<Row> = readonly [Field<Row>, ...Field<Row>[]];

/** A named outgoing reference (foreign key). */
export interface RefConfig<S, Row> {
  /** The child's foreign key fields, in order. */
  readonly fields: FieldList<Row>;
  /** Target collection name. */
  readonly to: Extract<keyof S, string>;
  /**
   * Target fields; `fields[i]` pairs with `references[i]`. Must be the target's primary key or
   * one of its `unique` keys. Required for composite foreign keys, else defaults to the target's
   * `key`.
   */
  readonly references?: readonly [string, ...string[]];
  /** What happens to referencing rows when the target is deleted. */
  readonly onDelete: Action;
  /** What happens to referencing rows when the referenced fields change. Defaults to `'restrict'`. */
  readonly onUpdate?: Action;
  /**
   * The fields `setNull` clears, a subset of `fields` (like Postgres' `SET NULL (col)`).
   * Defaults to all of `fields`. When these are all null, the row references nothing.
   */
  readonly setNullFields?: FieldList<Row>;
  /** Name of the reverse relation on the target, used by `rel`. */
  readonly inverse?: string;
}

/** Keys, unique keys, indexes and references of one collection. */
export interface CollectionConfig<S, Row> {
  /** Primary key fields, in order. */
  readonly key: FieldList<Row>;
  /** Unique keys besides the primary key. Rows with a null in a unique key aren't indexed. */
  readonly unique?: readonly FieldList<Row>[];
  /** Extra equality indexes used by `where`. Foreign keys are always indexed. */
  readonly indexes?: readonly FieldList<Row>[];
  /** Named outgoing references (foreign keys). */
  readonly refs?: { readonly [name: string]: RefConfig<S, Row> };
}

/** The runtime config for a database with row types `S`. */
export type DbConfig<S> = { readonly [N in keyof S]: CollectionConfig<S, S[N]> };

// ---------------------------------------------------------------------------------------------
// Compile-time checks
// ---------------------------------------------------------------------------------------------

type Err<Message extends string> = `memrel: ${Message}`;

/**
 * Marks an invalid config property. It is an object type rather than a string so that it
 * doesn't reduce the surrounding literal types to `never`, and the message shows up in the error.
 */
interface Invalid<Message extends string> {
  readonly 'memrel error': Message;
}

type RefOption = keyof RefConfig<unknown, unknown>;
type CollectionOption = keyof CollectionConfig<unknown, unknown>;

type Get<T, K> = K extends keyof T ? T[K] : never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Overlaps<A, B> = [A] extends [B] ? true : [B] extends [A] ? true : false;
type Unknowns<T, Known extends PropertyKey> = {
  readonly [K in Exclude<keyof T, Known>]: Invalid<Err<`unknown option '${K & string}'`>>;
};

type KeyListOf<CC> = CC extends { readonly key: infer K } ? K : never;
type UniqueListsOf<CC> = CC extends { readonly unique: readonly (infer U)[] } ? U : never;
type IsTargetKey<Refs, Lists> = true extends (Lists extends unknown ? Same<Refs, Lists> : never)
  ? true
  : false;

type PairErrors<Row, Target, F extends readonly string[], Refs extends readonly string[]> = {
  [I in keyof F]: I extends keyof Refs
    ? Overlaps<NonNullable<Get<Row, F[I]>>, NonNullable<Get<Target, Refs[I]>>> extends true
      ? never
      : Err<`'${F[I]}' and '${Refs[I] & string}' have incompatible types`>
    : never;
}[number];

type ReferencesError<
  Row,
  Target,
  TargetConfig,
  F extends readonly string[],
  Refs extends readonly string[],
> =
  IsTargetKey<Refs, KeyListOf<TargetConfig> | UniqueListsOf<TargetConfig>> extends false
    ? Err<"`references` must be the target's `key` or one of its `unique` keys">
    : Same<F['length'], Refs['length']> extends false
      ? Err<'`fields` and `references` must have the same length'>
      : PairErrors<Row, Target, F, Refs>;

type CheckReferences<
  S,
  C,
  Row,
  R,
  F extends readonly string[],
  T extends keyof S & keyof C,
> = R extends { readonly references: infer Refs extends readonly string[] }
  ? [ReferencesError<Row, S[T], C[T], F, Refs>] extends [infer E extends string]
    ? [E] extends [never]
      ? unknown
      : { readonly references: Invalid<E> }
    : unknown
  : KeyListOf<C[T]> extends infer K extends readonly string[]
    ? [F['length'], K['length']] extends [1, 1]
      ? [PairErrors<Row, S[T], F, K>] extends [never]
        ? unknown
        : { readonly fields: Invalid<PairErrors<Row, S[T], F, K>> }
      : { readonly references: Invalid<Err<'composite foreign keys need explicit `references`'>> }
    : unknown;

type NotNullable<Row, Fields> = {
  [P in Fields & keyof Row]: null extends Row[P] ? never : P;
}[Fields & keyof Row];

type SetNullError<Row, NullFields> = [NotNullable<Row, NullFields>] extends [never]
  ? never
  : Err<`setNull requires nullable fields, but '${NotNullable<Row, NullFields> & string}' is not nullable`>;

type CheckSetNull<Row, R, F extends readonly string[]> = (R extends {
  readonly setNullFields: infer X extends readonly string[];
}
  ? [Exclude<X[number], F[number]>] extends [never]
    ? unknown
    : { readonly setNullFields: Invalid<Err<'`setNullFields` must be a subset of `fields`'>> }
  : unknown) &
  ([SetNullError<Row, NullFieldsOf<R>>] extends [never]
    ? unknown
    : (R extends { readonly onDelete: 'setNull' }
        ? { readonly onDelete: Invalid<SetNullError<Row, NullFieldsOf<R>>> }
        : unknown) &
        (R extends { readonly onUpdate: 'setNull' }
          ? { readonly onUpdate: Invalid<SetNullError<Row, NullFieldsOf<R>>> }
          : unknown));

type CheckRef<S, C, Row, R> = R extends {
  readonly fields: infer F extends readonly string[];
  readonly to: infer T extends keyof S & keyof C;
}
  ? Unknowns<R, RefOption> & CheckReferences<S, C, Row, R, F, T> & CheckSetNull<Row, R, F>
  : unknown;

type CheckCollection<S, C, Row, CC> = Unknowns<CC, CollectionOption> &
  (CC extends { readonly refs: infer Refs }
    ? { readonly refs: { readonly [R in keyof Refs]: CheckRef<S, C, Row, Refs[R]> } }
    : unknown);

/**
 * Checks a config against the row types. Resolves to `unknown`-like constraints where the config
 * is fine, and to an `Invalid<'memrel: ...'>` marker on the offending property where it isn't.
 */
export type CheckConfig<S, C> = {
  readonly [N in keyof C]: N extends keyof S
    ? CheckCollection<S, C, S[N], C[N]>
    : Invalid<Err<`'${N & string}' is not a collection`>>;
};

// ---------------------------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------------------------

type RefsOf<CC> = CC extends { readonly refs: infer R } ? R : {};
type FieldsOf<R> = R extends { readonly fields: readonly (infer F)[] } ? F : never;
type NullFieldsOf<R> = R extends { readonly setNullFields: readonly (infer F)[] } ? F : FieldsOf<R>;

/** Primary key fields of a collection config, as a union. */
export type KeyFieldsOf<CC> = CC extends { readonly key: readonly (infer K)[] } ? K : never;

type NotNullish<Row, Fields> = {
  [P in Fields & keyof Row]: null extends Row[P] ? never : undefined extends Row[P] ? never : P;
}[Fields & keyof Row];
type AllNullish<Row, Fields> = [NotNullish<Row, Fields>] extends [never] ? true : false;

type ForwardResult<S, Row, R> = R extends { readonly to: infer T extends keyof S }
  ? Readonly<S[T]> | (AllNullish<Row, NullFieldsOf<R>> extends true ? null : never)
  : never;

type MatchesUnique<U, F> = U extends readonly (infer E)[] ? Same<F, E> : never;
type IsSingle<CC, F> = true extends Same<F, KeyFieldsOf<CC>> | MatchesUnique<UniqueListsOf<CC>, F>
  ? true
  : false;

type InverseResult<S, C, M, R> = M extends keyof S & keyof C
  ? IsSingle<C[M], FieldsOf<R>> extends true
    ? Readonly<S[M]> | undefined
    : readonly Readonly<S[M]>[]
  : never;

type InverseEntries<C, N> = {
  [M in keyof C]: {
    [R in keyof RefsOf<C[M]>]: RefsOf<C[M]>[R] extends {
      readonly to: N;
      readonly inverse: infer I extends string;
    }
      ? [I, M, RefsOf<C[M]>[R]]
      : never;
  }[keyof RefsOf<C[M]>];
}[keyof C];

type ForwardRels<S, Row, CC> = {
  readonly [R in keyof RefsOf<CC>]: ForwardResult<S, Row, RefsOf<CC>[R]>;
};

type InverseRels<S, C, N> = {
  readonly [E in InverseEntries<C, N> as E[0]]: InverseResult<S, C, E[1], E[2]>;
};

/** Relation names of collection `N` mapped to what `rel` returns for them. */
export type RelsOf<S, C, N extends keyof S & keyof C> = ForwardRels<S, S[N], C[N]> &
  InverseRels<S, C, N>;

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

/** Conditions for `where`: equality per field, or `{ in: [...] }`. `undefined` is ignored. */
export type Where<Row> = {
  readonly [F in keyof Row]?: Row[F] | { readonly in: readonly Row[F][] };
};

/** A patch for `update`, or a function computing one from the current row. */
export type Patch<Row> = Partial<Row> | ((row: Readonly<Row>) => Partial<Row>);

/** Rows per collection, keyed by collection name. */
export type RowsByCollection<S> = { readonly [N in keyof S]?: readonly Readonly<S[N]>[] };

/** What a delete removed, and the rows whose foreign keys were set to null. */
export interface DeleteResult<S> {
  /** The removed rows, per collection, as they were just before removal. */
  readonly deleted: RowsByCollection<S>;
  /** Rows changed by a `setNull` rule, per collection, as they are after the change. */
  readonly nulled: RowsByCollection<S>;
}

/** An opaque copy of the database state, made by `snapshot()` and applied by `restore()`. */
export interface Snapshot<S> {
  readonly [snapshotBrand]: S;
}

/** One collection of a database. */
export interface Collection<S, Row, K extends keyof Row, Rels> {
  /** Looks up a row by its complete primary key. */
  get(key: Pick<Row, K>): Readonly<Row> | undefined;

  /**
   * Equality search, plus `{ in: [...] }`. Uses the primary key, unique keys, foreign keys and
   * declared indexes when the conditions cover them, and scans otherwise. `where({})` returns
   * every row. Rows come back in insertion order.
   */
  where(conditions: Where<Row>): readonly Readonly<Row>[];

  /**
   * Traverses a relation by name. A forward ref returns the target row (or `null` when the
   * foreign key is null); an inverse returns the referencing rows, or a single row when the
   * foreign key is also the child's primary or unique key. Accepts a row or just its key.
   */
  rel<R extends keyof Rels & string>(row: Pick<Row, K>, name: R): Rels[R];

  /** Inserts a complete row and returns the stored row. */
  insert(row: Row, options?: InsertOptions): Readonly<Row>;
  /** Inserts rows as one batch. Rows in a batch may reference each other in any order. */
  insert(rows: readonly Row[], options?: InsertOptions): readonly Readonly<Row>[];

  /**
   * Patches a row by key and returns the new row. Any field may change, keys included;
   * referencing rows follow each ref's `onUpdate` rule.
   */
  update(key: Pick<Row, K>, patch: Patch<Row>): Readonly<Row>;
  /** Patches several rows. Everything is checked before anything is applied. */
  update(keys: readonly Pick<Row, K>[], patch: Patch<Row>): readonly Readonly<Row>[];

  /**
   * Deletes rows by key, following each incoming ref's `onDelete` rule. `restrict` is checked
   * against the complete plan, so a row and everything referencing it can go in one call.
   */
  delete(keys: Pick<Row, K> | readonly Pick<Row, K>[]): DeleteResult<S>;
}

/** Keys per collection, for `remove`. */
export type KeysByCollection<S, C> = {
  readonly [N in keyof S]?: readonly Pick<S[N], KeyFieldsOf<C[N & keyof C]> & keyof S[N]>[];
};

/** Complete rows per collection, for `load`. The shape of a JSON fixture file. */
export type LoadData<S> = { readonly [N in keyof S]?: readonly S[N][] };

/** Database-wide methods. */
export interface DbMethods<S, C> {
  /** Inserts rows across collections as one batch, in any order. */
  load(data: LoadData<S>, options?: InsertOptions): void;
  /** Deletes rows across collections as one plan. */
  remove(keys: KeysByCollection<S, C>): DeleteResult<S>;
  /**
   * Runs `fn`; if it throws, every change made inside is rolled back. Nested transactions
   * roll back to where they started. `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T;
  /** Captures the current state. Cheap to take, O(total rows). */
  snapshot(): Snapshot<S>;
  /** Restores a snapshot taken from this database. A snapshot can be restored many times. */
  restore(snapshot: Snapshot<S>): void;
}

/** A database: one {@link Collection} per row type, plus {@link DbMethods}. */
export type Db<S, C> = {
  readonly [N in keyof S]: Collection<
    S,
    S[N],
    KeyFieldsOf<C[N & keyof C]> & keyof S[N],
    RelsOf<S, C, N & keyof C>
  >;
} & DbMethods<S, C>;
