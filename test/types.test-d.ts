import { describe, expectTypeOf, test } from 'vitest';
import { createDb, type DeleteResult } from '../src/index.ts';
import { makeDb, type OrgUser, type OrgUserPermission, type Post, type User } from './schema.ts';

const db = makeDb();
declare const user: Readonly<User>;
declare const post: Readonly<Post>;

describe('read API', () => {
  test('get requires the complete key', () => {
    expectTypeOf(db.user.get({ id: 'u1' })).toEqualTypeOf<Readonly<User> | undefined>();
    expectTypeOf(db.orgUser.get({ orgId: 1, userId: 'u1' })).toEqualTypeOf<
      Readonly<OrgUser> | undefined
    >();
    // @ts-expect-error half a composite key
    db.orgUser.get({ orgId: 1 });
    // @ts-expect-error wrong key type
    db.user.get({ id: 1 });
    // @ts-expect-error not a key field
    db.user.get({ email: 'ann@example.com' });
  });

  test('where takes equality and in, typed per field', () => {
    expectTypeOf(db.post.where({ authorId: 'u1' })).toEqualTypeOf<readonly Readonly<Post>[]>();
    db.post.where({ authorId: { in: ['u1', 'u2'] } });
    db.orgUser.where({ role: 'admin' });
    // @ts-expect-error not a role
    db.orgUser.where({ role: 'owner' });
    // @ts-expect-error unknown field
    db.post.where({ nope: 1 });
  });

  test('rel names and results are typed per collection', () => {
    expectTypeOf(db.post.rel(post, 'author')).toEqualTypeOf<Readonly<User>>();
    expectTypeOf(db.user.rel(user, 'posts')).toEqualTypeOf<readonly Readonly<Post>[]>();
    expectTypeOf(db.user.rel({ id: 'u1' }, 'memberships')).toEqualTypeOf<
      readonly Readonly<OrgUser>[]
    >();
    expectTypeOf(db.orgUser.rel({ orgId: 1, userId: 'u1' }, 'permissions')).toEqualTypeOf<
      readonly Readonly<OrgUserPermission>[]
    >();
    // @ts-expect-error not a relation of user
    db.user.rel(user, 'author');
    // @ts-expect-error rel needs the key
    db.orgUser.rel({ orgId: 1 }, 'org');
  });

  test('nullable forward refs and single inverses', () => {
    type Profile = { userId: string; bio: string };
    type Account = { id: string; name: string };
    type Item = { id: string; parentId: string | null; ownerId?: string };
    const db2 = createDb<{ account: Account; profile: Profile; item: Item }>()({
      account: { key: ['id'] },
      profile: {
        key: ['userId'],
        refs: {
          account: { fields: ['userId'], to: 'account', onDelete: 'cascade', inverse: 'profile' },
        },
      },
      item: {
        key: ['id'],
        refs: {
          parent: { fields: ['parentId'], to: 'item', onDelete: 'setNull', inverse: 'children' },
          owner: { fields: ['ownerId'], to: 'account', onDelete: 'cascade', inverse: 'items' },
        },
      },
    });
    expectTypeOf(db2.account.rel({ id: 'a' }, 'profile')).toEqualTypeOf<
      Readonly<Profile> | undefined
    >();
    expectTypeOf(db2.profile.rel({ userId: 'a' }, 'account')).toEqualTypeOf<Readonly<Account>>();
    expectTypeOf(db2.item.rel({ id: 'i' }, 'parent')).toEqualTypeOf<Readonly<Item> | null>();
    expectTypeOf(db2.item.rel({ id: 'i' }, 'owner')).toEqualTypeOf<Readonly<Account> | null>();
    expectTypeOf(db2.item.rel({ id: 'i' }, 'children')).toEqualTypeOf<readonly Readonly<Item>[]>();
  });
});

describe('write API', () => {
  test('insert takes complete rows', () => {
    expectTypeOf(db.user.insert({ id: 'u', email: 'e', name: 'n' })).toEqualTypeOf<
      Readonly<User>
    >();
    expectTypeOf(db.user.insert([{ id: 'u', email: 'e', name: 'n' }])).toEqualTypeOf<
      readonly Readonly<User>[]
    >();
    // @ts-expect-error missing name
    db.user.insert({ id: 'u', email: 'e' });
    // @ts-expect-error unknown mode
    db.user.insert({ id: 'u', email: 'e', name: 'n' }, { onConflict: 'merge' });
  });

  test('update takes keys and a partial patch', () => {
    expectTypeOf(db.post.update({ id: 'p1' }, { title: 'x' })).toEqualTypeOf<Readonly<Post>>();
    expectTypeOf(db.post.update(db.post.where({ authorId: 'u1' }), { title: 'x' })).toEqualTypeOf<
      readonly Readonly<Post>[]
    >();
    db.post.update({ id: 'p1' }, (p) => ({ title: p.title.trim() }));
    // @ts-expect-error wrong field type
    db.post.update({ id: 'p1' }, { title: 1 });
  });

  test('delete and remove return removed rows per collection', () => {
    type S = {
      user: User;
      org: { id: number; name: string };
      orgUser: OrgUser;
      orgUserPermission: OrgUserPermission;
      post: Post;
    };
    expectTypeOf(db.user.delete({ id: 'u1' })).toEqualTypeOf<DeleteResult<S>>();
    expectTypeOf(db.user.delete({ id: 'u1' }).deleted.orgUser).toEqualTypeOf<
      readonly Readonly<OrgUser>[] | undefined
    >();
    db.remove({ user: [{ id: 'u1' }], orgUser: [{ orgId: 1, userId: 'u1' }] });
    // @ts-expect-error incomplete key
    db.remove({ orgUser: [{ orgId: 1 }] });
  });

  test('load takes fixture-shaped data', () => {
    db.load({ user: [{ id: 'u', email: 'e', name: 'n' }], org: [{ id: 1, name: 'Acme' }] });
    // @ts-expect-error unknown collection
    db.load({ nope: [] });
  });

  test('transaction returns the callback result', () => {
    expectTypeOf(db.transaction(() => 42)).toEqualTypeOf<number>();
  });
});

describe('config checks', () => {
  type A = { id: string; code: string; tenantId: number };
  type B = {
    id: string;
    aId: string;
    aCode: string | null;
    aNum: number;
    tenantId: number;
    parentId: string | null;
  };

  test('accepts a valid config', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'], unique: [['tenantId', 'code']] },
      b: {
        key: ['id'],
        refs: {
          a: { fields: ['aId'], to: 'a', onDelete: 'cascade', onUpdate: 'cascade' },
          byCode: {
            fields: ['tenantId', 'aCode'],
            to: 'a',
            references: ['tenantId', 'code'],
            onDelete: 'setNull',
            setNullFields: ['aCode'],
          },
          parent: { fields: ['parentId'], to: 'b', onDelete: 'setNull', onUpdate: 'setNull' },
        },
      },
    });
  });

  test('field lists only contain fields of the row', () => {
    createDb<{ a: A }>()({
      // @ts-expect-error not a field
      a: { key: ['nope'] },
    });
    createDb<{ a: A }>()({
      // @ts-expect-error not a field
      a: { key: ['id'], unique: [['nope']] },
    });
    createDb<{ a: A }>()({
      // @ts-expect-error not a field
      a: { key: ['id'], indexes: [['nope']] },
    });
  });

  test('every collection needs a config', () => {
    // @ts-expect-error b is missing
    createDb<{ a: A; b: B }>()({ a: { key: ['id'] } });
  });

  test('to must be a collection', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'] },
      // @ts-expect-error unknown target
      b: { key: ['id'], refs: { a: { fields: ['aId'], to: 'c', onDelete: 'cascade' } } },
    });
  });

  test('references must be a key or unique key of the target', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'] },
      b: {
        key: ['id'],
        refs: {
          // @ts-expect-error code is not a key of a
          a: { fields: ['aId'], to: 'a', references: ['code'], onDelete: 'cascade' },
        },
      },
    });
  });

  test('fields and references must pair up by type', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'], unique: [['tenantId']] },
      b: {
        key: ['id'],
        refs: {
          // @ts-expect-error string can't point at number
          a: { fields: ['aId'], to: 'a', references: ['tenantId'], onDelete: 'cascade' },
        },
      },
    });
    createDb<{ a: A; b: B }>()({
      a: { key: ['tenantId'] },
      b: {
        key: ['id'],
        // @ts-expect-error string can't point at number through the default references
        refs: { a: { fields: ['aId'], to: 'a', onDelete: 'cascade' } },
      },
    });
  });

  test('fields and references must have the same length', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'], unique: [['tenantId', 'code']] },
      b: {
        key: ['id'],
        refs: {
          a: {
            fields: ['tenantId'],
            to: 'a',
            // @ts-expect-error lengths differ
            references: ['tenantId', 'code'],
            onDelete: 'cascade',
          },
        },
      },
    });
  });

  test('composite foreign keys need explicit references', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['tenantId', 'code'] },
      b: {
        key: ['id'],
        // @ts-expect-error references missing
        refs: { a: { fields: ['tenantId', 'aCode'], to: 'a', onDelete: 'cascade' } },
      },
    });
  });

  test('setNull requires nullable fields', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'] },
      b: {
        key: ['id'],
        // @ts-expect-error aId is not nullable
        refs: { a: { fields: ['aId'], to: 'a', onDelete: 'setNull' } },
      },
    });
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'] },
      b: {
        key: ['id'],
        // @ts-expect-error aId is not nullable
        refs: { a: { fields: ['aId'], to: 'a', onDelete: 'cascade', onUpdate: 'setNull' } },
      },
    });
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'], unique: [['tenantId', 'code']] },
      b: {
        key: ['id'],
        refs: {
          a: {
            fields: ['tenantId', 'aCode'],
            to: 'a',
            references: ['tenantId', 'code'],
            // @ts-expect-error tenantId is not nullable
            onDelete: 'setNull',
          },
        },
      },
    });
  });

  test('unknown options are rejected', () => {
    createDb<{ a: A; b: B }>()({
      a: { key: ['id'] },
      b: {
        key: ['id'],
        // @ts-expect-error typo in inverse
        refs: { a: { fields: ['aId'], to: 'a', onDelete: 'cascade', invers: 'bs' } },
      },
    });
  });
});
