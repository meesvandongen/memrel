import { describe, expect, test } from 'vitest';
import { displayKey, encodeFields, encodeValue } from '../src/encode.ts';
import { createDb } from '../src/index.ts';

describe('encodeValue', () => {
  test('keeps value types apart', () => {
    const values = [1, '1', true, 'true', 1n, null, undefined, 'null', new Date(1), {}, []];
    const encoded = values.map(encodeValue);
    expect(new Set(encoded).size).toBe(values.length);
  });

  test('is stable for equal values', () => {
    expect(encodeValue(new Date(5))).toBe(encodeValue(new Date(5)));
    expect(encodeValue(Number.NaN)).toBe(encodeValue(Number.NaN));
    expect(encodeValue(false)).toBe('b:0');
    const obj = {};
    expect(encodeValue(obj)).toBe(encodeValue(obj));
    expect(encodeValue({})).not.toBe(encodeValue({}));
    const sym = Symbol('s');
    expect(encodeValue(sym)).toBe(encodeValue(sym));
    expect(encodeValue(sym)).not.toBe(encodeValue(Symbol('s')));
  });

  test('tuples are unambiguous', () => {
    expect(encodeFields({ a: 'x","s:y', b: 'z' }, ['a', 'b'])).not.toBe(
      encodeFields({ a: 'x', b: 'y","s:z' }, ['a', 'b']),
    );
  });
});

describe('displayKey', () => {
  test('renders keys for messages', () => {
    expect(
      displayKey({ a: 1, b: 'x', c: 2n, d: new Date(0), e: undefined, f: null }, [
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
      ]),
    ).toBe('[1,"x",2n,1970-01-01T00:00:00.000Z,undefined,null]');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(displayKey({ k: cyclic }, ['k'])).toBe('[[object Object]]');
  });
});

describe('keys of other types', () => {
  test('dates, booleans and bigints work as keys', () => {
    type Event = { day: Date; open: boolean; seq: bigint };
    const db = createDb<{ event: Event }>()({ event: { key: ['day', 'open', 'seq'] } });
    db.event.insert({ day: new Date('2026-01-01'), open: true, seq: 1n });
    expect(db.event.get({ day: new Date('2026-01-01'), open: true, seq: 1n })).toBeDefined();
    expect(db.event.get({ day: new Date('2026-01-02'), open: true, seq: 1n })).toBeUndefined();
  });
});
