import { describe, expect, test } from 'vitest';
import { createDb, MemrelError } from '../src/index.ts';
import { seededDb } from './schema.ts';

describe('delete', () => {
  test('removes a row and returns it', () => {
    const db = seededDb();
    const result = db.post.delete({ id: 'p1' });
    expect(result).toEqual({
      deleted: { post: [{ id: 'p1', authorId: 'u1', title: 'Hello' }] },
      nulled: {},
    });
    expect(db.post.get({ id: 'p1' })).toBeUndefined();
    expect(db.post.where({ title: 'Hello' }).map((p) => p.id)).toEqual(['p3']);
    expect(db.user.rel({ id: 'u1' }, 'posts').map((p) => p.id)).toEqual(['p2']);
  });

  test('restrict blocks the delete and names the blocking ref', () => {
    const db = seededDb();
    expect(() => db.user.delete({ id: 'u1' })).toThrow(
      'Cannot delete user ["u1"]: restricted by 2 rows in post.author',
    );
    expect(db.user.get({ id: 'u1' })).toBeDefined();
    expect(db.orgUser.where({ userId: 'u1' })).toHaveLength(2);
  });

  test('cascades through composite foreign keys once restrict is satisfied', () => {
    const db = seededDb();
    db.post.delete(db.post.where({ authorId: 'u1' }));
    const result = db.user.delete({ id: 'u1' });
    expect(result.deleted.user).toHaveLength(1);
    expect(result.deleted.orgUser?.map((m) => m.orgId)).toEqual([1, 2]);
    expect(result.deleted.orgUserPermission?.map((p) => p.permission)).toEqual([
      'billing',
      'admin',
      'read',
    ]);
    expect(db.orgUserPermission.where({})).toEqual([
      { memberOrgId: 1, memberUserId: 'u2', permission: 'read' },
    ]);
  });

  test('restrict is checked against the whole plan', () => {
    const db = seededDb();
    const result = db.remove({ user: [{ id: 'u1' }], post: [{ id: 'p1' }, { id: 'p2' }] });
    expect(result.deleted.post).toHaveLength(2);
    expect(db.user.get({ id: 'u1' })).toBeUndefined();
  });

  test('deletes several keys of one collection together', () => {
    const db = seededDb();
    db.post.delete([{ id: 'p1' }, { id: 'p2' }, { id: 'p1' }]);
    expect(db.post.where({}).map((p) => p.id)).toEqual(['p3']);
  });

  test('a missing key throws and changes nothing', () => {
    const db = seededDb();
    let error: unknown;
    try {
      db.post.delete([{ id: 'p1' }, { id: 'nope' }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MemrelError);
    expect((error as MemrelError).code).toBe('NOT_FOUND');
    expect(db.post.where({})).toHaveLength(3);
  });

  test('setNull clears referencing rows and reports them', () => {
    type Folder = { id: string; parentId: string | null };
    const db = createDb<{ folder: Folder }>()({
      folder: {
        key: ['id'],
        refs: { parent: { fields: ['parentId'], to: 'folder', onDelete: 'setNull' } },
      },
    });
    db.folder.insert([
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'a' },
    ]);
    const result = db.folder.delete({ id: 'a' });
    expect(result.nulled.folder).toEqual([
      { id: 'b', parentId: null },
      { id: 'c', parentId: null },
    ]);
    expect(db.folder.where({ parentId: null })).toHaveLength(2);
  });

  test('setNullFields clears only part of a composite foreign key', () => {
    type Category = { tenantId: number; id: string };
    type Product = { tenantId: number; id: string; categoryId: string | null };
    const db = createDb<{ category: Category; product: Product }>()({
      category: { key: ['tenantId', 'id'] },
      product: {
        key: ['tenantId', 'id'],
        refs: {
          category: {
            fields: ['tenantId', 'categoryId'],
            to: 'category',
            references: ['tenantId', 'id'],
            onDelete: 'setNull',
            setNullFields: ['categoryId'],
            inverse: 'products',
          },
        },
      },
    });
    db.load({
      category: [{ tenantId: 1, id: 'shoes' }],
      product: [{ tenantId: 1, id: 'p1', categoryId: 'shoes' }],
    });
    db.category.delete({ tenantId: 1, id: 'shoes' });
    expect(db.product.get({ tenantId: 1, id: 'p1' })).toEqual({
      tenantId: 1,
      id: 'p1',
      categoryId: null,
    });
    expect(db.product.rel({ tenantId: 1, id: 'p1' }, 'category')).toBeNull();
  });

  test('cycles terminate', () => {
    type Node = { id: number; nextId: number };
    const db = createDb<{ node: Node }>()({
      node: {
        key: ['id'],
        refs: { next: { fields: ['nextId'], to: 'node', onDelete: 'cascade' } },
      },
    });
    db.node.insert([
      { id: 1, nextId: 2 },
      { id: 2, nextId: 3 },
      { id: 3, nextId: 1 },
      { id: 4, nextId: 4 },
    ]);
    expect(db.node.delete({ id: 1 }).deleted.node?.map((n) => n.id)).toEqual([1, 3, 2]);
    expect(db.node.where({}).map((n) => n.id)).toEqual([4]);
  });
});
