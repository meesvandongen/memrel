<div align="center">

# memrel

**A tiny, synchronous, in-memory relational store for typed mock data.**

Composite keys · foreign keys · cascades · transactions · snapshots: typed end to end, with zero dependencies.

[![npm](https://img.shields.io/npm/v/@mvd/memrel?color=cb3837&logo=npm)](https://www.npmjs.com/package/@mvd/memrel)
[![CI](https://github.com/meesvandongen/memrel/actions/workflows/ci.yml/badge.svg)](https://github.com/meesvandongen/memrel/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlejs/size/@mvd/memrel)](https://bundlejs.com/?q=@mvd/memrel)
[![types](https://img.shields.io/npm/types/@mvd/memrel)](https://github.com/meesvandongen/memrel/blob/main/packages/memrel/src/types.ts)
[![license](https://img.shields.io/npm/l/@mvd/memrel)](https://github.com/meesvandongen/memrel/blob/main/LICENSE)

**[▶ Try it in the playground](https://meesvandongen.github.io/memrel/)**

</div>

---

Mock APIs and test fixtures quickly turn into a tangle of arrays, `find` calls and hand-written "delete the
user's posts too" logic. **memrel** gives you a small relational store instead: you describe keys and
relations once, and it keeps your mock data consistent. That means no duplicate keys, no dangling
references, and deletes that cascade the way your real database does.

It is **not an ORM**: there is no database underneath to map onto. Rows are plain objects, results are plain
arrays, and every lookup is a `Map` hit.

<a href="https://meesvandongen.github.io/memrel/"><img src="https://raw.githubusercontent.com/meesvandongen/memrel/main/docs/playground.png" alt="The memrel playground: deleting a user cascades through memberships and permissions, nulls a reviewer, and highlights every changed row" /></a>

```ts
import { createDb } from '@mvd/memrel';

const db = createDb<{ user: User; post: Post }>()({
  user: { key: ['id'], unique: [['email']] },
  post: {
    key: ['id'],
    refs: {
      author: { fields: ['authorId'], to: 'user', onDelete: 'cascade', inverse: 'posts' },
    },
  },
});

db.load({
  user: [{ id: 'u1', email: 'ann@example.com', name: 'Ann' }],
  post: [{ id: 'p1', authorId: 'u1', title: 'Hello' }],
});

db.user.rel({ id: 'u1' }, 'posts');        // [{ id: 'p1', authorId: 'u1', title: 'Hello' }]
db.post.insert({ id: 'p2', authorId: 'nobody', title: '?' });
// 💥 MemrelError: post ["p2"]: post.author references missing user ["nobody"]
db.user.delete({ id: 'u1' });              // { deleted: { user: [...], post: [...] }, nulled: {} }
```

## Highlights

|                                    |                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 🧩 **Bring your own row types**    | Plain TypeScript types from anywhere: `z.infer`, openapi-typescript or hand-written.                  |
| 🔑 **Composite keys**              | Composite primary keys, composite foreign keys, and references to `unique` keys such as emails or slugs. |
| 🔗 **Referential integrity**       | `cascade`, `restrict` and `setNull`, on delete *and* on key change.                                   |
| 🛡️ **Typed config**                | Wrong field names, mismatched key types and non-nullable `setNull` fields are compile errors.         |
| ⚡ **Fast and synchronous**        | Every key lookup, foreign key lookup and cascade step is a `Map` lookup, never a scan.                |
| ↩️ **Transactions and snapshots**  | Every write is atomic. Roll back any block, or restore a seeded state before each test.               |
| 📦 **Plain data**                  | Rows are plain objects and results are plain arrays, so they serialize straight into mock responses.  |
| 🪶 **Small**                       | Zero dependencies, ESM, roughly 8 kB gzipped.                                                         |

## Install

```sh
npm install -D @mvd/memrel
# or
pnpm add -D @mvd/memrel
```

Requires TypeScript 5 or newer for the type-level checks.

## Defining a schema

`createDb` takes your row types first, then a small runtime config for keys and relations. The double call is
deliberate: TypeScript can't infer some type parameters while you pass others explicitly, so the first call
fixes the row types and the second infers the exact config.

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
  user: { key: ['id'], unique: [['email']] },        // a unique key besides the primary key
  org:  { key: ['id'] },

  orgUser: {
    key: ['orgId', 'userId'],                          // composite primary key
    refs: {
      org:  { fields: ['orgId'],  to: 'org',  onDelete: 'cascade', onUpdate: 'cascade', inverse: 'members' },
      user: { fields: ['userId'], to: 'user', onDelete: 'cascade', onUpdate: 'cascade', inverse: 'memberships' },
    },
  },

  orgUserPermission: {
    key: ['memberOrgId', 'memberUserId', 'permission'],
    refs: {
      membership: {                                    // composite foreign key
        fields:     ['memberOrgId', 'memberUserId'],
        to:         'orgUser',
        references: ['orgId',       'userId'],         // pairs with `fields` by position
        onDelete:   'cascade',
        onUpdate:   'cascade',
        inverse:    'permissions',
      },
    },
  },

  post: {
    key: ['id'],
    indexes: [['title']],                              // an extra equality index for `where`
    refs: {
      author: { fields: ['authorId'], to: 'user', onDelete: 'restrict', inverse: 'posts' },
    },
  },
});
```

<details>
<summary><b>Config reference</b></summary>

**Per collection**

| Option    | Required | Meaning                                                                                  |
| --------- | -------- | ---------------------------------------------------------------------------------------- |
| `key`     | yes      | Primary key fields, in order: one field or several (composite).                          |
| `unique`  | no       | Unique keys besides the primary key, e.g. `[['email'], ['orgId', 'slug']]`.              |
| `refs`    | no       | Named outgoing references (foreign keys).                                                |
| `indexes` | no       | Extra equality indexes. Foreign keys are always indexed, so they never need declaring.   |

**Per ref**

| Option          | Required                                   | Meaning                                                                                  |
| --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `fields`        | yes                                        | The child's foreign key fields, in order.                                                |
| `to`            | yes                                        | Target collection.                                                                       |
| `references`    | for composite keys; else the target's `key` | Target fields; `fields[i]` pairs with `references[i]`. Must be the target's primary key or one of its `unique` keys. |
| `onDelete`      | yes                                        | `cascade`, `restrict` or `setNull`, applied when the target is deleted.                  |
| `onUpdate`      | no, defaults to `restrict`                 | The same rules, applied when the referenced fields change.                               |
| `setNullFields` | no, defaults to all of `fields`            | The fields `setNull` clears, like Postgres' `SET NULL (col)`. Useful for shared tenant columns. |
| `inverse`       | no                                         | Name of the reverse relation on the target, used by `rel`.                               |

Mapping is by position, never by name. A foreign key whose fields are all null references nothing; one that
is only partly null is an error (like SQL's `MATCH FULL`).

</details>

### Mistakes are compile errors

The config is checked against your row types, and errors point at the offending property with a readable
message:

```ts
author: { fields: ['authorId'], to: 'user', references: ['name'], onDelete: 'cascade' }
//                                          ~~~~~~~~~~~~~~~~~~~~~
// memrel: `references` must be the target's `key` or one of its `unique` keys

author: { fields: ['authorId'], to: 'user', onDelete: 'setNull' }
//                                                    ~~~~~~~~~
// memrel: setNull requires nullable fields, but 'authorId' is not nullable

membership: { fields: ['memberOrgId'], to: 'orgUser', onDelete: 'cascade' }
// memrel: composite foreign keys need explicit `references`
```

The types check that:

- every field list only names fields of its row type, and `to` names an existing collection;
- `fields` and `references` have the same length, and their types match position by position, so
  `orgId: number` can't point at `user.id: string`;
- `references` names the target's primary key or one of its unique keys;
- `setNull` is only used on nullable fields, and unknown options (`invers: ...`) are rejected;
- `get` requires the complete key, so half a composite key doesn't compile;
- relation names in `rel` are typed per collection, and so are their results.

Everything about the actual data (duplicate keys, dangling references, the outcome of cascades) is checked at
runtime, and failures throw a `MemrelError` with a stable `code`.

## Reading

There are three read methods. Every result is a plain value: a row, `undefined`, `null`, or a readonly
array.

```ts
db.user.get({ id: 'u1' });                        // Readonly<User> | undefined
db.orgUser.get({ orgId: 1, userId: 'u1' });       // the full composite key is required

db.post.where({ authorId: 'u1' });                // readonly Readonly<Post>[]
db.post.where({ authorId: { in: ['u1', 'u2'] } });
db.post.where({});                                // every row

db.post.rel(post, 'author');                      // Readonly<User>
db.user.rel(user, 'posts');                       // readonly Readonly<Post>[]
db.orgUser.rel({ orgId: 1, userId: 'u1' }, 'permissions');  // through the composite foreign key
```

- **`get(key)`** is a single map lookup.
- **`where(conditions)`** supports equality and `in`. It uses the primary key, a unique key, a foreign key or
  a declared index when the conditions cover one, picking the smallest bucket, and scans otherwise. Conditions
  that are `undefined` are ignored, which suits optional query parameters.
- **`rel(rowOrKey, name)`** follows a relation. A forward ref returns the target row, or `null` when the
  foreign key is null. An inverse returns the referencing rows, or a single row (or `undefined`) when the
  foreign key is also the child's primary or unique key.

**Results come back in insertion order.** An updated row keeps its place, even when its key changes, so mock
pagination and snapshot tests stay stable.

Everything else is plain code. Filtering, sorting, pagination and counting use array methods, and `rel` costs
the same as a built-in would, because it hits the reverse index:

```ts
db.post.where({ authorId: 'u1' }).filter((p) => p.title.includes('zod')).slice(0, 10);
db.user.where({}).filter((u) => db.user.rel(u, 'posts').length > 0);

const toUserResponse = (u: User) => ({
  ...u,
  postCount: db.user.rel(u, 'posts').length,
  orgIds: db.user.rel(u, 'memberships').map((m) => m.orgId),
});
```

## Writing

Every write keeps the store consistent, and every write is atomic: if anything fails, nothing changes.

### Insert and load

```ts
db.user.insert({ id: 'u1', email: 'ann@example.com', name: 'Ann' });  // returns the stored row
db.post.insert([p1, p2]);                                              // a batch
db.user.insert(row,  { onConflict: 'replace' });                       // upsert, with PUT semantics
db.user.insert(rows, { onConflict: 'ignore' });                        // keep existing rows, add new ones

db.load({ user: [...], org: [...], orgUser: [...], post: [...] });     // across collections, in any order
```

References are checked once the whole batch is in, so rows in a batch can reference each other in any order,
and `load` takes exactly the shape of a JSON fixture file. Unique conflicts always throw; `onConflict` only
concerns the primary key.

### Update

```ts
db.post.update({ id: 'p1' }, { title: 'New title' });                     // a patch
db.post.update({ id: 'p1' }, (p) => ({ title: p.title.trim() }));         // derived from the current row
db.post.update(db.post.where({ authorId: 'u1' }), { authorId: 'u2' });    // several keys, one patch
```

Any field can change, **keys included**. When a referenced value changes, each ref pointing at it applies its
`onUpdate` rule, and cascades chain: renaming `user.id` rewrites `orgUser.userId`, which changes `orgUser`'s
primary key, which in turn rewrites `orgUserPermission.memberUserId`. Rows are replaced, never mutated, so rows
and arrays you got earlier stay unchanged.

### Delete and remove

```ts
db.user.delete({ id: 'u1' });
db.post.delete(db.post.where({ authorId: 'u1' }));        // rows contain their keys
db.remove({ user: [{ id: 'u1' }], post: [{ id: 'p1' }] }); // across collections, as one plan
```

Deletes are planned in full before anything changes. `cascade` adds referencing rows to the plan, `setNull`
clears their foreign keys, and `restrict` is checked **against the final plan**. That's what lets "delete this
user and all their posts" succeed in one call, even though `post.author` is `restrict`:

```ts
db.user.delete({ id: 'u1' });
// 💥 MemrelError: Cannot delete user ["u1"]: restricted by 2 rows in post.author

db.remove({ user: [{ id: 'u1' }], post: db.post.where({ authorId: 'u1' }) });
// ✅ { deleted: { user: [...], post: [...], orgUser: [...], orgUserPermission: [...] }, nulled: {} }
```

The result holds the removed rows, ready for test assertions and mock `DELETE` handlers.

## Transactions and snapshots

```ts
db.transaction(() => {
  db.user.insert(newUser);
  db.post.update({ id: 'p1' }, { authorId: newUser.id });
}); // any throw rolls back everything inside; nested transactions roll back to where they started
```

Seed once, and restore before each test:

```ts
const db = createMyDb();
db.load(fixtures);
const seeded = db.snapshot();

beforeEach(() => db.restore(seeded));
```

Snapshots share rows (rows are never mutated) and copy the indexes, which takes a few milliseconds at mock
sizes.

## Recipe: an MSW handler

```ts
http.get('/api/users/:id', ({ params }) => {
  const user = db.user.get({ id: params.id as string });
  if (!user) return new HttpResponse(null, { status: 404 });
  return HttpResponse.json({ ...user, posts: db.user.rel(user, 'posts') });
});

http.delete('/api/orgs/:id', ({ params }) => {
  const { deleted } = db.org.delete({ id: Number(params.id) });
  return HttpResponse.json({ removedMemberships: deleted.orgUser?.length ?? 0 });
});
```

## Errors

Everything memrel throws on purpose is a `MemrelError` with a `code`:

| Code                    | When                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `INVALID_SCHEMA`        | The config passed to `createDb` is inconsistent.                         |
| `DUPLICATE_KEY`         | A primary key is already taken.                                          |
| `UNIQUE_VIOLATION`      | A `unique` key is already taken.                                         |
| `FOREIGN_KEY_VIOLATION` | A reference points at a missing row, or is partly null.                  |
| `RESTRICT_VIOLATION`    | A delete or key change is blocked by a `restrict` rule.                  |
| `NOT_FOUND`             | A key passed to `update`, `delete` or `rel` doesn't exist.               |
| `INVALID_ARGUMENT`      | An unknown relation name, an async transaction callback, and the like.   |

## Performance

`pnpm bench` on a laptop-class machine, with 100k posts, 100k comments and 10k users:

| Operation                                   | Time       |
| ------------------------------------------- | ---------- |
| `get`                                       | ~0.4 µs    |
| `rel`, inverse with 10 rows                 | ~3 µs      |
| `where` on a foreign key, 10 rows           | ~10 µs     |
| `insert` / `update` one row                 | ~5–10 µs   |
| cascading delete of a user, 10 posts, 10 comments | ~0.1 ms |
| `snapshot` / `restore` of 210k rows         | ~0.1 s     |

## What memrel is not

memrel deliberately leaves out runtime validation (the types are the guard, so rows from `z.infer` must
already be in their final shape), a query language or `include` API, persistence, lazy relation accessors,
frozen rows, and factories. Each of these is either plain code on top or a better fit for a separate package.
The guiding rule: **a method exists only if it uses an index, or enforces something at the type level that
plain code can't.**

## Development

This repository is a pnpm workspace built on the [Vite+](https://viteplus.dev) toolchain: Oxfmt and Oxlint
(with type-aware checks) through `vp check`, Vitest through `vp test`, and tsdown through `vp pack`.

```
.
├── packages/memrel      the @mvd/memrel package: src, tests, benchmarks
├── apps/playground      the interactive playground, deployed to GitHub Pages
├── docs/design.md       the implementation design
├── vite.config.ts       shared lint, format and task-runner config
└── pnpm-workspace.yaml  workspace packages and the dependency catalog
```

```sh
pnpm install
pnpm dev         # the playground, served from the library source
pnpm check       # vp check: format, lint and type check
pnpm test        # vp test in every package: runtime and type tests
pnpm build       # vp pack in every package
pnpm bench       # tinybench, 10k and 100k rows
pnpm ready       # check, test and build, as CI runs them
```

## License

[MIT](https://github.com/meesvandongen/memrel/blob/main/LICENSE) © Mees van Dongen
