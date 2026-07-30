/**
 * Key encoding for flattened JSON paths.
 *
 * A flattened key must be a *lossless* rendering of a structural path so that
 * `rebuildTree` can put every translated string back exactly where it came
 * from. Real locale files contain keys with dots ("app.name" used as a literal
 * key), brackets ("items[]"), and even backslashes, so a naive
 * `path.join(".")` is ambiguous and silently corrupts output.
 *
 * Grammar:
 *   key     := segment? ( '.' segment | '[' digits ']' )*
 *   segment := any characters, with `\` `.` `[` `]` backslash-escaped
 *
 * `.` is a *prefix* separator introducing an object segment; `[n]` is an array
 * index. Because only base-10 digits may appear between brackets, `a.0`
 * (object key "0") and `a[0]` (array index 0) stay distinguishable and
 * `decodeKey` recovers the original `string | number` segment types.
 */

const ESCAPE_RE = /[\\.[\]]/g;

function escapeSegment(segment: string): string {
  return segment.replace(ESCAPE_RE, (c) => `\\${c}`);
}

/**
 * Render a structural path as a stable, human-readable, round-trippable key.
 *
 * The empty path encodes to `""`, which `decodeKey` reads back as `[""]`. That
 * degenerate case cannot occur in practice (there is no string to translate at
 * the root of a document) and is deliberately outside the round-trip contract.
 */
export function encodeKey(path: ReadonlyArray<string | number>): string {
  let out = "";
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (typeof segment === "string") {
      out += i === 0 ? escapeSegment(segment) : `.${escapeSegment(segment)}`;
    }
  }
  return out;
}

export class KeyDecodeError extends Error {
  readonly key: string;
  readonly offset: number;

  constructor(key: string, offset: number, message: string) {
    super(`${message} (in key ${JSON.stringify(key)} at offset ${offset})`);
    this.name = "KeyDecodeError";
    this.key = key;
    this.offset = offset;
  }
}

/**
 * Inverse of {@link encodeKey}. Throws {@link KeyDecodeError} on malformed
 * input rather than guessing: a silently mis-decoded key would write a
 * translation into the wrong slot of the output document.
 */
export function decodeKey(key: string): Array<string | number> {
  const path: Array<string | number> = [];
  let buffer = "";
  // A key that does not open with an array index starts inside an object
  // segment (possibly the empty-string key).
  let inSegment = !key.startsWith("[");
  let i = 0;

  const flush = (): void => {
    path.push(buffer);
    buffer = "";
    inSegment = false;
  };

  while (i < key.length) {
    const ch = key[i];
    if (ch === "\\") {
      const next = key[i + 1];
      if (next === undefined) {
        throw new KeyDecodeError(key, i, "Dangling escape character");
      }
      buffer += next;
      inSegment = true;
      i += 2;
      continue;
    }
    if (ch === ".") {
      if (inSegment) flush();
      inSegment = true;
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (inSegment) flush();
      const end = key.indexOf("]", i + 1);
      if (end < 0) {
        throw new KeyDecodeError(key, i, "Unterminated array index");
      }
      const digits = key.slice(i + 1, end);
      if (!/^\d+$/.test(digits)) {
        throw new KeyDecodeError(
          key,
          i,
          `Array index must be base-10 digits, got ${JSON.stringify(digits)}`,
        );
      }
      path.push(Number.parseInt(digits, 10));
      i = end + 1;
      continue;
    }
    if (ch === "]") {
      throw new KeyDecodeError(key, i, "Unescaped ']' outside an array index");
    }
    buffer += ch;
    inSegment = true;
    i += 1;
  }

  if (inSegment) flush();
  return path;
}
