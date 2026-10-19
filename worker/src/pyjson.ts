// Byte-for-byte reproductions of two Python behaviours the cache depends on.
//
// payload hashes: every stored workout carries sha256 of
//   json.dumps(payload, sort_keys=True, separators=(",", ":"))
// computed by the Python sync. A sync stops at the first page whose hashes all
// match, so if this serialization differed by even one byte, every workout
// would look edited and the first Worker sync would rewrite the whole history.
//
// rounding: output rounds with Python's round(), which is round-half-even on
// the exact binary value, not Math.round's half-up.

export function pythonJsonDumpsSorted(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pythonFloatRepr(value);
  if (typeof value === "string") return pythonString(value);
  if (Array.isArray(value)) return `[${value.map(pythonJsonDumpsSorted).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as object)
      .sort()
      .map((key) => `${pythonString(key)}:${pythonJsonDumpsSorted((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`cannot serialize ${typeof value}`);
}

const NAMED_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

// ensure_ascii=True: everything outside printable ASCII becomes \uXXXX, with
// lowercase hex, and astral characters as their UTF-16 surrogate pair.
function pythonString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    const named = NAMED_ESCAPES[ch];
    if (named) out += named;
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

// JSON numbers arrive in JS without the int/float distinction Python keeps.
// Hevy's API is a JS backend, so integral values are sent without ".0" and
// Python parsed them as ints; anything non-integral is a float in both.
function pythonFloatRepr(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`non-finite number ${x}`);
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);

  // Shortest round-trip digits, then Python's repr layout: scientific when the
  // decimal exponent is below -4 or at least 16, fixed otherwise.
  const [mantissa, expText] = x.toExponential().split("e");
  const exponent = Number(expText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = negative ? "-" : "";

  if (exponent < -4 || exponent >= 16) {
    const body = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const expSign = exponent < 0 ? "-" : "+";
    return `${sign}${body}e${expSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const intPart = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fracPart = digits.slice(exponent + 1);
  return `${sign}${intPart}.${fracPart || "0"}`;
}

export async function payloadHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(pythonJsonDumpsSorted(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Python's round(x, places): half-even on the exact binary value. */
export function pyRound(x: number, places: number): number {
  if (!Number.isFinite(x)) return x;
  // toFixed(100) is the exact decimal expansion for any value this code sees.
  const exact = Math.abs(x).toFixed(100);
  const [intPart, frac] = exact.split(".");
  const kept = intPart + frac.slice(0, places);
  const rest = frac.slice(places);

  let roundUp: boolean;
  if (rest[0] > "5") roundUp = true;
  else if (rest[0] < "5") roundUp = false;
  else if (/[1-9]/.test(rest.slice(1))) roundUp = true;
  else roundUp = Number(kept[kept.length - 1]) % 2 === 1;

  let scaled = BigInt(kept);
  if (roundUp) scaled += 1n;
  const text = scaled.toString().padStart(places + 1, "0");
  const value = Number(places > 0 ? `${text.slice(0, -places)}.${text.slice(-places)}` : text);
  // Drop negative zero, which JSON cannot tell apart anyway.
  return (x < 0 ? -value : value) || 0;
}
