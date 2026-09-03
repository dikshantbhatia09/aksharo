/**
 * A tiny evaluator for the ffmpeg expression subset `../src/ffmpeg/sfx-duck-
 * expr.ts` emits (`t`, `+ - * /`, `if()`, `between()`, `min()`, parens,
 * numeric literals) — the same numerical-proof strategy `expr-eval.ts` uses
 * for the crop-window gate, extended with the two functions the duck
 * expression needs that the crop one didn't. Kept as its own small copy
 * (mirroring `../src/ffmpeg/sfx-duck-expr.test.ts`'s test-local evaluator,
 * which this directory's `run-sfx-parity.ts` cannot import) so the numbers
 * this directory measures are the same ones that test already proves pass.
 */

export function evalSfxDuckExpr(expr: string, t: number): number {
  let i = 0;
  const s = expr;

  function peek(): string {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a bounded internal cursor over a fixed expression string, not attacker-controlled -- reviewed for D04c
    return s[i] ?? "";
  }
  function skip(ch: string): void {
    // eslint-disable-next-line security/detect-object-injection -- same bounded internal cursor as peek() -- reviewed for D04c
    if (s[i] !== ch) throw new Error(`expected '${ch}' at ${String(i)} in ${expr}`);
    i += 1;
  }
  function parseArgs(): number[] {
    skip("(");
    const args: number[] = [parseExpr()];
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
      const a0 = args[0] ?? 0;
      const a1 = args[1] ?? 0;
      const a2 = args[2] ?? 0;
      if (name === "if") return a0 !== 0 ? a1 : a2;
      if (name === "min") return Math.min(...args);
      if (name === "between") return a0 >= a1 && a0 <= a2 ? 1 : 0;
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
  const result = parseExpr();
  if (i !== s.length) throw new Error(`trailing input at ${String(i)} in ${expr}: ${s.slice(i)}`);
  return result;
}
