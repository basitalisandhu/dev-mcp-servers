/**
 * Static heuristics for catastrophic backtracking. They flag the shapes that are known to blow up
 * (nested unbounded quantifiers, overlapping alternatives under a quantifier, adjacent overlapping
 * repeats). A finding is a reason to test with the probe, not a proof.
 */
import { parse, type Node } from "./ast.js";

export interface RedosFinding {
  kind: "nested-quantifier" | "overlapping-alternation" | "adjacent-overlap";
  severity: "high" | "medium";
  construct: string;
  message: string;
  /** A character that exercises the ambiguity, if one could be derived. */
  probe_char: string | null;
}

const ALPHABET: string[] = [];
for (let c = 32; c < 127; c++) ALPHABET.push(String.fromCharCode(c));
ALPHABET.push("\n", "\t", "é", "中");

function singleCharTester(raw: string, flags: string): (c: string) => boolean {
  try {
    const re = new RegExp(`^(?:${raw})$`, flags.replace(/[gmyd]/g, ""));
    return (c) => re.test(c);
  } catch {
    return () => false;
  }
}

function literalChar(node: Extract<Node, { type: "char" }>): string | undefined {
  if (node.raw === node.value) return node.value;
  const m: Record<string, string> = { "\\n": "\n", "\\r": "\r", "\\t": "\t", "\\f": "\f", "\\v": "\v", "\\0": "\0" };
  if (m[node.raw]) return m[node.raw];
  if (node.raw.length === 2 && node.raw.startsWith("\\")) return node.raw[1];
  try {
    const re = new RegExp(`^${node.raw}$`, "u");
    return ALPHABET.find((c) => re.test(c));
  } catch {
    return undefined;
  }
}

/** Approximate set of alphabet characters that can begin a match of the node, plus whether it can match empty. */
export function firstSet(node: Node, flags: string): { chars: Set<string>; nullable: boolean } {
  switch (node.type) {
    case "char": {
      const c = literalChar(node);
      if (c === undefined) return { chars: new Set(), nullable: false };
      const test = singleCharTester(c.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"), flags);
      return { chars: new Set(ALPHABET.filter(test)), nullable: false };
    }
    case "class":
    case "escape": {
      if (node.type === "escape" && (node.kind === "backreference" || node.kind === "named-backreference")) return { chars: new Set(ALPHABET), nullable: true };
      const test = singleCharTester(node.raw, flags);
      return { chars: new Set(ALPHABET.filter(test)), nullable: false };
    }
    case "anchor":
      return { chars: new Set(), nullable: true };
    case "group":
      if (node.kind.includes("look")) return { chars: new Set(), nullable: true };
      return firstSet(node.body, flags);
    case "quantified": {
      const inner = firstSet(node.body, flags);
      return { chars: inner.chars, nullable: inner.nullable || node.min === 0 };
    }
    case "alternation": {
      const chars = new Set<string>();
      let nullable = false;
      for (const a of node.alternatives) {
        const f = firstSet(a, flags);
        f.chars.forEach((c) => chars.add(c));
        nullable = nullable || f.nullable;
      }
      return { chars, nullable };
    }
    case "sequence": {
      const chars = new Set<string>();
      for (const item of node.items) {
        const f = firstSet(item, flags);
        f.chars.forEach((c) => chars.add(c));
        if (!f.nullable) return { chars, nullable: false };
      }
      return { chars, nullable: true };
    }
  }
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((c) => b.has(c));
}

function unbounded(node: Node): node is Extract<Node, { type: "quantified" }> {
  return node.type === "quantified" && (node.max === null || node.max >= 25);
}

function source(node: Node): string {
  switch (node.type) {
    case "char":
    case "class":
    case "escape":
    case "anchor":
      return node.raw;
    case "quantified":
      return source(node.body) + node.raw;
    case "group": {
      const open: Record<string, string> = { capture: "(", "non-capture": "(?:", named: `(?<${node.name}>`, lookahead: "(?=", "negative-lookahead": "(?!", lookbehind: "(?<=", "negative-lookbehind": "(?<!" };
      return `${open[node.kind]}${source(node.body)})`;
    }
    case "alternation":
      return node.alternatives.map(source).join("|");
    case "sequence":
      return node.items.map(source).join("");
  }
}

/** Every unbounded quantifier inside a node, looking through groups and sequences (not into lookarounds). */
function allUnbounded(node: Node): Extract<Node, { type: "quantified" }>[] {
  switch (node.type) {
    case "quantified":
      return [...(unbounded(node) ? [node] : []), ...allUnbounded(node.body)];
    case "group":
      return node.kind.includes("look") ? [] : allUnbounded(node.body);
    case "alternation":
      return node.alternatives.flatMap(allUnbounded);
    case "sequence":
      return node.items.flatMap(allUnbounded);
    default:
      return [];
  }
}

/** Last items of a sequence that are unbounded quantifiers, looking through groups. */
function trailingUnbounded(node: Node): Extract<Node, { type: "quantified" }>[] {
  if (node.type === "quantified") return unbounded(node) ? [node] : [];
  if (node.type === "group" && !node.kind.includes("look")) return trailingUnbounded(node.body);
  if (node.type === "alternation") return node.alternatives.flatMap(trailingUnbounded);
  if (node.type === "sequence") {
    const out: Extract<Node, { type: "quantified" }>[] = [];
    for (let i = node.items.length - 1; i >= 0; i--) {
      const item = node.items[i];
      out.push(...trailingUnbounded(item));
      const f = firstSet(item, "");
      if (!(item.type === "quantified" && item.min === 0) && !f.nullable) break;
    }
    return out;
  }
  return [];
}

export function analyse(pattern: string, flags = ""): RedosFinding[] {
  const { ast } = parse(pattern);
  const findings: RedosFinding[] = [];
  const seen = new Set<string>();
  const push = (f: RedosFinding) => {
    const key = `${f.kind}:${f.construct}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(f);
    }
  };

  function walk(node: Node, enclosing: Extract<Node, { type: "quantified" }>[]): void {
    switch (node.type) {
      case "quantified": {
        if (unbounded(node)) {
          const outer = node;
          const trailing = new Set(trailingUnbounded(outer.body));
          for (const q of allUnbounded(outer.body)) {
            if (q === outer) continue;
            const innerFirst = firstSet(q.body, flags);
            const outerFirst = firstSet(outer.body, flags);
            const overlap = trailing.has(q) ? intersect(innerFirst.chars, outerFirst.chars) : [];
            push({
              kind: "nested-quantifier",
              severity: overlap.length ? "high" : "medium",
              construct: source(outer),
              message: overlap.length
                ? `An unbounded repeat (${source(q)}) ends the body of another unbounded repeat (${outer.raw}) and both can consume the same characters, so a non-matching input of n such characters can be split in about 2^n ways.`
                : `An unbounded repeat (${source(q)}) sits inside another unbounded repeat (${outer.raw}). Something that must match in between limits the ambiguity, but nested repeats are worth a probe.`,
              probe_char: overlap[0] ?? null,
            });
          }
          const body = outer.body.type === "group" ? outer.body.body : outer.body;
          if (body.type === "alternation") {
            for (let a = 0; a < body.alternatives.length; a++) {
              for (let b = a + 1; b < body.alternatives.length; b++) {
                const overlap = intersect(firstSet(body.alternatives[a], flags).chars, firstSet(body.alternatives[b], flags).chars);
                if (overlap.length) {
                  push({
                    kind: "overlapping-alternation",
                    severity: "high",
                    construct: source(outer),
                    message: `Alternatives ${source(body.alternatives[a])} and ${source(body.alternatives[b])} can both start with ${JSON.stringify(overlap[0])} and the group repeats without bound, so the engine tries every assignment of characters to alternatives before failing.`,
                    probe_char: overlap[0],
                  });
                  break;
                }
              }
            }
          }
        }
        walk(node.body, unbounded(node) ? [...enclosing, node] : enclosing);
        break;
      }
      case "sequence": {
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          if (unbounded(item)) {
            for (let j = i + 1; j < node.items.length; j++) {
              const next = node.items[j];
              if (unbounded(next)) {
                const overlap = intersect(firstSet(item.body, flags).chars, firstSet(next.body, flags).chars);
                if (overlap.length) {
                  push({
                    kind: "adjacent-overlap",
                    severity: enclosing.length ? "high" : "medium",
                    construct: `${source(item)}${source(next)}`,
                    message: `Two consecutive unbounded repeats (${source(item)} then ${source(next)}) accept the same characters, so a non-matching input of n such characters is tried in about n^2 ways${enclosing.length ? ", and the sequence itself is repeated, which makes it exponential" : ""}.`,
                    probe_char: overlap[0],
                  });
                }
              }
              const f = firstSet(next, flags);
              if (!f.nullable) break;
            }
          }
          walk(item, enclosing);
        }
        break;
      }
      case "alternation":
        node.alternatives.forEach((a) => walk(a, enclosing));
        break;
      case "group":
        walk(node.body, enclosing);
        break;
      default:
        break;
    }
  }
  walk(ast, []);
  return findings;
}
