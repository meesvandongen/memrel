import { describe, expect, test } from 'vite-plus/test';
import { createDb, MemrelError } from '../src/index.ts';

// Runtime validation catches what slips past the types, e.g. configs built from `any`.
const define = createDb<any>() as (config: unknown) => unknown;

function schemaError(config: unknown): string {
  let error: unknown;
  try {
    define(config);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(MemrelError);
  expect((error as MemrelError).code).toBe('INVALID_SCHEMA');
  return (error as MemrelError).message;
}

describe('schema validation', () => {
  test('keys must be non-empty field lists without repeats', () => {
    expect(schemaError({ a: {} })).toBe('a.key must be a non-empty array of field names');
    expect(schemaError({ a: { key: [] } })).toBe('a.key must be a non-empty array of field names');
    expect(schemaError({ a: { key: ['id', 'id'] } })).toBe('a.key contains a field twice');
    expect(schemaError({ a: { key: ['id'], unique: [[]] } })).toContain('a.unique[0]');
  });

  test('unknown options and reserved names', () => {
    expect(schemaError({ a: { key: ['id'], keys: [] } })).toBe("a: unknown option 'keys'");
    expect(schemaError({ load: { key: ['id'] } })).toContain("'load' is reserved");
  });

  test('refs must target a collection key or unique key', () => {
    const a = { key: ['id'], unique: [['code']] };
    expect(
      schemaError({
        a,
        b: { key: ['id'], refs: { r: { fields: ['x'], to: 'c', onDelete: 'cascade' } } },
      }),
    ).toBe('b.r.to must name a collection');
    expect(
      schemaError({
        a,
        b: {
          key: ['id'],
          refs: { r: { fields: ['x'], to: 'a', references: ['name'], onDelete: 'cascade' } },
        },
      }),
    ).toBe("b.r: 'references' must be the key or a unique key of 'a', in order");
    expect(
      schemaError({
        a,
        b: {
          key: ['id'],
          refs: { r: { fields: ['x', 'y'], to: 'a', references: ['id'], onDelete: 'cascade' } },
        },
      }),
    ).toBe("b.r: 'fields' and 'references' must have the same length");
    expect(
      schemaError({
        a: { key: ['x', 'y'] },
        b: { key: ['id'], refs: { r: { fields: ['x', 'y'], to: 'a', onDelete: 'cascade' } } },
      }),
    ).toBe("b.r: composite foreign keys need explicit 'references'");
  });

  test('actions must be known', () => {
    expect(
      schemaError({
        a: { key: ['id'] },
        b: { key: ['id'], refs: { r: { fields: ['x'], to: 'a' } } },
      }),
    ).toContain('b.r.onDelete must be one of');
    expect(
      schemaError({
        a: { key: ['id'] },
        b: {
          key: ['id'],
          refs: { r: { fields: ['x'], to: 'a', onDelete: 'cascade', onUpdate: 'nope' } },
        },
      }),
    ).toContain('b.r.onUpdate must be one of');
  });

  test('inverse names must not collide', () => {
    expect(
      schemaError({
        a: { key: ['id'] },
        b: {
          key: ['id'],
          refs: {
            r: { fields: ['x'], to: 'a', onDelete: 'cascade', inverse: 'bs' },
            s: { fields: ['y'], to: 'a', onDelete: 'cascade', inverse: 'bs' },
          },
        },
      }),
    ).toBe("b.s: inverse 'bs' is already a relation of 'a'");
  });

  test('setNull must not leave an overlapping foreign key partly null', () => {
    const config = (setNullFields?: string[]) => ({
      tenant: { key: ['id'] },
      parent: { key: ['tenantId', 'id'] },
      child: {
        key: ['id'],
        refs: {
          tenant: { fields: ['tenantId'], to: 'tenant', onDelete: 'cascade' },
          parent: {
            fields: ['tenantId', 'parentId'],
            to: 'parent',
            references: ['tenantId', 'id'],
            onDelete: 'setNull',
            setNullFields,
          },
        },
      },
    });
    expect(schemaError(config())).toBe(
      "child.parent: setNull would clear a column child.tenant shares; use 'setNullFields' to clear only the others",
    );
    expect(() => define(config(['parentId']))).not.toThrow();
  });
});
