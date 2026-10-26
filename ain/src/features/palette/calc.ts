/**
 * The palette's calculator: arithmetic parsed by hand (never `eval`), with the usual precedence,
 * `^` for powers, `!` for factorials, `%` as a percent after a number and as modulo between two,
 * implicit products ("2pi", "3(1+2)"), functions and constants. A decimal comma works in plain
 * arithmetic, where it can't separate a function's arguments.
 */

type Token = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

const MAX_INPUT = 200;
const MAX_DEPTH = 64;

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI, τ: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, φ: (1 + Math.sqrt(5)) / 2 };

/** Each function with how many arguments it takes, at least and at most. */
const FUNCTIONS: Readonly<Record<string, readonly [(...args: number[]) => number, number, number]>> = {
  sqrt: [Math.sqrt, 1, 1],
  cbrt: [Math.cbrt, 1, 1],
  abs: [Math.abs, 1, 1],
  round: [Math.round, 1, 1],
  floor: [Math.floor, 1, 1],
  ceil: [Math.ceil, 1, 1],
  trunc: [Math.trunc, 1, 1],
  sign: [Math.sign, 1, 1],
  exp: [Math.exp, 1, 1],
  ln: [Math.log, 1, 1],
  log: [(x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)), 1, 2],
  log2: [Math.log2, 1, 1],
  log10: [Math.log10, 1, 1],
  sin: [Math.sin, 1, 1],
  cos: [Math.cos, 1, 1],
  tan: [Math.tan, 1, 1],
  asin: [Math.asin, 1, 1],
  acos: [Math.acos, 1, 1],
  atan: [Math.atan, 1, 1],
  atan2: [Math.atan2, 2, 2],
  sinh: [Math.sinh, 1, 1],
  cosh: [Math.cosh, 1, 1],
  tanh: [Math.tanh, 1, 1],
  deg: [(x) => (x * 180) / Math.PI, 1, 1],
  rad: [(x) => (x * Math.PI) / 180, 1, 1],
  min: [Math.min, 1, Infinity],
  max: [Math.max, 1, Infinity],
  pow: [Math.pow, 2, 2],
  hypot: [Math.hypot, 1, Infinity],
};

const OPERATORS = new Map([
  ["**", "^"],
  ["×", "*"],
  ["·", "*"],
  ["÷", "/"],
  ["−", "-"],
  ["+", "+"],
  ["-", "-"],
  ["*", "*"],
  ["/", "/"],
  ["%", "%"],
  ["^", "^"],
  ["!", "!"],
  ["(", "("],
  [")", ")"],
  [",", ","],
  [";", ","],
]);

class Invalid extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const number = /^(?:0x[\da-f]+|0b[01]+|0o[0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i;
  const name = /^[\p{L}_][\p{L}\p{N}_]*/u;
  let rest = input;
  while ((rest = rest.trimStart())) {
    const num = number.exec(rest)?.[0];
    if (num) {
      const value = /^0[xbo]/i.test(num) ? Number(num.toLowerCase()) : Number.parseFloat(num);
      tokens.push({ kind: "num", value });
      rest = rest.slice(num.length);
      continue;
    }
    const word = name.exec(rest)?.[0];
    if (word) {
      tokens.push({ kind: "name", value: word.toLowerCase() });
      rest = rest.slice(word.length);
      continue;
    }
    const op = [...OPERATORS.keys()].find((o) => rest.startsWith(o));
    if (!op) throw new Invalid(`unexpected ${rest[0]}`);
    tokens.push({ kind: "op", value: OPERATORS.get(op)! });
    rest = rest.slice(op.length);
  }
  return tokens;
}

/** A recursive-descent parser that evaluates as it goes. */
class Parser {
  private at = 0;
  private depth = 0;
  /** Whether anything was computed: a lone number or constant isn't a calculation. */
  computed = false;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t?.kind === "op" && t.value === value;
  }

  private take(value: string): boolean {
    if (!this.isOp(value)) return false;
    this.at++;
    return true;
  }

  parse(): number {
    const value = this.sum();
    if (this.peek()) throw new Invalid("unexpected input");
    return value;
  }

  private sum(): number {
    let value = this.product();
    for (;;) {
      if (this.take("+")) value += this.product();
      else if (this.take("-")) value -= this.product();
      else return value;
      this.computed = true;
    }
  }

  private product(): number {
    let value = this.unary();
    for (;;) {
      if (this.take("*")) value *= this.unary();
      else if (this.take("/")) value /= this.unary();
      else if (this.take("%")) value %= this.unary();
      // "2pi", "3(1+2)": a name or a bracket right after an operand multiplies it.
      else if (this.peek()?.kind === "name" || this.isOp("(")) value *= this.unary();
      else return value;
      this.computed = true;
    }
  }

  private unary(): number {
    if (this.take("-")) return -this.unary();
    if (this.take("+")) return this.unary();
    return this.power();
  }

  private power(): number {
    const base = this.postfix();
    if (!this.take("^")) return base;
    this.computed = true;
    return base ** this.unary();
  }

  private postfix(): number {
    let value = this.primary();
    for (;;) {
      if (this.take("!")) value = factorial(value);
      // A percent sign not followed by an operand is a percent: "200 * 15%".
      else if (this.isOp("%") && !this.operandAt(1)) {
        this.at++;
        value /= 100;
      } else return value;
      this.computed = true;
    }
  }

  /** Whether the token `offset` ahead starts an operand. */
  private operandAt(offset: number): boolean {
    const t = this.tokens[this.at + offset];
    return t !== undefined && (t.kind !== "op" || t.value === "(");
  }

  private primary(): number {
    if (++this.depth > MAX_DEPTH) throw new Invalid("too deep");
    try {
      const t = this.peek();
      if (!t) throw new Invalid("missing operand");
      this.at++;
      if (t.kind === "num") return t.value;
      if (t.kind === "op") {
        if (t.value !== "(") throw new Invalid(`unexpected ${t.value}`);
        const value = this.sum();
        if (!this.take(")")) throw new Invalid("missing )");
        return value;
      }
      const fn = FUNCTIONS[t.value];
      if (fn && this.take("(")) return this.call(fn);
      // Not a calculation by itself: typing "e" searches for apps starting with an e.
      const constant = CONSTANTS[t.value];
      if (constant === undefined) throw new Invalid(`unknown ${t.value}`);
      return constant;
    } finally {
      this.depth--;
    }
  }

  private call([fn, least, most]: readonly [(...args: number[]) => number, number, number]): number {
    const args: number[] = [];
    if (!this.take(")")) {
      do args.push(this.sum());
      while (this.take(","));
      if (!this.take(")")) throw new Invalid("missing )");
    }
    if (args.length < least || args.length > most) throw new Invalid("wrong number of arguments");
    this.computed = true;
    return fn(...args);
  }
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0 || n > 170) throw new Invalid("factorial of a whole number up to 170");
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

/** The value of an arithmetic expression, or null when `input` isn't one (or is just a number). */
export function calculate(input: string): number | null {
  const text = input.trim();
  if (!text || text.length > MAX_INPUT) return null;
  // With no names there are no functions, so a comma between digits is a decimal one: "12,5 * 3".
  const plain = /\p{L}/u.test(text) ? text : text.replace(/(\d),(\d)/g, "$1.$2");
  try {
    const parser = new Parser(tokenize(plain));
    const value = parser.parse();
    return parser.computed && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** A result to copy: at most 15 significant digits, so 0.1 + 0.2 gives 0.3. */
export const plain = (value: number): string => String(Number(value.toPrecision(15)));

/** A result to read, in the user's language: "1 234,5" in French. */
export const pretty = (value: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 }).format(Number(value.toPrecision(15)));
