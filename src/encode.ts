/**
 * Key encoding.
 *
 * Every index is a `Map` keyed by an encoded tuple of field values. The encoding keeps value
 * types apart, so `1` and `'1'` never collide, and the same encoder is used for primary keys,
 * unique keys, foreign keys and secondary indexes. That is what lets a child's foreign key tuple
 * be used directly as a lookup into its target's index.
 */

const objectIds = new WeakMap<object, number>();
const symbolIds = new Map<symbol, number>();
let nextObjectId = 0;

/** Encodes one value. Objects other than dates compare by identity. */
export function encodeValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return `s:${value}`;
    case 'number':
      return `n:${value}`;
    case 'boolean':
      return value ? 'b:1' : 'b:0';
    case 'bigint':
      return `i:${value}`;
    case 'undefined':
      return 'u';
    case 'symbol': {
      let id = symbolIds.get(value);
      if (id === undefined) {
        id = nextObjectId++;
        symbolIds.set(value, id);
      }
      return `y:${id}`;
    }
    default: {
      if (value === null) return 'z';
      if (value instanceof Date) return `d:${value.getTime()}`;
      let id = objectIds.get(value as object);
      if (id === undefined) {
        id = nextObjectId++;
        objectIds.set(value as object, id);
      }
      return `o:${id}`;
    }
  }
}

/** Encodes the values of `fields` in `row`, in order. */
export function encodeFields(row: object, fields: readonly string[]): string {
  const r = row as Record<string, unknown>;
  if (fields.length === 1) return encodeValue(r[fields[0]!]);
  let out = '[';
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) out += ',';
    out += JSON.stringify(encodeValue(r[fields[i]!]));
  }
  return `${out}]`;
}

/** Readable form of a row's key, for error messages: `["u1"]`, `[1,"u1"]`. */
export function displayKey(row: object, fields: readonly string[]): string {
  const r = row as Record<string, unknown>;
  return `[${fields.map((f) => displayValue(r[f])).join(',')}]`;
}

function displayValue(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
