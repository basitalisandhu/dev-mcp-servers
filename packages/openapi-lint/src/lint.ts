/**
 * OpenAPI 3.x loading, operation listing and linting. Only local (#/...) references are resolved.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export type Method = (typeof METHODS)[number];

export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  path: string;
  message: string;
}

export interface RuleDoc {
  severity: Severity;
  description: string;
  fix: string;
}

export const RULES: Record<string, RuleDoc> = {
  "openapi-version": { severity: "error", description: "The document must declare an OpenAPI 3.x version in the top-level openapi field.", fix: "Add openapi: 3.0.3 (or 3.1.0). Swagger 2.0 documents use a different structure and must be converted." },
  "info-description": { severity: "info", description: "info has no description, so consumers see only a title.", fix: "Add info.description with the API's purpose, audience and authentication model." },
  "server-http": { severity: "warning", description: "A server URL uses plain http://, so credentials and data travel unencrypted.", fix: "Use https:// server URLs. Keep http only for an explicitly local development server." },
  "no-security-schemes": { severity: "warning", description: "components.securitySchemes is empty, so no operation can declare how it is authenticated.", fix: "Define at least one scheme (http bearer, apiKey, oauth2 or openIdConnect) under components.securitySchemes and reference it in security." },
  "operation-no-security": { severity: "warning", description: "The operation has no security requirement and no global security applies, so it is documented as anonymous.", fix: "Add a security requirement to the operation, or a top-level security array for the whole API. Use security: [] only for intentionally public operations." },
  "operation-public": { severity: "info", description: "The operation sets security: [] and is therefore explicitly public.", fix: "Confirm the endpoint is meant to be callable without credentials." },
  "security-scheme-undefined": { severity: "error", description: "A security requirement names a scheme that components.securitySchemes does not define.", fix: "Define the scheme or correct the name in the security requirement." },
  "unused-security-scheme": { severity: "info", description: "A security scheme is defined but never referenced.", fix: "Reference it from security or remove it." },
  "operation-no-responses": { severity: "error", description: "The operation has no responses object or it is empty; the specification requires at least one response.", fix: "Document at least the success response and the common error responses." },
  "operation-no-success-response": { severity: "warning", description: "No 2xx, 3xx or default response is documented.", fix: "Add the success response (for example 200 or 204) with its content." },
  "response-no-description": { severity: "warning", description: "A response has no description; the specification requires one.", fix: "Add a short description to every response." },
  "operation-no-description": { severity: "warning", description: "The operation has neither a summary nor a description.", fix: "Add a summary (one line) and, where useful, a description." },
  "operation-no-operation-id": { severity: "warning", description: "The operation has no operationId, which code generators and tooling use to name functions.", fix: "Add a unique, camelCase operationId such as listUsers." },
  "duplicate-operation-id": { severity: "error", description: "The same operationId is used by more than one operation.", fix: "Give every operation a unique operationId." },
  "path-unversioned": { severity: "info", description: "Neither the path nor any server URL contains a version segment such as /v1.", fix: "Version the API in the path or in the server URL so clients can pin a version." },
  "path-parameter-undefined": { severity: "error", description: "The path contains a {parameter} that no path-level or operation-level parameter with in: path declares.", fix: "Declare the parameter with in: path and required: true." },
  "path-parameter-not-required": { severity: "error", description: "A parameter with in: path is not marked required: true, which the specification demands.", fix: "Set required: true on every path parameter." },
  "parameter-no-description": { severity: "info", description: "A parameter has no description.", fix: "Describe the parameter's meaning, format and default." },
  "parameter-no-schema": { severity: "warning", description: "A parameter has neither schema nor content, so its type is unknown.", fix: "Add a schema (type, format, enum) to the parameter." },
  "request-body-no-content": { severity: "warning", description: "A requestBody declares no content media types.", fix: "Add content with at least one media type and schema." },
  "deprecated-operation": { severity: "info", description: "The operation is marked deprecated.", fix: "Document the replacement in the description and plan removal." },
  "tag-undefined": { severity: "info", description: "An operation uses a tag that is not declared in the top-level tags list.", fix: "Declare the tag with a description under tags, which groups operations in generated documentation." },
  "security-scheme-apikey-query": { severity: "warning", description: "An apiKey security scheme places the credential in the query string, which is recorded in server logs, proxy logs and browser history.", fix: "Move the API key to a header (in: header) or to a cookie. Query-string credentials are hard to keep out of logs." },
  "security-scheme-http-basic": { severity: "info", description: "An HTTP Basic scheme sends the username and password on every request, base64-encoded rather than hashed.", fix: "Prefer a bearer token or OAuth 2.0. Basic is acceptable only for internal tools or when the transport is strictly HTTPS and the credentials are short-lived." },
  "operation-no-error-response": { severity: "info", description: "The operation documents no 4xx, 5xx or default response, so clients cannot know what an error looks like.", fix: "Document at least one error response (for example 400, 401, 404 or 500) or a default response with its content." },
};

export type Doc = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseDocument(text: string): Doc {
  if (text.length > MAX_DOCUMENT_BYTES) throw new Error(`document exceeds ${MAX_DOCUMENT_BYTES} characters`);
  let doc: unknown;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new Error(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    try {
      doc = parseYaml(text, { maxAliasCount: 100, uniqueKeys: false });
    } catch (err) {
      throw new Error(`not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!isObject(doc)) throw new Error("the document is not an object");
  return doc;
}

export async function loadDocument(input: { path?: string; document?: string | Record<string, unknown> }): Promise<{ doc: Doc; source: string }> {
  const given = [input.path, input.document].filter((v) => v !== undefined).length;
  if (given !== 1) throw new Error("supply exactly one of path or document");
  if (input.path !== undefined) {
    const abs = resolve(input.path);
    const st = await stat(abs).catch((err: Error) => {
      throw new Error(`cannot read ${abs}: ${err.message}`);
    });
    if (!st.isFile()) throw new Error(`${abs} is not a file`);
    if (st.size > MAX_DOCUMENT_BYTES) throw new Error(`${abs} is ${st.size} bytes; the limit is ${MAX_DOCUMENT_BYTES}`);
    return { doc: parseDocument(await readFile(abs, "utf8")), source: abs };
  }
  if (typeof input.document === "string") return { doc: parseDocument(input.document), source: "inline" };
  if (!isObject(input.document)) throw new Error("document must be an object or a string");
  if (JSON.stringify(input.document).length > MAX_DOCUMENT_BYTES) throw new Error(`document exceeds ${MAX_DOCUMENT_BYTES} characters`);
  return { doc: input.document, source: "inline" };
}

/** Resolve a local JSON pointer reference such as #/components/parameters/Id. */
export function deref<T = unknown>(doc: Doc, value: unknown, depth = 0): T {
  if (!isObject(value) || typeof value.$ref !== "string" || depth > 16) return value as T;
  const ref = value.$ref;
  if (!ref.startsWith("#/")) return value as T;
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = doc;
  for (const p of parts) {
    if (!isObject(cur) || !(p in cur)) return value as T;
    cur = cur[p];
  }
  return deref<T>(doc, cur, depth + 1);
}

export function lint(doc: Doc, options: { ignore?: string[] } = {}): Finding[] {
  const findings: Finding[] = [];
  const ignore = new Set(options.ignore ?? []);
  const add = (rule: string, path: string, message: string) => {
    if (ignore.has(rule)) return;
    findings.push({ rule, severity: RULES[rule].severity, path, message });
  };

  const version = typeof doc.openapi === "string" ? doc.openapi : undefined;
  if (!version || !/^3\.\d+(\.\d+)?/.test(version)) {
    add("openapi-version", "/openapi", version ? `openapi is ${JSON.stringify(version)}, not 3.x` : doc.swagger ? `this is a Swagger ${String(doc.swagger)} document` : "openapi field is missing");
  }
  const info = isObject(doc.info) ? doc.info : {};
  if (typeof info.description !== "string" || info.description.trim() === "") add("info-description", "/info", "info.description is missing");

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  let versionedServer = false;
  servers.forEach((s, i) => {
    if (!isObject(s) || typeof s.url !== "string") return;
    if (/^http:\/\//i.test(s.url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s.url)) add("server-http", `/servers/${i}`, `${s.url} is not HTTPS`);
    if (/\/v\d+(\.\d+)*(\/|$)/i.test(s.url) || /\{version\}/i.test(s.url)) versionedServer = true;
  });

  const components = isObject(doc.components) ? doc.components : {};
  const schemes = isObject(components.securitySchemes) ? Object.keys(components.securitySchemes) : [];
  if (schemes.length === 0) add("no-security-schemes", "/components/securitySchemes", "no security schemes are defined");
  else {
    const schemeDefs = isObject(components.securitySchemes) ? components.securitySchemes : {};
    for (const name of schemes) {
      const s = schemeDefs[name];
      if (!isObject(s)) continue;
      if (s.type === "apiKey" && s.in === "query") add("security-scheme-apikey-query", `/components/securitySchemes/${name}`, `security scheme ${JSON.stringify(name)} puts the API key in the query string`);
      if (s.type === "http" && typeof s.scheme === "string" && s.scheme.toLowerCase() === "basic") add("security-scheme-http-basic", `/components/securitySchemes/${name}`, `security scheme ${JSON.stringify(name)} uses HTTP Basic`);
    }
  }
  const used = new Set<string>();
  const checkSecurity = (req: unknown, path: string) => {
    if (!Array.isArray(req)) return;
    req.forEach((r, i) => {
      if (!isObject(r)) return;
      for (const name of Object.keys(r)) {
        used.add(name);
        if (!schemes.includes(name)) add("security-scheme-undefined", `${path}/${i}`, `security scheme ${JSON.stringify(name)} is not defined in components.securitySchemes`);
      }
    });
  };
  checkSecurity(doc.security, "/security");
  const globalSecurity = Array.isArray(doc.security) && doc.security.length > 0;

  const declaredTags = new Set(Array.isArray(doc.tags) ? doc.tags.map((t) => (isObject(t) ? String(t.name) : String(t))) : []);
  const operationIds = new Map<string, string>();
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref<Record<string, unknown>>(doc, rawItem);
    if (!isObject(item)) continue;
    const pathPointer = `/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (!versionedServer && !/\/v\d+(\.\d+)*(\/|$)/i.test(path)) add("path-unversioned", pathPointer, `${path} has no version segment and no server URL is versioned`);
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const opPointer = `${pathPointer}/${method}`;
      const label = `${method.toUpperCase()} ${path}`;
      if (typeof op.operationId !== "string" || op.operationId === "") add("operation-no-operation-id", opPointer, `${label} has no operationId`);
      else if (operationIds.has(op.operationId)) add("duplicate-operation-id", opPointer, `operationId ${JSON.stringify(op.operationId)} is also used by ${operationIds.get(op.operationId)}`);
      else operationIds.set(op.operationId, label);
      if ((typeof op.summary !== "string" || op.summary.trim() === "") && (typeof op.description !== "string" || op.description.trim() === "")) add("operation-no-description", opPointer, `${label} has neither summary nor description`);
      if (op.deprecated === true) add("deprecated-operation", opPointer, `${label} is deprecated`);
      if (Array.isArray(op.tags)) for (const t of op.tags) if (!declaredTags.has(String(t))) add("tag-undefined", `${opPointer}/tags`, `${label} uses undeclared tag ${JSON.stringify(t)}`);

      if (op.security === undefined) {
        if (!globalSecurity) add("operation-no-security", opPointer, `${label} has no security requirement and there is no global security`);
      } else if (Array.isArray(op.security) && op.security.length === 0) add("operation-public", `${opPointer}/security`, `${label} is explicitly public (security: [])`);
      else checkSecurity(op.security, `${opPointer}/security`);

      const params = [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
      const pathParamNames = new Set<string>();
      for (const raw of params) {
        const p = deref<Record<string, unknown>>(doc, raw);
        if (!isObject(p)) continue;
        if (p.in === "path") pathParamNames.add(String(p.name));
        if (typeof p.description !== "string" || p.description.trim() === "") add("parameter-no-description", `${opPointer}/parameters`, `${label}: parameter ${JSON.stringify(p.name)} has no description`);
        if (!isObject(p.schema) && !isObject(p.content)) add("parameter-no-schema", `${opPointer}/parameters`, `${label}: parameter ${JSON.stringify(p.name)} has neither schema nor content`);
        if (p.in === "path" && p.required !== true) add("path-parameter-not-required", `${opPointer}/parameters`, `${label}: path parameter ${JSON.stringify(p.name)} is not required`);
      }
      for (const name of templated) if (!pathParamNames.has(name)) add("path-parameter-undefined", pathPointer, `${path} has no path parameter named ${JSON.stringify(name)}`);

      const body = deref<Record<string, unknown>>(doc, op.requestBody);
      if (isObject(body) && (!isObject(body.content) || Object.keys(body.content).length === 0)) add("request-body-no-content", `${opPointer}/requestBody`, `${label}: requestBody has no content`);

      const responses = isObject(op.responses) ? op.responses : undefined;
      if (!responses || Object.keys(responses).length === 0) {
        add("operation-no-responses", `${opPointer}/responses`, `${label} documents no responses`);
      } else {
        const codes = Object.keys(responses);
        if (!codes.some((c) => c === "default" || /^[23]/.test(c))) add("operation-no-success-response", `${opPointer}/responses`, `${label} documents only ${codes.join(", ")}`);
        if (!codes.some((c) => /^[45]/.test(c) || c === "default")) add("operation-no-error-response", `${opPointer}/responses`, `${label} documents no 4xx, 5xx or default response`);
        for (const code of codes) {
          const r = deref<Record<string, unknown>>(doc, responses[code]);
          if (isObject(r) && (typeof r.description !== "string" || r.description.trim() === "")) add("response-no-description", `${opPointer}/responses/${code}`, `${label}: response ${code} has no description`);
        }
      }
    }
  }
  for (const name of schemes) if (!used.has(name)) add("unused-security-scheme", `/components/securitySchemes/${name}`, `security scheme ${JSON.stringify(name)} is never referenced`);
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));
}
