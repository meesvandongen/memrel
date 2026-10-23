import { describe, expect, test } from 'vitest';
import { createDb, MemrelError } from '../src/index.ts';
import { seededDb } from './schema.ts';

describe('get', () => {
  test('finds rows by simple and composite keys', () => {
    const db = seededDb();
    expect(db.user.get({ id: 'u1' })).toEqual({ id: 'u1', email: 'ann@example.com', name: 'Ann' });
    expect(db.orgUser.get({ orgId: 1, userId: 'u2' })).toEqual({
      orgId: 1,
      userId: 'u2',
      role: 'member',
    });
    expect(db.user.get({ id: 'nope' })).toBeUndefined();
  });

  test('keeps value types apart', () => {
    const db = createDb<{ thing: { id: string | number } }>()({ thing: { key: ['id'] } });
    db.thing.insert([{ id: 1 }, { id: '1' }]);
    expect(db.thing.get({ id: 1 })).toEqual({ id: 1 });
    expect(db.thing.get({ id: '1' })).toEqual({ id: '1' });
    expect(db.thing.where({})).toHaveLength(2);
  });
});

describe('where', () => {
  test('empty conditions return every row in insertion order', () => {
    const db = seededDb();
    expect(db.post.where({}).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  test('uses foreign keys, indexes and keys', () => {
    const db = seededDb();
    expect(db.post.where({ authorId: 'u1' }).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(db.post.where({ title: 'Hello' }).map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(db.post.where({ id: 'p2' }).map((p) => p.id)).toEqual(['p2']);
    expect(db.user.where({ email: 'bob@example.com' }).map((u) => u.id)).toEqual(['u2']);
    expect(db.orgUser.where({ orgId: 1 })).toHaveLength(2);
  });

  test('combines several conditions', () => {
    const db = seededDb();
    expect(db.post.where({ authorId: 'u1', title: 'Hello' }).map((p) => p.id)).toEqual(['p1']);
    expect(db.post.where({ authorId: 'u2', title: 'Zod tips' })).toEqual([]);
    expect(db.orgUser.where({ orgId: 1, role: 'admin' }).map((m) => m.userId)).toEqual(['u1']);
  });

  test('supports in', () => {
    const db = seededDb();
    expect(db.post.where({ authorId: { in: ['u1', 'u2'] } }).map((p) => p.id)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
    expect(db.post.where({ id: { in: ['p3', 'p1', 'p3'] } }).map((p) => p.id)).toEqual([
      'p1',
      'p3',
    ]);
    expect(
      db.orgUserPermission.where({ memberOrgId: { in: [1, 2] }, memberUserId: 'u1' }),
    ).toHaveLength(3);
    expect(db.post.where({ authorId: { in: [] } })).toEqual([]);
  });

  test('scans fields without an index', () => {
    const db = seededDb();
    expect(db.user.where({ name: 'Ann' }).map((u) => u.id)).toEqual(['u1']);
    expect(db.orgUser.where({ role: { in: ['admin'] } })).toHaveLength(1);
  });

  test('ignores undefined conditions', () => {
    const db = seededDb();
    expect(db.post.where({ authorId: undefined })).toHaveLength(3);
  });

  test('matches nulls, which unique and foreign key indexes leave out', () => {
    type Item = { id: string; parentId: string | null; code: string | null };
    const db = createDb<{ item: Item }>()({
      item: {
        key: ['id'],
        unique: [['code']],
        refs: { parent: { fields: ['parentId'], to: 'item', onDelete: 'setNull' } },
      },
    });
    db.item.insert([
      { id: 'a', parentId: null, code: null },
      { id: 'b', parentId: 'a', code: 'B' },
      { id: 'c', parentId: null, code: null },
    ]);
    expect(db.item.where({ parentId: null }).map((i) => i.id)).toEqual(['a', 'c']);
    expect(db.item.where({ code: null }).map((i) => i.id)).toEqual(['a', 'c']);
    expect(db.item.where({ parentId: { in: [null, 'a'] } }).map((i) => i.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('returns fresh arrays', () => {
    const db = seededDb();
    const a = db.post.where({});
    expect(db.post.where({})).not.toBe(a);
    db.post.insert({ id: 'p4', authorId: 'u1', title: 'New' });
    expect(a).toHaveLength(3);
  });

  test('keeps insertion order after updates move rows between buckets', () => {
    const db = seededDb();
    db.post.update({ id: 'p1' }, { authorId: 'u2' });
    db.post.update({ id: 'p1' }, { authorId: 'u1' });
    expect(db.post.where({ authorId: 'u1' }).map((p) => p.id)).toEqual(['p1', 'p2']);
    db.org.update({ id: 1 }, { id: 0 });
    expect(db.org.where({}).map((o) => o.id)).toEqual([0, 2]);
    expect(db.orgUser.where({}).map((m) => m.orgId)).toEqual([0, 0, 2]);
  });
});

describe('rel', () => {
  test('forward refs return the target row', () => {
    const db = seededDb();
    const post = db.post.get({ id: 'p1' })!;
    expect(db.post.rel(post, 'author')).toBe(db.user.get({ id: 'u1' }));
    expect(db.orgUserPermission.rel(db.orgUserPermission.where({})[0]!, 'membership')).toEqual({
      orgId: 1,
      userId: 'u1',
      role: 'admin',
    });
  });

  test('inverses return referencing rows', () => {
    const db = seededDb();
    const ann = db.user.get({ id: 'u1' })!;
    expect(db.user.rel(ann, 'posts').map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(db.user.rel(ann, 'memberships').map((m) => m.orgId)).toEqual([1, 2]);
    expect(db.org.rel({ id: 1 }, 'members').map((m) => m.userId)).toEqual(['u1', 'u2']);
    expect(
      db.orgUser.rel({ orgId: 1, userId: 'u1' }, 'permissions').map((p) => p.permission),
    ).toEqual(['billing', 'admin']);
    expect(db.user.rel({ id: 'nobody' }, 'posts')).toEqual([]);
  });

  test('accepts a key and reads foreign keys from the stored row', () => {
    const db = seededDb();
    expect(db.post.rel({ id: 'p3' }, 'author').id).toBe('u2');
    expect(() => db.post.rel({ id: 'nope' }, 'author')).toThrow(MemrelError);
  });

  test('null foreign keys and single inverses', () => {
    type Account = { id: string };
    type Profile = { accountId: string; bio: string };
    type Item = { id: string; parentId: string | null };
    const db = createDb<{ account: Account; profile: Profile; item: Item }>()({
      account: { key: ['id'] },
      profile: {
        key: ['accountId'],
        refs: {
          account: {
            fields: ['accountId'],
            to: 'account',
            onDelete: 'cascade',
            inverse: 'profile',
          },
        },
      },
      item: {
        key: ['id'],
        refs: {
          parent: { fields: ['parentId'], to: 'item', onDelete: 'cascade', inverse: 'children' },
        },
      },
    });
    db.load({
      account: [{ id: 'a' }, { id: 'b' }],
      profile: [{ accountId: 'a', bio: 'hi' }],
      item: [
        { id: 'root', parentId: null },
        { id: 'leaf', parentId: 'root' },
      ],
    });
    expect(db.account.rel({ id: 'a' }, 'profile')).toEqual({ accountId: 'a', bio: 'hi' });
    expect(db.account.rel({ id: 'b' }, 'profile')).toBeUndefined();
    expect(db.item.rel({ id: 'root' }, 'parent')).toBeNull();
    expect(db.item.rel({ id: 'leaf' }, 'parent')?.id).toBe('root');
    expect(db.item.rel({ id: 'root' }, 'children').map((i) => i.id)).toEqual(['leaf']);
  });

  test('refs to unique keys', () => {
    type User = { id: string; handle: string };
    type Mention = { id: string; handle: string };
    const db = createDb<{ user: User; mention: Mention }>()({
      user: { key: ['id'], unique: [['handle']] },
      mention: {
        key: ['id'],
        refs: {
          user: {
            fields: ['handle'],
            to: 'user',
            references: ['handle'],
            onDelete: 'cascade',
            onUpdate: 'cascade',
            inverse: 'mentions',
          },
        },
      },
    });
    db.load({ user: [{ id: 'u1', handle: 'ann' }], mention: [{ id: 'm1', handle: 'ann' }] });
    expect(db.mention.rel({ id: 'm1' }, 'user').id).toBe('u1');
    expect(db.user.rel({ id: 'u1' }, 'mentions').map((m) => m.id)).toEqual(['m1']);
    expect(db.mention.where({ handle: 'ann' })).toHaveLength(1);
  });

  test('unknown relation names throw', () => {
    const db = seededDb();
    expect(() => db.user.rel({ id: 'u1' }, 'nope' as never)).toThrow(
      "'nope' is not a relation of user; expected one of: memberships, posts",
    );
  });
});
