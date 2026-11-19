/** Six-character squad codes from an unambiguous alphabet (no 0/O, 1/I/L). 31^6 ≈ 887M codes. */
export const JOIN_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const JOIN_CODE_LENGTH = 6;

export function generateJoinCode(randomInt: (maxExclusive: number) => number): string {
  let out = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) out += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  return out;
}

/** Normalise user input (case, spaces, dashes). Returns null if not a syntactically valid code. */
export function normalizeJoinCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== JOIN_CODE_LENGTH) return null;
  for (const ch of code) if (!JOIN_CODE_ALPHABET.includes(ch)) return null;
  return code;
}
