/**
 * What went wrong, as a stable machine-readable code.
 *
 * - `INVALID_SCHEMA`: the config passed to `createDb` is inconsistent.
 * - `DUPLICATE_KEY`: a primary key is already taken.
 * - `UNIQUE_VIOLATION`: a `unique` key is already taken.
 * - `FOREIGN_KEY_VIOLATION`: a reference points at a row that doesn't exist, or is partly null.
 * - `RESTRICT_VIOLATION`: a delete or key change is blocked by a `restrict` rule.
 * - `NOT_FOUND`: a key passed to `update`, `delete` or `rel` doesn't exist.
 * - `INVALID_ARGUMENT`: an argument has the wrong shape, such as an unknown relation name.
 */
export type MemrelErrorCode =
  | 'INVALID_SCHEMA'
  | 'DUPLICATE_KEY'
  | 'UNIQUE_VIOLATION'
  | 'FOREIGN_KEY_VIOLATION'
  | 'RESTRICT_VIOLATION'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT';

/** Every error memrel throws on purpose is a `MemrelError`. */
export class MemrelError extends Error {
  override readonly name = 'MemrelError';
  readonly code: MemrelErrorCode;

  constructor(code: MemrelErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
