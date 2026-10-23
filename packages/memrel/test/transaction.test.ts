import { beforeEach, describe, expect, test } from 'vite-plus/test';
import { MemrelError } from '../src/index.ts';
import { makeDb, seededDb } from './schema.ts';

describe('transaction', () => {
  test('commits when the callback returns', () => {
    const db = seededDb();
    const result = db.transaction(() => {
      db.user.insert({ id: 'u3', email: 'cy@x', name: 'Cy' });
      db.post.update({ id: 'p1' }, { authorId: 'u3' });
      return 'done';
    });
    expect(result).toBe('done');
    expect(db.user.rel({ id: 'u3' }, 'posts')).toHaveLength(1);
  });

  test('rolls back everything when the callback throws', () => {
    const db = seededDb();
    const before = db.snapshot();
    const users = db.user.where({});
    expect(() =>
      db.transaction(() => {
        db.user.insert({ id: 'u3', email: 'cy@x', name: 'Cy' });
        db.post.delete(db.post.where({ authorId: 'u1' }));
        db.user.delete({ id: 'u1' });
        db.org.update({ id: 2 }, { id: 20 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.user.where({})).toEqual(users);
    expect(db.org.get({ id: 2 })).toBeDefined();
    expect(db.orgUserPermission.where({ memberOrgId: 2 })).toHaveLength(1);
    expect(db.post.where({ authorId: 'u1' }).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(db.user.where({ email: 'ann@example.com' })).toHaveLength(1);

    const after = db.snapshot();
    db.restore(before);
    expect(db.orgUser.where({})).toEqual(seededDb().orgUser.where({}));
    db.restore(after);
  });

  test('nested transactions roll back to where they started', () => {
    const db = seededDb();
    db.transaction(() => {
      db.user.insert({ id: 'u3', email: 'cy@x', name: 'Cy' });
      try {
        db.transaction(() => {
          db.user.insert({ id: 'u4', email: 'di@x', name: 'Di' });
          throw new Error('inner');
        });
      } catch {}
    });
    expect(db.user.get({ id: 'u3' })).toBeDefined();
    expect(db.user.get({ id: 'u4' })).toBeUndefined();
  });

  test('a failed write inside a transaction leaves earlier writes alone', () => {
    const db = seededDb();
    db.transaction(() => {
      db.user.insert({ id: 'u3', email: 'cy@x', name: 'Cy' });
      expect(() => db.user.insert({ id: 'u3', email: 'x@x', name: 'X' })).toThrow(MemrelError);
    });
    expect(db.user.get({ id: 'u3' })?.name).toBe('Cy');
  });

  test('rejects async callbacks and rolls them back', () => {
    const db = seededDb();
    expect(() =>
      db.transaction(async () => {
        db.user.insert({ id: 'u3', email: 'cy@x', name: 'Cy' });
      }),
    ).toThrow('Transaction callbacks must be synchronous');
    expect(db.user.get({ id: 'u3' })).toBeUndefined();
  });
});

describe('snapshot and restore', () => {
  const db = makeDb();
  db.load({ user: [{ id: 'u1', email: 'a@x', name: 'Ann' }] });
  const seeded = db.snapshot();
  beforeEach(() => db.restore(seeded));

  test('a test changes the data', () => {
    db.user.insert({ id: 'u2', email: 'b@x', name: 'Bob' });
    db.user.update({ id: 'u1' }, { name: 'Changed' });
    expect(db.user.where({})).toHaveLength(2);
  });

  test('the next test starts from the seed again', () => {
    expect(db.user.where({})).toEqual([{ id: 'u1', email: 'a@x', name: 'Ann' }]);
    expect(db.user.where({ email: 'b@x' })).toEqual([]);
    expect(() => db.user.insert({ id: 'u2', email: 'a@x', name: 'Dup' })).toThrow(MemrelError);
  });

  test('restore inside a rolled-back transaction is undone', () => {
    db.user.insert({ id: 'u2', email: 'b@x', name: 'Bob' });
    expect(() =>
      db.transaction(() => {
        db.restore(seeded);
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(db.user.get({ id: 'u2' })).toBeDefined();
  });

  test('snapshots belong to their database', () => {
    expect(() => makeDb().restore(seeded)).toThrow('Snapshot was not taken from this database');
  });
});
