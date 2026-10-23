import { describe, expect, test } from 'vitest';
import { createDb, MemrelError } from '../src/index.ts';
import { seededDb } from './schema.ts';

describe('update', () => {
  test('patches a row and returns the new row', () => {
    const db = seededDb();
    const before = db.post.get({ id: 'p1' })!;
    const after = db.post.update({ id: 'p1' }, { title: 'New title' });
    expect(after).toEqual({ id: 'p1', authorId: 'u1', title: 'New title' });
    expect(before.title).toBe('Hello');
    expect(db.post.where({ title: 'Hello' }).map((p) => p.id)).toEqual(['p3']);
    expect(db.post.where({ title: 'New title' }).map((p) => p.id)).toEqual(['p1']);
  });

  test('derives the patch from the current row', () => {
    const db = seededDb();
    db.post.update({ id: 'p2' }, (p) => ({ title: p.title.toUpperCase() }));
    expect(db.post.get({ id: 'p2' })?.title).toBe('ZOD TIPS');
  });

  test('updates several rows with one patch', () => {
    const db = seededDb();
    const rows = db.post.update(db.post.where({ authorId: 'u1' }), { authorId: 'u2' });
    expect(rows.map((p) => p.authorId)).toEqual(['u2', 'u2']);
    expect(db.user.rel({ id: 'u2' }, 'posts').map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(db.user.rel({ id: 'u1' }, 'posts')).toEqual([]);
  });

  test('throws on a missing key without changing anything', () => {
    const db = seededDb();
    expect(() => db.post.update([{ id: 'p1' }, { id: 'nope' }], { title: 'x' })).toThrow(
      'post ["nope"] not found',
    );
    expect(db.post.get({ id: 'p1' })?.title).toBe('Hello');
  });

  test('checks changed foreign keys', () => {
    const db = seededDb();
    expect(() => db.post.update({ id: 'p1' }, { authorId: 'ghost' })).toThrow(
      'post.author references missing user ["ghost"]',
    );
    expect(db.post.get({ id: 'p1' })?.authorId).toBe('u1');
  });

  test('checks unique keys', () => {
    const db = seededDb();
    expect(() => db.user.update({ id: 'u2' }, { email: 'ann@example.com' })).toThrow(MemrelError);
    db.user.update({ id: 'u2' }, { email: 'bobby@example.com' });
    expect(db.user.where({ email: 'bobby@example.com' })).toHaveLength(1);
    expect(db.user.where({ email: 'bob@example.com' })).toHaveLength(0);
  });

  test('re-keys a row and throws on collisions', () => {
    const db = seededDb();
    expect(() => db.org.update({ id: 1 }, { id: 2 })).toThrow(
      'Cannot update org [1]: org [2] already exists',
    );
    db.org.update({ id: 2 }, { id: 3 });
    expect(db.org.get({ id: 2 })).toBeUndefined();
    expect(db.org.get({ id: 3 })?.name).toBe('Globex');
  });

  test('rows in one call can swap keys', () => {
    const db = seededDb();
    db.post.update([{ id: 'p1' }, { id: 'p2' }], (p) => ({ id: p.id === 'p1' ? 'p2' : 'p1' }));
    expect(db.post.get({ id: 'p1' })?.title).toBe('Zod tips');
    expect(db.post.get({ id: 'p2' })?.title).toBe('Hello');
  });

  test('cascades key changes through composite foreign keys', () => {
    const db = seededDb();
    db.org.update({ id: 1 }, { id: 10 });
    expect(db.orgUser.where({ orgId: 10 }).map((m) => m.userId)).toEqual(['u1', 'u2']);
    expect(db.orgUserPermission.where({ memberOrgId: 10 })).toHaveLength(3);
    expect(db.orgUserPermission.where({ memberOrgId: 1 })).toEqual([]);
    expect(db.orgUser.rel({ orgId: 10, userId: 'u1' }, 'permissions')).toHaveLength(2);
  });

  test('restrict blocks key changes while children point at the old values', () => {
    const db = seededDb();
    expect(() => db.user.update({ id: 'u1' }, { id: 'u9' })).toThrow(
      'Cannot update user ["u1"]: restricted by 2 rows in post.author',
    );
    expect(db.user.get({ id: 'u1' })).toBeDefined();
    expect(db.orgUser.where({ userId: 'u1' })).toHaveLength(2);

    // Moving the posts first lets the cascade through orgUser and orgUserPermission run.
    db.post.update(db.post.where({ authorId: 'u1' }), { authorId: 'u2' });
    db.user.update({ id: 'u1' }, { id: 'u9' });
    expect(db.orgUser.where({ userId: 'u9' })).toHaveLength(2);
    expect(db.orgUserPermission.where({ memberUserId: 'u9' })).toHaveLength(3);
  });

  test('setNull clears children on key changes', () => {
    type Folder = { id: string; parentId: string | null };
    const db = createDb<{ folder: Folder }>()({
      folder: {
        key: ['id'],
        refs: {
          parent: {
            fields: ['parentId'],
            to: 'folder',
            onDelete: 'cascade',
            onUpdate: 'setNull',
            inverse: 'children',
          },
        },
      },
    });
    db.folder.insert([
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ]);
    db.folder.update({ id: 'a' }, { id: 'z' });
    expect(db.folder.get({ id: 'b' })?.parentId).toBeNull();
  });

  test('cascades key changes to refs targeting unique keys', () => {
    type Team = { id: number; slug: string };
    type Link = { id: number; teamSlug: string };
    const db = createDb<{ team: Team; link: Link }>()({
      team: { key: ['id'], unique: [['slug']] },
      link: {
        key: ['id'],
        refs: {
          team: {
            fields: ['teamSlug'],
            to: 'team',
            references: ['slug'],
            onDelete: 'cascade',
            onUpdate: 'cascade',
          },
        },
      },
    });
    db.load({ team: [{ id: 1, slug: 'red' }], link: [{ id: 1, teamSlug: 'red' }] });
    db.team.update({ id: 1 }, { slug: 'blue' });
    expect(db.link.get({ id: 1 })?.teamSlug).toBe('blue');
  });

  test('cascades through self-references', () => {
    type Node = { id: number; parentId: number | null };
    const db = createDb<{ node: Node }>()({
      node: {
        key: ['id'],
        refs: {
          parent: { fields: ['parentId'], to: 'node', onDelete: 'cascade', onUpdate: 'cascade' },
        },
      },
    });
    db.node.insert([
      { id: 1, parentId: 1 },
      { id: 2, parentId: 1 },
    ]);
    db.node.update({ id: 1 }, { id: 5 });
    expect(db.node.where({}).map((n) => [n.id, n.parentId])).toEqual([
      [5, 5],
      [2, 5],
    ]);
  });
});
