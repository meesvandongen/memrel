import { describe, expect, test } from 'vitest';
import { MemrelError } from '../src/index.ts';
import { makeDb, seededDb } from './schema.ts';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemrelError) return error.code;
    throw error;
  }
  return undefined;
}

describe('insert', () => {
  test('stores a copy of the row and returns it', () => {
    const db = makeDb();
    const input = { id: 'u1', email: 'a@x', name: 'Ann' };
    const stored = db.user.insert(input);
    expect(stored).toEqual(input);
    expect(stored).not.toBe(input);
    input.name = 'changed';
    expect(db.user.get({ id: 'u1' })?.name).toBe('Ann');
  });

  test('batches may reference rows later in the batch', () => {
    const db = makeDb();
    db.post.insert([]);
    db.load({
      post: [{ id: 'p1', authorId: 'u1', title: 'A' }],
      user: [{ id: 'u1', email: 'a@x', name: 'Ann' }],
    });
    expect(db.post.rel({ id: 'p1' }, 'author').name).toBe('Ann');
  });

  test('rejects duplicate primary keys', () => {
    const db = seededDb();
    expect(() => db.user.insert({ id: 'u1', email: 'new@x', name: 'X' })).toThrow(
      'user ["u1"] already exists',
    );
    expect(
      code(() =>
        db.org.insert([
          { id: 9, name: 'a' },
          { id: 9, name: 'b' },
        ]),
      ),
    ).toBe('DUPLICATE_KEY');
    expect(db.org.get({ id: 9 })).toBeUndefined();
  });

  test('rejects unique conflicts, also within a batch', () => {
    const db = seededDb();
    expect(() => db.user.insert({ id: 'u3', email: 'ann@example.com', name: 'X' })).toThrow(
      'user ["u3"]: unique key (email) ["ann@example.com"] is already taken by user ["u1"]',
    );
    expect(
      code(() =>
        db.user.insert([
          { id: 'u3', email: 'same@x', name: 'X' },
          { id: 'u4', email: 'same@x', name: 'Y' },
        ]),
      ),
    ).toBe('UNIQUE_VIOLATION');
    expect(db.user.get({ id: 'u3' })).toBeUndefined();
  });

  test('rejects dangling references and rolls back the whole batch', () => {
    const db = seededDb();
    expect(() =>
      db.post.insert([
        { id: 'p8', authorId: 'u1', title: 'ok' },
        { id: 'p9', authorId: 'ghost', title: 'bad' },
      ]),
    ).toThrow('post ["p9"]: post.author references missing user ["ghost"]');
    expect(db.post.get({ id: 'p8' })).toBeUndefined();
    expect(db.post.where({ authorId: 'u1' })).toHaveLength(2);
  });

  test('onConflict: ignore keeps existing rows and adds new ones', () => {
    const db = seededDb();
    const rows = db.user.insert(
      [
        { id: 'u1', email: 'other@x', name: 'Other' },
        { id: 'u3', email: 'cy@x', name: 'Cy' },
      ],
      { onConflict: 'ignore' },
    );
    expect(rows.map((u) => u.name)).toEqual(['Ann', 'Cy']);
  });

  test('onConflict: replace replaces the whole row without cascading deletes', () => {
    const db = seededDb();
    const row = db.user.insert(
      { id: 'u1', email: 'ann@new.com', name: 'Ann B' },
      { onConflict: 'replace' },
    );
    expect(row).toEqual({ id: 'u1', email: 'ann@new.com', name: 'Ann B' });
    expect(db.user.where({ email: 'ann@example.com' })).toEqual([]);
    expect(db.user.rel(row, 'posts')).toHaveLength(2);
    expect(db.user.rel(row, 'memberships')).toHaveLength(2);
  });

  test('unique conflicts throw even with onConflict', () => {
    const db = seededDb();
    expect(
      code(() =>
        db.user.insert({ id: 'u3', email: 'bob@example.com', name: 'X' }, { onConflict: 'ignore' }),
      ),
    ).toBe('UNIQUE_VIOLATION');
  });

  test('partly null composite foreign keys are rejected', () => {
    const db = seededDb();
    expect(() =>
      db.orgUserPermission.insert({
        memberOrgId: 1,
        memberUserId: null as unknown as string,
        permission: 'x',
      }),
    ).toThrow('is partly null');
  });
});

describe('load', () => {
  test('inserts across collections in any order', () => {
    const db = seededDb();
    expect(db.user.where({})).toHaveLength(2);
    expect(db.orgUserPermission.where({})).toHaveLength(4);
  });

  test('is atomic', () => {
    const db = makeDb();
    expect(() =>
      db.load({
        user: [{ id: 'u1', email: 'a@x', name: 'Ann' }],
        post: [{ id: 'p1', authorId: 'u2', title: 'A' }],
      }),
    ).toThrow(MemrelError);
    expect(db.user.where({})).toEqual([]);
  });

  test('honours onConflict', () => {
    const db = seededDb();
    db.load({ user: [{ id: 'u1', email: 'x@x', name: 'X' }] }, { onConflict: 'ignore' });
    expect(db.user.get({ id: 'u1' })?.name).toBe('Ann');
    db.load({ user: [{ id: 'u1', email: 'x@x', name: 'X' }] }, { onConflict: 'replace' });
    expect(db.user.get({ id: 'u1' })?.name).toBe('X');
  });
});
