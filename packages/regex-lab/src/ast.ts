/**
 * A small parser for JavaScript regular expression syntax, enough to explain a pattern and to look
 * for backtracking hazards. It accepts what RegExp accepts for the common constructs; anything it does
 * not understand is kept as a literal token with a note.
 */

export type Node =
  | { type: "alternation"; alternatives: Node[] }
  | { type: "sequence"; items: Node[] }
  | { type: "group"; kind: "capture" | "non-capture" | "named" | "lookahead" | "negative-lookahead" | "lookbehind" | "negative-lookbehind"; name?: string; body: Node; index?: number }
  | { type: "quantified"; body: Node; min: number; max: number | null; lazy: boolean; raw: string }
  | { type: "char"; value: string; raw: string }
  | { type: "class"; negated: boolean; raw: string; members: string[] }
  | { type: "escape"; kind: "digit" | "non-digit" | "word" | "non-word" | "space" | "non-space" | "any" | "unicode-property" | "backreference" | "named-backreference" | "other"; raw: string; description: string }
  | { type: "anchor"; kind: "start" | "end" | "word-boundary" | "non-word-boundary"; raw: string };

function rawOf(node: Node): string {
  return "raw" in node ? node.raw : "";
}

export class RegexSyntaxError extends Error {
  constructor(message: string, public readonly position: number) {
    super(message);
  }
}

export function parse(pattern: string): { ast: Node; groups: number } {
  let i = 0;
  let groupCount = 0;
  const src = pattern;

  const peek = () => src[i];
  const eof = () => i >= src.length;

  function parseAlternation(): Node {
    const alternatives: Node[] = [parseSequence()];
    while (!eof() && peek() === "|") {
      i++;
      alternatives.push(parseSequence());
    }
    return alternatives.length === 1 ? alternatives[0] : { type: "alternation", alternatives };
  }

  function parseSequence(): Node {
    const items: Node[] = [];
    while (!eof() && peek() !== "|" && peek() !== ")") {
      const atom = parseAtom();
      items.push(parseQuantifier(atom));
    }
    return { type: "sequence", items };
  }

  function parseQuantifier(atom: Node): Node {
    if (eof()) return atom;
    const start = i;
    const c = peek();
    let min: number;
    let max: number | null;
    if (c === "*") {
      min = 0;
      max = null;
      i++;
    } else if (c === "+") {
      min = 1;
      max = null;
      i++;
    } else if (c === "?") {
      min = 0;
      max = 1;
      i++;
    } else if (c === "{") {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(i));
      if (!m) return atom;
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? null : Number(m[3]);
      if (max !== null && max < min) throw new RegexSyntaxError(`quantifier {${min},${max}} has max below min`, i);
      i += m[0].length;
    } else {
      return atom;
    }
    if (atom.type === "anchor" || atom.type === "quantified") throw new RegexSyntaxError("nothing to repeat", start);
    let lazy = false;
    if (!eof() && peek() === "?") {
      lazy = true;
      i++;
    }
    return { type: "quantified", body: atom, min, max, lazy, raw: src.slice(start, i) };
  }

  function parseAtom(): Node {
    const c = peek();
    const start = i;
    if (c === "(") {
      i++;
      let kind: Extract<Node, { type: "group" }>["kind"] = "capture";
      let name: string | undefined;
      if (src.startsWith("?:", i)) {
        kind = "non-capture";
        i += 2;
      } else if (src.startsWith("?=", i)) {
        kind = "lookahead";
        i += 2;
      } else if (src.startsWith("?!", i)) {
        kind = "negative-lookahead";
        i += 2;
      } else if (src.startsWith("?<=", i)) {
        kind = "lookbehind";
        i += 3;
      } else if (src.startsWith("?<!", i)) {
        kind = "negative-lookbehind";
        i += 3;
      } else if (src.startsWith("?<", i)) {
        const m = /^\?<([A-Za-z_$][\w$]*)>/.exec(src.slice(i));
        if (!m) throw new RegexSyntaxError("invalid group name", i);
        kind = "named";
        name = m[1];
        i += m[0].length;
      } else if (c === "(" && src[i] === "?") {
        throw new RegexSyntaxError("unsupported group modifier", i);
      }
      const index = kind === "capture" || kind === "named" ? ++groupCount : undefined;
      const body = parseAlternation();
      if (eof() || peek() !== ")") throw new RegexSyntaxError("unterminated group", start);
      i++;
      return { type: "group", kind, name, body, index };
    }
    if (c === "[") return parseClass();
    if (c === "\\") return parseEscape();
    if (c === "^") {
      i++;
      return { type: "anchor", kind: "start", raw: "^" };
    }
    if (c === "$") {
      i++;
      return { type: "anchor", kind: "end", raw: "$" };
    }
    if (c === ".") {
      i++;
      return { type: "escape", kind: "any", raw: ".", description: "any character except line terminators (any character at all with the s flag)" };
    }
    if (c === ")") throw new RegexSyntaxError("unmatched )", i);
    if (c === "*" || c === "+" || c === "?") throw new RegexSyntaxError("nothing to repeat", i);
    i++;
    return { type: "char", value: c, raw: c };
  }

  function parseClass(): Node {
    const start = i;
    i++;
    let negated = false;
    if (peek() === "^") {
      negated = true;
      i++;
    }
    const members: string[] = [];
    let first = true;
    while (!eof() && (peek() !== "]" || first)) {
      first = false;
      let item: string;
      if (peek() === "\\") {
        const e = parseEscape();
        item = e.type === "escape" ? e.description : rawOf(e);
      } else {
        item = src[i];
        i++;
      }
      if (!eof() && peek() === "-" && src[i + 1] !== "]" && src[i + 1] !== undefined) {
        i++;
        let hi: string;
        if (peek() === "\\") {
          hi = rawOf(parseEscape());
        } else {
          hi = src[i];
          i++;
        }
        members.push(`${item} to ${hi}`);
      } else {
        members.push(item);
      }
    }
    if (eof()) throw new RegexSyntaxError("unterminated character class", start);
    i++;
    return { type: "class", negated, raw: src.slice(start, i), members };
  }

  function parseEscape(): Node {
    const start = i;
    i++;
    if (eof()) throw new RegexSyntaxError("pattern ends with a backslash", start);
    const c = src[i];
    i++;
    const raw = () => src.slice(start, i);
    const simple: Record<string, { kind: Extract<Node, { type: "escape" }>["kind"]; description: string }> = {
      d: { kind: "digit", description: "a digit 0-9" },
      D: { kind: "non-digit", description: "any character that is not a digit" },
      w: { kind: "word", description: "a word character (letter, digit or underscore)" },
      W: { kind: "non-word", description: "any character that is not a word character" },
      s: { kind: "space", description: "a whitespace character" },
      S: { kind: "non-space", description: "any character that is not whitespace" },
    };
    if (simple[c]) return { type: "escape", ...simple[c], raw: raw() };
    if (c === "b") return { type: "anchor", kind: "word-boundary", raw: "\\b" };
    if (c === "B") return { type: "anchor", kind: "non-word-boundary", raw: "\\B" };
    if (c === "p" || c === "P") {
      const m = /^\{([^}]+)\}/.exec(src.slice(i));
      if (m) i += m[0].length;
      return { type: "escape", kind: "unicode-property", raw: raw(), description: `${c === "P" ? "any character without" : "a character with"} the Unicode property ${m?.[1] ?? "?"} (needs the u or v flag)` };
    }
    if (c === "k") {
      const m = /^<([^>]+)>/.exec(src.slice(i));
      if (m) i += m[0].length;
      return { type: "escape", kind: "named-backreference", raw: raw(), description: `the same text as group ${m?.[1] ?? "?"} matched` };
    }
    if (/[1-9]/.test(c)) {
      while (!eof() && /\d/.test(peek())) i++;
      return { type: "escape", kind: "backreference", raw: raw(), description: `the same text as group ${raw().slice(1)} matched` };
    }
    const named: Record<string, string> = { n: "a newline", r: "a carriage return", t: "a tab", f: "a form feed", v: "a vertical tab", "0": "a NUL character" };
    if (named[c]) return { type: "char", value: named[c], raw: raw() };
    if (c === "x") {
      i += 2;
      return { type: "char", value: `the character with hex code ${src.slice(start + 2, i)}`, raw: raw() };
    }
    if (c === "u") {
      if (peek() === "{") {
        const end = src.indexOf("}", i);
        i = end === -1 ? src.length : end + 1;
      } else i += 4;
      return { type: "char", value: `the character with code point ${src.slice(start + 2, i)}`, raw: raw() };
    }
    if (c === "c") {
      i++;
      return { type: "char", value: `control character ${src.slice(start + 2, i)}`, raw: raw() };
    }
    return { type: "char", value: c, raw: raw() };
  }

  const ast = parseAlternation();
  if (!eof() && peek() === ")") throw new RegexSyntaxError("unmatched )", i);
  if (!eof()) throw new RegexSyntaxError(`unexpected ${JSON.stringify(peek())}`, i);
  return { ast, groups: groupCount };
}

export function describeQuantifier(min: number, max: number | null, lazy: boolean): string {
  let s: string;
  if (min === 0 && max === null) s = "zero or more times";
  else if (min === 1 && max === null) s = "one or more times";
  else if (min === 0 && max === 1) s = "optionally (zero or one time)";
  else if (max === null) s = `at least ${min} times`;
  else if (min === max) s = `exactly ${min} time${min === 1 ? "" : "s"}`;
  else s = `between ${min} and ${max} times`;
  return lazy ? `${s}, as few as possible (lazy)` : s;
}

/** Flatten the AST into indented explanation lines. */
export function explain(node: Node, depth = 0, lines: string[] = []): string[] {
  const pad = "  ".repeat(depth);
  switch (node.type) {
    case "alternation":
      lines.push(`${pad}one of the following ${node.alternatives.length} alternatives:`);
      node.alternatives.forEach((a, n) => {
        lines.push(`${pad}  alternative ${n + 1}:`);
        explain(a, depth + 2, lines);
      });
      break;
    case "sequence":
      if (node.items.length === 0) lines.push(`${pad}(empty)`);
      for (const item of node.items) explain(item, depth, lines);
      break;
    case "group": {
      const label: Record<Extract<Node, { type: "group" }>["kind"], string> = {
        capture: `capturing group ${node.index}`,
        named: `named capturing group "${node.name}" (group ${node.index})`,
        "non-capture": "non-capturing group",
        lookahead: "lookahead: assert that what follows matches",
        "negative-lookahead": "negative lookahead: assert that what follows does not match",
        lookbehind: "lookbehind: assert that what precedes matches",
        "negative-lookbehind": "negative lookbehind: assert that what precedes does not match",
      };
      lines.push(`${pad}${label[node.kind]}:`);
      explain(node.body, depth + 1, lines);
      break;
    }
    case "quantified":
      lines.push(`${pad}repeat ${describeQuantifier(node.min, node.max, node.lazy)} (${node.raw}):`);
      explain(node.body, depth + 1, lines);
      break;
    case "char":
      lines.push(`${pad}${node.raw === node.value ? `the character "${node.value}"` : `${node.value} (${node.raw})`}`);
      break;
    case "class":
      lines.push(`${pad}${node.negated ? "any character NOT in" : "one character from"} the set: ${node.members.map((m) => JSON.stringify(m)).join(", ")} (${node.raw})`);
      break;
    case "escape":
      lines.push(`${pad}${node.description} (${node.raw})`);
      break;
    case "anchor": {
      const text: Record<Extract<Node, { type: "anchor" }>["kind"], string> = {
        start: "start of input (start of a line with the m flag)",
        end: "end of input (end of a line with the m flag)",
        "word-boundary": "a word boundary",
        "non-word-boundary": "a position that is not a word boundary",
      };
      lines.push(`${pad}${text[node.kind]} (${node.raw})`);
      break;
    }
  }
  return lines;
}
