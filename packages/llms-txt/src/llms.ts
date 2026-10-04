/**
 * llms.txt generation from local Markdown or a local sitemap.xml, and checking against the convention at
 * https://llmstxt.org: an H1 title, an optional blockquote summary, free paragraphs, then H2 sections whose
 * items are "- [name](url): notes", with an "Optional" section for secondary material.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const MAX_FILES = 1000;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_DEPTH = 12;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "vendor", "coverage", "target", "out", ".cache", "__pycache__"]);
const MARKDOWN = /\.(md|mdx|markdown)$/i;

export interface Entry {
  file: string;
  url: string;
  title: string;
  description: string;
  section: string;
}

export interface CollectOptions {
  maxFiles?: number;
  baseUrl?: string;
  urlStyle?: "strip-extension" | "keep-extension";
  includeDirs?: string[];
}

function humanise(name: string): string {
  return name
    .replace(/\.(md|mdx|markdown)$/i, "")
    .replace(/^\d+[-_.]\s*/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function stripMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractMeta(text: string, fallbackTitle: string): { title: string; description: string } {
  let body = text;
  let fmTitle: string | undefined;
  let fmDescription: string | undefined;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(title|description)\s*:\s*(.+)$/i.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (m[1].toLowerCase() === "title") fmTitle = value;
      else fmDescription = value;
    }
  }
  const lines = body.split(/\r?\n/);
  let title = fmTitle;
  let description = fmDescription;
  let inCode = false;
  let paragraph: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^(```|~~~)/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!title) {
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
      if (h1) {
        title = stripMarkdown(h1[1]);
        continue;
      }
    }
    if (description) break;
    const isStructural = /^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||<|\s*$|---|===|import |export )/.test(line);
    if (isStructural) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.trim());
    if (paragraph.join(" ").length > 400) break;
  }
  if (!description && paragraph.length) description = stripMarkdown(paragraph.join(" "));
  if (description && description.length > 200) description = description.slice(0, 197).replace(/\s+\S*$/, "") + "...";
  return { title: title ?? humanise(fallbackTitle), description: description ?? "" };
}

export function toUrl(relPath: string, baseUrl: string | undefined, style: "strip-extension" | "keep-extension"): string {
  let p = relPath.split(sep).join("/");
  if (style === "strip-extension") {
    p = p.replace(/(^|\/)(README|index)\.(md|mdx|markdown)$/i, "$1").replace(/\.(md|mdx|markdown)$/i, "/");
    if (p === "") p = "/";
  }
  if (!baseUrl) return p.startsWith("/") ? p : `/${p}`;
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/${p.replace(/^\/+/, "")}`.replace(/\/+$/, p.endsWith("/") ? "/" : "");
}

export async function collectMarkdown(dir: string, options: CollectOptions = {}): Promise<{ entries: Entry[]; skipped: { file: string; reason: string }[]; scanned: number }> {
  const root = resolve(dir);
  const st = await stat(root).catch(() => undefined);
  if (!st || !st.isDirectory()) throw new Error(`${root} is not a directory`);
  const maxFiles = Math.min(options.maxFiles ?? MAX_FILES, MAX_FILES);
  const files: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  let scanned = 0;
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= maxFiles) return;
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch (err) {
      skipped.push({ file: relative(root, current) || ".", reason: `cannot read directory: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (files.length >= maxFiles) {
        skipped.push({ file: relative(root, join(current, item.name)), reason: `beyond the ${maxFiles} file limit` });
        continue;
      }
      if (item.name.startsWith(".") || SKIP_DIRS.has(item.name)) continue;
      const full = join(current, item.name);
      if (item.isDirectory()) {
        if (depth === 0 && options.includeDirs && options.includeDirs.length && !options.includeDirs.includes(item.name)) continue;
        await walk(full, depth + 1);
      } else if (item.isFile() && MARKDOWN.test(item.name)) {
        if (depth === 0 && options.includeDirs && options.includeDirs.length && !options.includeDirs.includes(".")) continue;
        files.push(full);
      }
    }
  }
  await walk(root, 0);
  const entries: Entry[] = [];
  for (const file of files) {
    scanned++;
    const rel = relative(root, file);
    const s = await stat(file);
    if (s.size > MAX_FILE_BYTES) {
      skipped.push({ file: rel, reason: `larger than ${MAX_FILE_BYTES} bytes` });
      continue;
    }
    const text = await readFile(file, "utf8");
    const meta = extractMeta(text, rel.split(sep).pop() ?? rel);
    const top = rel.includes(sep) ? rel.split(sep)[0] : "";
    entries.push({ file: rel.split(sep).join("/"), url: toUrl(rel, options.baseUrl, options.urlStyle ?? "strip-extension"), title: meta.title, description: meta.description, section: top ? humanise(top) : "Docs" });
  }
  return { entries, skipped, scanned };
}

export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

export function parseSitemap(xml: string): { urls: SitemapEntry[]; child_sitemaps: string[] } {
  const urls: SitemapEntry[] = [];
  const child: string[] = [];
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(m[1])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(m[1])?.[1];
    urls.push({ url: decode(loc), ...(lastmod ? { lastmod: lastmod.trim() } : {}) });
  }
  for (const m of xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(m[1])?.[1];
    if (loc) child.push(decode(loc));
  }
  return { urls, child_sitemaps: child };
}

export function entriesFromSitemap(urls: SitemapEntry[], options: { includePrefix?: string[]; excludePrefix?: string[] } = {}): Entry[] {
  const out: Entry[] = [];
  for (const { url } of urls) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const path = u.pathname;
    if (options.includePrefix?.length && !options.includePrefix.some((p) => path.startsWith(p))) continue;
    if (options.excludePrefix?.some((p) => path.startsWith(p))) continue;
    const segments = path.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const title = last ? humanise(last.replace(/\.html?$/i, "")) : "Home";
    const section = segments.length > 1 ? humanise(segments[0]) : "Pages";
    out.push({ file: url, url, title, description: "", section });
  }
  return out;
}

export interface RenderOptions {
  title: string;
  description?: string;
  details?: string;
  optionalSections?: string[];
}

export function render(entries: Entry[], options: RenderOptions): string {
  const optional = new Set((options.optionalSections ?? []).map((s) => s.toLowerCase()));
  const sections = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = sections.get(e.section) ?? [];
    list.push(e);
    sections.set(e.section, list);
  }
  const lines: string[] = [`# ${options.title.trim()}`, ""];
  if (options.description) lines.push(`> ${options.description.trim().replace(/\s+/g, " ")}`, "");
  if (options.details) lines.push(options.details.trim(), "");
  const names = [...sections.keys()].sort((a, b) => (a === "Docs" ? -1 : b === "Docs" ? 1 : a.localeCompare(b)));
  const optionalEntries: Entry[] = [];
  for (const name of names) {
    const list = sections.get(name) ?? [];
    if (optional.has(name.toLowerCase())) {
      optionalEntries.push(...list);
      continue;
    }
    lines.push(`## ${name}`, "");
    for (const e of list) lines.push(`- [${e.title}](${e.url})${e.description ? `: ${e.description}` : ""}`);
    lines.push("");
  }
  if (optionalEntries.length) {
    lines.push("## Optional", "");
    for (const e of optionalEntries) lines.push(`- [${e.title}](${e.url})${e.description ? `: ${e.description}` : ""}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export interface CheckResult {
  valid: boolean;
  errors: { line: number; message: string }[];
  warnings: { line: number; message: string }[];
  info: { line: number; message: string }[];
  stats: { title: string | null; has_summary: boolean; sections: string[]; links: number; bytes: number };
}

export function check(text: string): CheckResult {
  const errors: CheckResult["errors"] = [];
  const warnings: CheckResult["warnings"] = [];
  const info: CheckResult["info"] = [];
  const lines = text.split(/\r?\n/);
  let title: string | null = null;
  let hasSummary = false;
  const sections: string[] = [];
  const urls = new Map<string, number>();
  let links = 0;
  let currentSection: string | null = null;
  let sectionItems = 0;
  let sawH1 = false;
  let inCode = false;
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (firstContent === -1) {
    errors.push({ line: 1, message: "the file is empty" });
  } else if (!/^#\s+\S/.test(lines[firstContent])) {
    errors.push({ line: firstContent + 1, message: "the first line must be an H1 title (# Project name)" });
  }
  const closeSection = (lineNo: number) => {
    if (currentSection !== null && sectionItems === 0) warnings.push({ line: lineNo, message: `section "${currentSection}" has no link items` });
  };
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw.trimEnd();
    if (/^(```|~~~)/.test(line.trim())) {
      inCode = !inCode;
      if (inCode) info.push({ line: n, message: "code blocks are unusual in llms.txt; the file is meant to be a short index" });
      return;
    }
    if (inCode) return;
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      if (sawH1) errors.push({ line: n, message: "only one H1 is allowed; use ## for sections" });
      else {
        sawH1 = true;
        title = h1[1].trim();
      }
      return;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      closeSection(n);
      currentSection = h2[1].trim();
      sectionItems = 0;
      if (sections.map((s) => s.toLowerCase()).includes(currentSection.toLowerCase())) warnings.push({ line: n, message: `duplicate section "${currentSection}"` });
      sections.push(currentSection);
      if (currentSection.toLowerCase() === "optional") info.push({ line: n, message: "the Optional section marks links that can be skipped when context is short" });
      return;
    }
    if (/^#{3,6}\s/.test(line)) {
      warnings.push({ line: n, message: "H3 and deeper headings are not part of the convention; use H2 sections with link lists" });
      return;
    }
    if (/^>\s?/.test(line)) {
      if (currentSection === null && !hasSummary) hasSummary = true;
      else if (currentSection !== null) warnings.push({ line: n, message: "blockquotes belong in the summary before the first section" });
      return;
    }
    if (line.trim() === "") return;
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (item) {
      if (currentSection === null) {
        warnings.push({ line: n, message: "list items before the first ## section are not part of a file list" });
        return;
      }
      sectionItems++;
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?$/.exec(item[1].trim());
      if (!link) {
        errors.push({ line: n, message: "section items must be markdown links: - [name](url): optional notes" });
        return;
      }
      links++;
      const url = link[2];
      if (urls.has(url)) warnings.push({ line: n, message: `duplicate URL ${url} (first on line ${urls.get(url)})` });
      else urls.set(url, n);
      if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) info.push({ line: n, message: `relative URL ${url}; absolute URLs resolve from anywhere` });
      if (link[3] === undefined || link[3].trim() === "") info.push({ line: n, message: `link "${link[1]}" has no notes after the colon` });
      return;
    }
    if (currentSection !== null) warnings.push({ line: n, message: "paragraph text inside a section; sections should contain only link items" });
  });
  closeSection(lines.length);
  if (sawH1 && !hasSummary) warnings.push({ line: 1, message: "no blockquote summary after the title (recommended: > one-sentence description)" });
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > 100_000) warnings.push({ line: 1, message: `the file is ${bytes} bytes; keep llms.txt small and put full content in llms-full.txt` });
  if (sawH1 && sections.length === 0) info.push({ line: 1, message: "no ## sections; the file carries no links" });
  return { valid: errors.length === 0, errors, warnings, info, stats: { title, has_summary: hasSummary, sections, links, bytes } };
}
