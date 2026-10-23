# memrel — Implementation Design

Oct 23, 2026 · @Mees van Dongen

## Overview

memrel is a small, synchronous, in-memory relational store for typed mock data. It owns storage, indexes and referential integrity; it is not an ORM, because there is no database underneath to map onto.

Goals:

- **Typed schema from plain TypeScript row types.** Row types can come from anywhere (`z.infer`, openapi-typescript, hand-written); memrel only needs a small runtime config for keys and relations.
- **Relations with composite keys.** Composite primary keys, composite foreign keys, named inverse relations.
- **Referential integrity.** Inserts can't create dangling references; deletes and key changes follow per-relation rules (`cascade`, `restrict`, `setNull`).
- **Synchronous and fast.** Every key lookup, foreign key lookup and cascade step is a map lookup, never a scan.
- **Plain data.** Rows are plain objects and results are plain arrays, so serialization, snapshots and mock responses stay simple.
- **A minimal API.** A method exists only if it does something plain code can't: use an index, or enforce something at the type level.

Non-goals:

- Runtime validation of row shapes (no Zod parsing).
- A query language, query planner, or projection/`include` API.
- Persistence, and sharing state across workers or processes.
- Lazy relation accessors on rows.
- Freezing rows at runtime; the readonly types are the guard.
- Factories and data generation; these can live in a separate package.

## Schema definition

A database is created from a map of row types plus a runtime config describing keys and relations. The double call is deliberate: TypeScript can't infer some generic parameters while others are supplied explicitly, so the first call fixes the row types and the second infers the exact config.

```ts
type User              = { id: string; email: string; name: string };
type Org               = { id: number; name: string };
type OrgUser           = { orgId: number; userId: string; role: 'admin' | 'member' };
type OrgUserPermission = { memberOrgId: number; memberUserId: string; permission: string };
type Post              = { id: string; authorId: string; title: string };

const db = createDb<{
  user: User;
  org: Org;
  orgUser: OrgUser;
  orgUserPermission: OrgUserPermission;
  post: Post;
}>()({
  user: { key: ['id'], unique: [['email']] },       // unique key besides the primary key
  org:  { key: ['id'] },

  orgUser: {
    key: ['orgId', 'userId'],                         // composite primary key
    refs: {
      org:  { fields: ['orgId'],  to: 'org',  references: ['id'], onDelete: 'cascade', onUpdate: 'cascade', inverse: 'members' },
      user: { fields: ['userId'], to: 'user', references: ['id'], onDelete: 'cascade', onUpdate: 'cascade', inverse: 'memberships' },
    },
  },

  orgUserPermission: {
    key: ['memberOrgId', 'memberUserId', 'permission'],
    refs: {
      membership: {                                   // composite foreign key
        fields:     ['memberOrgId', 'memberUserId'],
        to:         'orgUser',
        references: ['orgId',       'userId'],        // pairs with `fields` by position
        onDelete:   'cascade',
        onUpdate:   'cascade',
        inverse:    'permissions',
      },
    },
  },

  post: {
    key: ['id'],
    indexes: [['title']],
    refs: {
      author: { fields: ['authorId'], to: 'user', references: ['id'], onDelete: 'restrict', inverse: 'posts' },
    },
  },
});
```

Config per collection:

| Option | Required | Meaning |
| --- | --- | --- |
| `key` | yes | Primary key fields, in order. One field or several (composite). |
| `unique` | no | Unique keys besides the primary key, each a list of fields, e.g. `[['email'], ['orgId', 'slug']]`. |
| `refs` | no | Named outgoing references (foreign keys). |
| `indexes` | no | Extra equality indexes, each a list of fields. |

Config per ref:

| Option | Required | Meaning |
| --- | --- | --- |
| `fields` | yes | The child's foreign key fields, in order. |
| `to` | yes | Target collection name. |
| `references` | yes for composite, else defaults to target `key` | Target fields; `fields[i]` pairs with `references[i]`. Must be the target's primary key or one of its `unique` keys. |
| `onDelete` | yes | What happens to referencing rows when the target is deleted: `cascade`, `restrict` or `setNull`. |
| `onUpdate` | no, defaults to `restrict` | What happens to referencing rows when the referenced fields change: `cascade`, `restrict` or `setNull`. |
| `inverse` | no | Name of the reverse relation on the target, used by `rel`. |

Mapping is by position, never by name. Keeping `references` required for composite foreign keys avoids silent ordering mistakes.

## Type-level guarantees

The config types catch structural mistakes at compile time; everything about actual data is checked at runtime by memrel itself.

Enforced by the types:

- `key`, `unique`, `fields`, `references` and `indexes` only contain fields of the relevant row type.
- `to` is an existing collection name.
- `fields` and `references` have the same length, and their types match position by position (`orgId: number` can't point at `user.id: string`).
- `references` names the target's primary key or one of its `unique` keys.
- `setNull`, for either `onDelete` or `onUpdate`, is only allowed when all foreign key fields are nullable.
- Relation names in `rel` are typed per collection: forward ref names plus inverse names.
- `get` requires the complete key object (`Pick<Row, KeyFields>`), so half a composite key is a compile error.

Checked at runtime, not by types: duplicate keys, dangling references, and the outcome of cascades.

Implementation notes:

- Compute relation types per collection rather than over the whole database at once, to keep editor performance acceptable with dozens of collections.
- When row types come from `z.infer`, they are the schema's output types. Nothing parses at runtime, so inserted data must already be in final shape.

## Storage and indexes

All state lives in `Map`s keyed by encoded key tuples; rows are stored once, and every index refers to rows by their encoded primary key.

**Key encoding.** A key tuple is encoded to a string that preserves value types, so `1` and `'1'` never collide. A type-tagged JSON array works, for example `["n:1","s:u1"]`. The same encoder is used for primary keys, foreign key tuples and index keys, which is what makes a child's foreign key tuple directly usable as a lookup into the target's primary index.

**Primary index.** One per collection: `Map<encodedKey, Row>`.

```
orgUser:            Map { [1,"u1"]            → { orgId: 1, userId: "u1", role: "admin" } }
orgUserPermission:  Map { [1,"u1","billing"] → { memberOrgId: 1, memberUserId: "u1", permission: "billing" } }
```

**Reverse index.** One per ref: `Map<encodedTargetKey, Set<encodedChildKey>>`. It answers "which children point at this row" and powers `rel` on inverses, `where` on foreign key fields, and the delete planner.

```
orgUser.user                 user key    → Set<orgUser key>
orgUser.org                  org key     → Set<orgUser key>
orgUserPermission.membership orgUser key → Set<orgUserPermission key>
post.author                  user key    → Set<post key>
```

**Incoming-ref table.** Built once from the config: for each collection, the refs that point at it and their `onDelete` rule.

```
user    ← [orgUser.user (cascade), post.author (restrict)]
org     ← [orgUser.org (cascade)]
orgUser ← [orgUserPermission.membership (cascade)]
```

**Secondary indexes.** One per entry in `indexes`: `Map<encodedValues, Set<encodedKey>>`, equality only. Foreign key field sets are always indexed through the reverse index, so they never need declaring.

**Unique indexes.** One per entry in `unique`: `Map<encodedValues, encodedKey>`, mapping each value tuple to the single row holding it. Rows with a null in any field of a unique key are not indexed, so several rows may leave it empty, as in SQL. A ref that targets a unique key finds its target here, and its reverse index is keyed by the encoded referenced values rather than the target's primary key.

**Iteration order.** Insertion order, which `Map` and `Set` provide for free. This must be guaranteed and documented: deterministic order keeps mock pagination and snapshot tests stable.

## Read API

The read API is three methods, and every result is a plain value: a row, `undefined`, `null`, or a readonly array.

```ts
db.user.get({ id: 'u1' });                       // Readonly<User> | undefined
db.orgUser.get({ orgId: 1, userId: 'u1' });      // full composite key required

db.post.where({ authorId: 'u1' });               // readonly Readonly<Post>[]
db.post.where({ authorId: { in: ['u1', 'u2'] } });

db.post.rel(post, 'author');                     // Readonly<User>
db.user.rel(user, 'posts');                      // readonly Readonly<Post>[]
db.orgUser.rel(membership, 'permissions');       // resolved via the composite FK
```

**`get(key)`** is the identity lookup: one map lookup. It requires the complete key at the type level; that check is the reason it exists alongside `where`.

**`where(conditions)`** is equality search, plus `in`. It answers only what indexes can answer. Strategy:

1. Conditions cover the full primary key or a unique key: a single lookup.
2. Conditions cover a ref's `fields` or a declared index: use that index, then check remaining conditions on the candidates.
3. Several indexes apply: start from the smallest bucket.
4. No index applies: scan the collection.
5. Empty conditions return every row.

**`rel(rowOrKey, name)`** traverses a relation by name:

- A forward ref returns the target row, or `null` when the foreign key fields are all null.
- An inverse returns an array, or a single row (or `undefined`) when the child's foreign key fields are also its whole key or a unique key.
- It accepts a full row or just a key object; with a key, memrel reads the foreign key fields from the stored row.
- The collection is named explicitly (`db.post.rel`) because plain rows don't carry their collection.

**Results.** Rows are `Readonly<Row>` and are never frozen at runtime: the readonly types are the guard against mutating a stored row, which would desync the indexes. Arrays are `readonly`. v1 returns a fresh array per call (an O(k) copy of references). Because the type is `readonly` from day one, this can later switch to cached arrays per index bucket, invalidated on write, without breaking anyone.

**Everything else is plain code.** Filtering, sorting, pagination, counting and relation-based filtering use array methods and `rel`, which costs the same as a built-in because `rel` hits the reverse index:

```ts
db.post.where({ authorId: 'u1' }).filter(p => p.title.includes('zod')).slice(0, 10);
db.user.where({ name: 'Ann' }).flatMap(u => db.user.rel(u, 'posts'));
db.user.where({}).filter(u => db.user.rel(u, 'posts').length > 0);

const toUserResponse = (u: User) => ({
  ...u,
  postCount: db.user.rel(u, 'posts').length,
  orgIds: db.user.rel(u, 'memberships').map(m => m.orgId),
});
```

## Write API and integrity

Every write keeps the store consistent: no duplicate keys, no dangling references, and indexes always in sync. Each collection has three write methods (`insert`, `update`, `delete`); `load` and `remove` do the same across collections.

### Insert

```ts
db.user.insert({ id: 'u1', name: 'Ann' });           // returns the stored row
db.post.insert([p1, p2]);                             // batch
db.user.insert(row,  { onConflict: 'replace' });      // upsert: PUT semantics
db.user.insert(rows, { onConflict: 'ignore' });       // keep existing rows, add new ones
```

1. Encode each row's primary key. If it already exists, apply `onConflict`: `'throw'` (default) throws, `'ignore'` skips the row, `'replace'` sends the row through the update path, so its children are never cascaded.
2. Check each `unique` key against the unique indexes and within the batch. A unique conflict always throws; `onConflict` applies to the primary key only.
3. Store the new rows and add them to every index.
4. Check every ref of every stored or replaced row: all fields null means no reference, some null throws, otherwise the target must exist.
5. If any check fails, the whole batch rolls back.

Checks run once after the whole batch, so rows within a batch can reference each other in any order. Rows must be complete, keys included; defaults and ID generation belong in factories, not the core. `'replace'` replaces the whole row and never merges, since a new row would have nothing to merge with.

### Load

```ts
db.load({
  user:    [{ id: 'u1', name: 'Ann' }],
  org:     [{ id: 1, name: 'Acme' }],
  orgUser: [{ orgId: 1, userId: 'u1', role: 'admin' }],
  post:    [{ id: 'p1', authorId: 'u1', title: 'A' }],
}, { onConflict: 'ignore' });
```

`load` inserts across collections as one batch, with the same `onConflict` option. Collections can appear in any order, and the shape is exactly that of a JSON fixture file. It was chosen over nested creates, which would make insert types diverge from row types and complicate composite keys.

### Update

```ts
db.post.update({ id: 'p1' }, { title: 'New title' });                   // patch
db.post.update({ id: 'p1' }, p => ({ title: p.title.trim() }));         // derived from the current row
db.post.update(db.post.where({ authorId: 'u1' }), { authorId: 'u2' });  // several keys, one patch
```

`update` is essential rather than convenient: the plain-code alternative, delete plus insert, would trigger delete rules and cascade away the row's children.

- Any field can change, including primary and unique key fields; the patch type is `Partial<Row>`.
- A key change re-keys the row in every index, and throws if the new values collide with another row.
- If referenced fields change (the primary key, or a unique key some ref targets), each incoming ref applies its `onUpdate` rule. Like a delete, this is planned in full before anything changes:
  - `cascade` rewrites the children's foreign key fields to the new values.
  - `restrict` throws if any child still points at the old values.
  - `setNull` nulls the children's foreign key fields.
- Cascades can chain: changing `user.id` rewrites `orgUser.userId`, which changes `orgUser`'s primary key, which in turn rewrites `orgUserPermission.memberUserId`. Visited rows are tracked so cycles terminate.
- If the row's own foreign key fields change, re-run the reference check for that ref and move the row between reverse index buckets.
- Update secondary and unique indexes whose fields changed.
- Rows are replaced, never mutated in place, so arrays and rows handed out earlier stay unchanged.

The function form receives the current row and returns a patch. With several keys, everything is checked before anything is applied. `update` returns the new row or rows, and a missing key throws.

### Delete

```ts
db.user.delete({ id: 'u1' });
db.user.delete([{ id: 'u1' }, { id: 'u2' }]);
db.post.delete(db.post.where({ authorId: 'u1' }));   // rows contain their key fields
```

Deletes plan first and execute second; nothing changes until the plan is complete. All keys in one call are planned together.

1. Start the plan with the given rows. A missing key throws.
2. For each planned row, look up its collection's incoming refs and, for each ref, the reverse index bucket for the referenced values (the primary key, or the unique key that ref targets).
3. `cascade`: add the referencing rows to the plan and repeat step 2 for them. Visited keys are tracked so cycles terminate.
4. `setNull`: record an update setting the ref's foreign key fields to null.
5. Once the plan is complete, check `restrict` refs. Fail only if a referencing row survives the plan, naming the blocking rows; nothing has changed.
6. Execute: remove planned rows from every index, then apply the set-null updates.

Checking `restrict` against the final plan is what lets "delete this user and all their posts" succeed in one call, even though `post.author` is `restrict`. Example: deleting user `u1` alone cascades to their `orgUser` rows and through the composite foreign key to their `orgUserPermission` rows, or fails with an error like `Cannot delete user ["u1"]: restricted by 3 rows in post.author`.

```ts
const result = db.user.delete({ id: 'u1' });
// { deleted: { user: [...], orgUser: [...], orgUserPermission: [...] },
//   nulled:  { ... } }
```

The result holds the removed rows, not just keys, for test assertions and mock `DELETE` handlers. There is no dry-run method: delete inside a rolled-back transaction, or restore a snapshot, instead.

### Remove

```ts
db.remove({ user: [{ id: 'u1' }], post: [{ id: 'p1' }, { id: 'p2' }] });
```

`remove` deletes across collections as one plan, with the same result shape as `delete`.

### Composite foreign keys and nulls

- All foreign key fields null means "no reference". Some null is an error (like SQL `MATCH FULL`).
- `setNull` nulls every field of the foreign key by default. An optional `setNullFields` subset (like Postgres 15's `SET NULL (col)`) covers the shared tenant-column case, where nulling the shared column would be wrong.
- When foreign keys overlap on a shared column, cascade and set-null rules must not contradict each other; validate this when the schema is created.

## Transactions and snapshots

This section is a proposal: multi-step writes need to be atomic, and tests need a cheap way back to a known state.

**Atomic writes via an undo log.** Each primitive change (store row, remove row, index add, index remove) appends its inverse to a log. A batch insert, `load`, `update` or delete plan that throws midway replays the log backwards, so the store is unchanged.

```ts
db.transaction(() => {
  db.user.insert(...);
  db.post.update(...);
}); // any throw rolls back everything inside
```

**Snapshots for tests.** Seed once, snapshot, and restore before each test:

```ts
const seeded = db.snapshot();
beforeEach(() => db.restore(seeded));
```

The simplest implementation copies every `Map` and `Set` (rows themselves are never mutated, so they can be shared). That is O(total rows) per restore, which is fine at mock sizes. Persistent maps or copy-on-write per collection can make it near-free later, behind the same API.

## Decisions log

The guiding rule behind most of these: a method stays only if it uses an index or enforces something at the type level that plain code can't.

| Topic | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Engine | Own JS store | In-memory SQLite (sql.js, better-sqlite3), DataScript, AlaSQL, TinyBase, redux-orm | SQLite adds a translation layer and async WASM loading; none of the JS options cover composite keys, configurable cascades and typed schemas together. |
| Validation | None; TS types only | Zod parsing on write | Per-write parsing was the largest performance cost, and only types were wanted. |
| Nested data | `rel` plus plain code | `include`, `select(fn)`, declarative select, named views, lazy accessors | In memory there are no round trips, so `include` has no performance reason; plain code is fully typed and shapes anything. Lazy accessors would make rows non-plain. |
| Query surface | `get`, `where`, `rel` | `filter`, `orderBy`, `limit`, `whereRel`, `count`, `exists`, `first`, `all`, `iterate`, query objects | Each only duplicated array methods or `rel` composition at the same cost. |
| `get` vs `where` | Keep both | `where(key)[0]` only | `get` requires the full key at compile time, preventing silent partial composite-key matches. |
| `where` operators | Equality and `in` | `startsWith`, `lt`, `gt` and similar | Hash indexes can't answer them; plain `filter` costs the same. |
| Results | Fresh `readonly` arrays | Returning internal sets, mutable arrays | Prevents index corruption and live-changing results; `readonly` leaves room for cached arrays later. |
| Freezing rows | Never; readonly types only | Freezing in development | Avoids behaviour that differs between environments, and the per-row cost. |
| FK mapping | Explicit `references`, by position | Matching by field name | Names can differ between child and target; explicit order avoids silent mistakes. |
| Unique keys | `unique` config; refs may target them | References to primary keys only | Real schemas reference natural keys such as emails or slugs. |
| Key changes | Allowed, with per-ref `onUpdate` | Immutable keys | Mocked APIs rename slugs and move rows between parents; cascades keep children attached. |
| Batch inserts | `insert` accepts an array; `load` across collections | `insertMany`, nested creates | One method covers both; `load` keeps insert types equal to row types and matches fixture files. |
| Upsert | `insert` with `onConflict: 'replace'` | Separate `upsert`, merging into `update` | Upsert shares insert's input shape and batching; merging into `update` would lose partial patches and the missing-key error. |
| Update | Dedicated `update` | Delete plus insert | Delete plus insert would cascade away the row's children. |
| Restrict checks | Against the final delete plan | Per row while walking | Lets a row and everything referencing it be deleted in one call. |
| Delete preview | None | `planDelete` | `delete` returns what it removed; a rolled-back transaction or snapshot covers dry runs. |
| Factories | Out of scope | Built into memrel | Keeps the core small; can be a separate package on top. |
| Name | memrel | relstore, memtab, others | Says exactly what it is and is easy to search. |

## Milestones

Milestones, in order:

1. Schema types: `createDb` and the type-level checks, tested with type tests only.
2. Core storage: key encoding, primary, unique and reverse indexes, schema validation at creation.
3. Read API: `get`, `where` with index selection, `rel` including inverse cardinality.
4. Undo log and `transaction`, since every write below relies on rollback.
5. `insert` with batches, `onConflict` and unique checks, then `load`.
6. `update`, including key changes with `onUpdate` cascades, foreign key changes and the function form.
7. Delete planner with `cascade`, `restrict` against the final plan, `setNull` and cycle handling; then `remove`.
8. `snapshot` and `restore`.
9. Benchmarks at 10k and 100k rows, then decide on cached result arrays and faster snapshots.
