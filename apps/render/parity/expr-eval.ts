/**
 * A tiny evaluator for the ffmpeg expression subset `../src/ffmpeg/crop-
 * expr.ts` emits (`t`, `+ - * /`, `lt()`, `if()`, parens, numeric literals) —
 * exactly what `../src/ffmpeg/crop-parity.test.ts` uses to check the cloud
 * path's expression against the browser path's `sampleCropWindow`. Kept as
 * its own small copy here (rather than imported from the test file, which
 * does not export it and sits outside `apps/render/parity/**`) so this
 * directory's `run.ts` can measure the same two numbers the test already
 * proves pass, and write them down.
 */

export function evalCropExpr(expr: string, t: number): number {
  let i = 0;
  function peek(): string {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    return expr[i] ?? "";
  }
  function skip(ch: string): void {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if (expr[i] !== ch) throw new Error(`expected '${ch}' at ${String(i)}`);
    i += 1;
  }
  function parseArgs(): number[] {
    skip("(");
    const args = [parseExpr()];
    while (peek() === ",") {
      i += 1;
      args.push(parseExpr());
    }
    skip(")");
    return args;
  }
  function parseAtom(): number {
    if (peek() === "(") {
      i += 1;
      const v = parseExpr();
      skip(")");
      return v;
    }
    if (/[a-z]/i.test(peek())) {
      let name = "";
      while (/[a-z]/i.test(peek())) {
        name += peek();
        i += 1;
      }
      if (name === "t") return t;
      const args = parseArgs();
      if (name === "lt") return (args[0] ?? 0) < (args[1] ?? 0) ? 1 : 0;
      if (name === "if") return (args[0] ?? 0) !== 0 ? (args[1] ?? 0) : (args[2] ?? 0);
      throw new Error(`unknown fn ${name}`);
    }
    let sign = 1;
    if (peek() === "-") {
      sign = -1;
      i += 1;
    }
    let num = "";
    while (/[0-9.]/.test(peek())) {
      num += peek();
      i += 1;
    }
    return sign * Number(num);
  }
  function parseTerm(): number {
    let v = parseAtom();
    for (;;) {
      if (peek() === "*") {
        i += 1;
        v *= parseAtom();
      } else if (peek() === "/") {
        i += 1;
        v /= parseAtom();
      } else break;
    }
    return v;
  }
  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      if (peek() === "+") {
        i += 1;
        v += parseTerm();
      } else if (peek() === "-") {
        i += 1;
        v -= parseTerm();
      } else break;
    }
    return v;
  }
  return parseExpr();
}

export function extractCropField(filter: string, field: "w" | "h" | "x" | "y"): string {
  // eslint-disable-next-line security/detect-non-literal-regexp -- RegExp built from a fixed/internal string (test fixture or bounded value, not attacker input) -- reviewed for M06's eslint-plugin-security promotion
  const match = new RegExp(`${field}='([^']*)'`).exec(filter);
  if (match === null) throw new Error(`no ${field} in ${filter}`);
  return match[1] ?? "";
}
