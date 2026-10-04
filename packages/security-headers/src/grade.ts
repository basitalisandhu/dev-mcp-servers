/**
 * Pure grading of HTTP response security headers. No network access here.
 */

export type Status = "pass" | "warn" | "fail" | "info";

export interface Check {
  header: string;
  status: Status;
  value: string | null;
  points: number;
  max_points: number;
  explanation: string;
  recommendation: string;
}

export interface Report {
  grade: string;
  score: number;
  max_score: number;
  checks: Check[];
  notes: string[];
}

export const GRADED_HEADERS = [
  "content-security-policy",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "x-xss-protection",
  "server",
  "x-powered-by",
  "set-cookie",
] as const;
export type GradedHeader = (typeof GRADED_HEADERS)[number];

export const HEADER_DOCS: Record<GradedHeader, { purpose: string; recommended: string; reference: string }> = {
  "content-security-policy": {
    purpose: "Tells the browser which sources of scripts, styles, frames and other resources the page may load, which is the strongest mitigation for cross-site scripting and clickjacking.",
    recommended: "default-src 'self'; script-src 'self' 'nonce-<random>'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy",
  },
  "strict-transport-security": {
    purpose: "Instructs browsers to use HTTPS for every future request to the host, which blocks protocol-downgrade attacks and cookie hijacking over plain HTTP.",
    recommended: "max-age=31536000; includeSubDomains; preload",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Strict-Transport-Security",
  },
  "x-frame-options": {
    purpose: "Stops other sites from framing the page, which prevents clickjacking. Superseded by the CSP frame-ancestors directive but still read by older browsers.",
    recommended: "DENY (or SAMEORIGIN if the site frames itself)",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/X-Frame-Options",
  },
  "x-content-type-options": {
    purpose: "Prevents MIME type sniffing, so a file served as text is never executed as a script.",
    recommended: "nosniff",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/X-Content-Type-Options",
  },
  "referrer-policy": {
    purpose: "Controls how much of the current URL is sent in the Referer header on navigation and subresource requests, which limits leakage of paths and query strings.",
    recommended: "strict-origin-when-cross-origin (or no-referrer for the most privacy)",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Referrer-Policy",
  },
  "permissions-policy": {
    purpose: "Disables browser features such as camera, microphone, geolocation and payment for the page and for embedded frames.",
    recommended: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Permissions-Policy",
  },
  "cross-origin-opener-policy": {
    purpose: "Isolates the browsing context from cross-origin openers so another site cannot hold a reference to the window.",
    recommended: "same-origin",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Cross-Origin-Opener-Policy",
  },
  "cross-origin-resource-policy": {
    purpose: "Blocks other origins from reading the resource in no-cors requests, which mitigates speculative side-channel leaks.",
    recommended: "same-origin (or same-site)",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Cross-Origin-Resource-Policy",
  },
  "x-xss-protection": {
    purpose: "Legacy filter of old browsers. Modern browsers ignore it and the filter itself caused vulnerabilities; the header should be absent or 0.",
    recommended: "omit it, or send 0",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/X-XSS-Protection",
  },
  server: {
    purpose: "Names the server software. Version strings help attackers pick exploits; the header carries no benefit for clients.",
    recommended: "omit it or send a product name without a version",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Server",
  },
  "x-powered-by": {
    purpose: "Names the application framework. Pure information disclosure.",
    recommended: "omit it",
    reference: "https://owasp.org/www-project-secure-headers/",
  },
  "set-cookie": {
    purpose: "Cookie attributes decide whether a cookie is sent over plain HTTP, readable from JavaScript, or attached to cross-site requests.",
    recommended: "Secure; HttpOnly; SameSite=Lax (or Strict) on every session cookie, and a __Host- prefix where possible",
    reference: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie",
  },
};

export interface HeaderSet {
  /** Lower-cased header names mapped to the joined value. */
  headers: Record<string, string>;
  /** Every Set-Cookie value separately. */
  setCookie: string[];
  https: boolean;
}

function parseCsp(value: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    if (!directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

function cspCheck(value: string | null, reportOnly: string | null): Check {
  const base = { header: "content-security-policy", value, max_points: 25 };
  if (!value) {
    return {
      ...base,
      status: "fail",
      points: 0,
      explanation: reportOnly
        ? "Only a Content-Security-Policy-Report-Only header is set. Report-only policies are never enforced."
        : "No Content-Security-Policy header. The browser will load scripts from any origin and inline scripts injected by an attacker will run.",
      recommendation: `Add: ${HEADER_DOCS["content-security-policy"].recommended}`,
    };
  }
  const d = parseCsp(value);
  const problems: string[] = [];
  let points = 25;
  const scriptSrc = d.get("script-src") ?? d.get("default-src");
  if (!d.has("default-src") && !d.has("script-src")) {
    problems.push("neither default-src nor script-src is set, so script loading is unrestricted");
    points -= 15;
  }
  if (scriptSrc) {
    if (scriptSrc.includes("'unsafe-inline'") && !scriptSrc.some((s) => s.startsWith("'nonce-") || s.startsWith("'sha256-") || s.startsWith("'sha384-") || s.startsWith("'sha512-"))) {
      problems.push("script-src allows 'unsafe-inline' without a nonce or hash, which permits injected inline scripts");
      points -= 10;
    }
    if (scriptSrc.includes("'unsafe-eval'")) {
      problems.push("script-src allows 'unsafe-eval'");
      points -= 5;
    }
    if (scriptSrc.includes("*") || scriptSrc.some((s) => /^(https?:|http:|https:)$/.test(s))) {
      problems.push("script-src allows any host (* or a bare scheme)");
      points -= 10;
    }
    if (scriptSrc.includes("data:")) {
      problems.push("script-src allows data: URIs");
      points -= 5;
    }
  }
  if (!d.has("object-src") && !(d.get("default-src") ?? []).includes("'none'")) {
    problems.push("object-src is not set to 'none' (plugins such as Flash-style embeds can run scripts)");
    points -= 3;
  }
  if (!d.has("base-uri")) {
    problems.push("base-uri is not set, so an injected <base> tag can redirect relative script URLs");
    points -= 3;
  }
  if (!d.has("frame-ancestors")) {
    problems.push("frame-ancestors is not set, so clickjacking protection relies on X-Frame-Options alone");
    points -= 2;
  }
  points = Math.max(0, points);
  return {
    ...base,
    status: points === 25 ? "pass" : points >= 12 ? "warn" : "fail",
    points,
    explanation: problems.length ? `Policy present but: ${problems.join("; ")}.` : "Policy present with restricted script sources, object-src, base-uri and frame-ancestors.",
    recommendation: problems.length ? `Tighten the policy. A strong baseline: ${HEADER_DOCS["content-security-policy"].recommended}` : "Keep it, and add a nonce-based script-src if you still rely on host allowlists.",
  };
}

function hstsCheck(value: string | null, https: boolean): Check {
  const base = { header: "strict-transport-security", value, max_points: 20 };
  if (!https) {
    return { ...base, status: "info", points: 0, explanation: "The URL was fetched over plain HTTP; browsers ignore HSTS on HTTP responses.", recommendation: "Serve the site over HTTPS and send HSTS there." };
  }
  if (!value) return { ...base, status: "fail", points: 0, explanation: "No Strict-Transport-Security header, so a first visit over http:// can be downgraded.", recommendation: `Add: ${HEADER_DOCS["strict-transport-security"].recommended}` };
  const maxAge = Number(/max-age\s*=\s*"?(\d+)/i.exec(value)?.[1] ?? NaN);
  const subdomains = /includeSubDomains/i.test(value);
  const preload = /preload/i.test(value);
  if (!Number.isFinite(maxAge)) return { ...base, status: "fail", points: 0, explanation: "HSTS header has no valid max-age, so browsers ignore it.", recommendation: `Send: ${HEADER_DOCS["strict-transport-security"].recommended}` };
  if (maxAge === 0) return { ...base, status: "fail", points: 0, explanation: "max-age=0 clears the HSTS policy.", recommendation: "Set max-age to at least 31536000 (one year)." };
  let points = 20;
  const notes: string[] = [];
  if (maxAge < 15552000) {
    points -= 10;
    notes.push(`max-age ${maxAge} is under 180 days`);
  } else if (maxAge < 31536000) {
    points -= 4;
    notes.push(`max-age ${maxAge} is under one year`);
  }
  if (!subdomains) {
    points -= 4;
    notes.push("includeSubDomains is missing");
  }
  if (!preload) notes.push("preload is missing (optional, needed for the browser preload list)");
  return {
    ...base,
    status: points === 20 || (points >= 16 && !notes.some((n) => n.includes("max-age"))) ? "pass" : "warn",
    points,
    explanation: notes.length ? `HSTS present with max-age ${maxAge}. ${notes.join("; ")}.` : `HSTS present with max-age ${maxAge}, includeSubDomains and preload.`,
    recommendation: notes.length ? `Send: ${HEADER_DOCS["strict-transport-security"].recommended}` : "Keep it.",
  };
}

function xfoCheck(value: string | null, cspValue: string | null): Check {
  const base = { header: "x-frame-options", value, max_points: 10 };
  const frameAncestors = cspValue ? parseCsp(cspValue).get("frame-ancestors") : undefined;
  if (!value) {
    if (frameAncestors) return { ...base, status: "pass", points: 10, explanation: `Absent, but CSP frame-ancestors (${frameAncestors.join(" ")}) covers modern browsers.`, recommendation: "Optionally add X-Frame-Options: DENY for older browsers." };
    return { ...base, status: "fail", points: 0, explanation: "No X-Frame-Options and no CSP frame-ancestors, so any site can frame this page (clickjacking).", recommendation: "Add X-Frame-Options: DENY and CSP frame-ancestors 'none'." };
  }
  const v = value.trim().toUpperCase();
  if (v === "DENY" || v === "SAMEORIGIN") return { ...base, status: "pass", points: 10, explanation: `${v} blocks framing by other origins.`, recommendation: "Keep it, and set CSP frame-ancestors as well." };
  if (v.startsWith("ALLOW-FROM")) return { ...base, status: "warn", points: 3, explanation: "ALLOW-FROM is obsolete and ignored by current browsers, which then apply no restriction.", recommendation: "Replace with CSP frame-ancestors listing the allowed origin." };
  return { ...base, status: "fail", points: 0, explanation: `Unrecognised value ${JSON.stringify(value)}; browsers ignore invalid values.`, recommendation: "Use DENY or SAMEORIGIN." };
}

function xctoCheck(value: string | null): Check {
  const base = { header: "x-content-type-options", value, max_points: 10 };
  if (!value) return { ...base, status: "fail", points: 0, explanation: "Missing, so browsers may sniff content types and execute mislabelled files as scripts.", recommendation: "Add X-Content-Type-Options: nosniff." };
  if (value.trim().toLowerCase() === "nosniff") return { ...base, status: "pass", points: 10, explanation: "nosniff is set.", recommendation: "Keep it." };
  return { ...base, status: "fail", points: 0, explanation: `Value ${JSON.stringify(value)} is not nosniff and has no effect.`, recommendation: "Send exactly nosniff." };
}

function referrerCheck(value: string | null): Check {
  const base = { header: "referrer-policy", value, max_points: 10 };
  if (!value) return { ...base, status: "warn", points: 4, explanation: "Missing. Modern browsers default to strict-origin-when-cross-origin, older ones send the full URL cross-origin.", recommendation: "Add Referrer-Policy: strict-origin-when-cross-origin." };
  const policies = value.toLowerCase().split(",").map((p) => p.trim());
  const effective = policies[policies.length - 1];
  const strong = ["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin"];
  const weak = ["no-referrer-when-downgrade", "origin", "origin-when-cross-origin"];
  if (strong.includes(effective)) return { ...base, status: "pass", points: 10, explanation: `${effective} keeps paths and query strings from leaking cross-origin.`, recommendation: "Keep it." };
  if (effective === "unsafe-url") return { ...base, status: "fail", points: 0, explanation: "unsafe-url sends the full URL, including query strings, to every destination over any protocol.", recommendation: "Use strict-origin-when-cross-origin." };
  if (weak.includes(effective)) return { ...base, status: "warn", points: 5, explanation: `${effective} still leaks the origin or full URL in some cases.`, recommendation: "Use strict-origin-when-cross-origin or no-referrer." };
  return { ...base, status: "warn", points: 2, explanation: `Unrecognised policy ${JSON.stringify(effective)}; browsers fall back to the default.`, recommendation: "Use strict-origin-when-cross-origin." };
}

function permissionsCheck(value: string | null): Check {
  const base = { header: "permissions-policy", value, max_points: 5 };
  if (!value) return { ...base, status: "warn", points: 0, explanation: "Missing. Embedded frames and the page itself may request camera, microphone, geolocation and other features.", recommendation: `Add: ${HEADER_DOCS["permissions-policy"].recommended}` };
  return { ...base, status: "pass", points: 5, explanation: `Present with ${value.split(",").length} directive(s).`, recommendation: "Review that unused features are disabled with ()." };
}

function coopCheck(value: string | null): Check {
  const base = { header: "cross-origin-opener-policy", value, max_points: 5 };
  if (!value) return { ...base, status: "info", points: 0, explanation: "Missing. Cross-origin pages that open this one keep a window reference (needed only for some OAuth popups).", recommendation: "Add Cross-Origin-Opener-Policy: same-origin unless you rely on cross-origin window.opener." };
  const v = value.trim().toLowerCase();
  if (v === "same-origin" || v === "same-origin-allow-popups" || v === "noopener-allow-popups") return { ...base, status: "pass", points: 5, explanation: `${v} isolates the browsing context group.`, recommendation: "Keep it." };
  return { ...base, status: "info", points: 1, explanation: `${v} provides no isolation.`, recommendation: "Use same-origin." };
}

function corpCheck(value: string | null): Check {
  const base = { header: "cross-origin-resource-policy", value, max_points: 5 };
  if (!value) return { ...base, status: "info", points: 0, explanation: "Missing. Other origins can embed this resource in no-cors requests.", recommendation: "Add Cross-Origin-Resource-Policy: same-origin for private resources." };
  const v = value.trim().toLowerCase();
  if (v === "same-origin" || v === "same-site") return { ...base, status: "pass", points: 5, explanation: `${v} blocks cross-origin no-cors reads.`, recommendation: "Keep it." };
  return { ...base, status: "info", points: 1, explanation: `${v} allows any origin to embed the resource (fine for public assets).`, recommendation: "Use same-origin for private resources." };
}

function xssCheck(value: string | null): Check {
  const base = { header: "x-xss-protection", value, max_points: 0 };
  if (!value || value.trim() === "0") return { ...base, status: "pass", points: 0, explanation: value ? "Set to 0, which disables the legacy filter." : "Absent, which is correct for modern browsers.", recommendation: "Nothing to do." };
  return { ...base, status: "warn", points: 0, explanation: "The legacy XSS auditor is enabled. It is removed from current browsers and introduced information leaks in old ones.", recommendation: "Remove the header or send X-XSS-Protection: 0, and rely on CSP." };
}

function disclosureCheck(header: "server" | "x-powered-by", value: string | null): Check {
  const base = { header, value, max_points: 0 };
  if (!value) return { ...base, status: "pass", points: 0, explanation: "Absent.", recommendation: "Nothing to do." };
  const versioned = /\d+\.\d+/.test(value);
  return {
    ...base,
    status: versioned ? "warn" : "info",
    points: 0,
    explanation: versioned ? `Discloses software and version (${value}), which helps attackers select exploits.` : `Discloses software (${value}) without a version.`,
    recommendation: header === "server" ? "Remove the version string or the header." : "Remove the header (for example app.disable('x-powered-by') in Express).",
  };
}

function cookieCheck(cookies: string[], https: boolean): Check {
  const base = { header: "set-cookie", value: cookies.length ? cookies.map((c) => c.split(";")[0]).join(", ") : null, max_points: 10 };
  if (cookies.length === 0) return { ...base, status: "info", points: 10, explanation: "No cookies set on this response.", recommendation: "Nothing to do." };
  const problems: string[] = [];
  for (const c of cookies) {
    const name = c.split("=")[0].trim();
    const attrs = c.toLowerCase();
    const missing: string[] = [];
    if (https && !/;\s*secure(;|$)/.test(attrs)) missing.push("Secure");
    if (!/;\s*httponly(;|$)/.test(attrs)) missing.push("HttpOnly");
    if (!/;\s*samesite=/.test(attrs)) missing.push("SameSite");
    if (/;\s*samesite=none/.test(attrs) && !/;\s*secure(;|$)/.test(attrs)) missing.push("Secure (required with SameSite=None)");
    if (missing.length) problems.push(`${name} lacks ${missing.join(", ")}`);
  }
  const points = Math.max(0, 10 - problems.length * 4);
  return {
    ...base,
    status: problems.length ? "warn" : "pass",
    points,
    explanation: problems.length ? `${cookies.length} cookie(s); ${problems.join("; ")}.` : `${cookies.length} cookie(s) with Secure, HttpOnly and SameSite.`,
    recommendation: problems.length ? "Add Secure, HttpOnly and SameSite=Lax (or Strict) to session cookies; use the __Host- prefix to bind them to the host." : "Keep it.",
  };
}

export function gradeHeaders(set: HeaderSet): Report {
  const h = set.headers;
  const get = (name: string): string | null => (name in h ? h[name] : null);
  const checks: Check[] = [
    cspCheck(get("content-security-policy"), get("content-security-policy-report-only")),
    hstsCheck(get("strict-transport-security"), set.https),
    xfoCheck(get("x-frame-options"), get("content-security-policy")),
    xctoCheck(get("x-content-type-options")),
    referrerCheck(get("referrer-policy")),
    permissionsCheck(get("permissions-policy")),
    coopCheck(get("cross-origin-opener-policy")),
    corpCheck(get("cross-origin-resource-policy")),
    xssCheck(get("x-xss-protection")),
    disclosureCheck("server", get("server")),
    disclosureCheck("x-powered-by", get("x-powered-by")),
    cookieCheck(set.setCookie, set.https),
  ];
  const score = checks.reduce((n, c) => n + c.points, 0);
  const max = checks.reduce((n, c) => n + c.max_points, 0);
  const pct = max ? (score / max) * 100 : 0;
  const fails = checks.filter((c) => c.status === "fail").length;
  let grade = "F";
  if (pct >= 95 && fails === 0) grade = "A+";
  else if (pct >= 85 && fails === 0) grade = "A";
  else if (pct >= 70) grade = "B";
  else if (pct >= 55) grade = "C";
  else if (pct >= 40) grade = "D";
  const notes: string[] = [];
  if (!set.https) notes.push("Fetched over plain HTTP: HSTS and Secure cookies cannot be assessed properly.");
  if (get("content-security-policy-report-only")) notes.push("A report-only CSP is present; it collects reports but enforces nothing.");
  return { grade, score, max_score: max, checks, notes };
}

/** Normalise a caller-supplied header object: lower-case names, split Set-Cookie lines. */
export function toHeaderSet(headers: Record<string, string | string[]>, https: boolean): HeaderSet {
  const out: Record<string, string> = {};
  const setCookie: string[] = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (name === "set-cookie") {
      setCookie.push(...values);
      continue;
    }
    out[name] = values.join(", ");
  }
  return { headers: out, setCookie, https };
}
