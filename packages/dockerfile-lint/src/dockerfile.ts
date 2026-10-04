/**
 * Dockerfile parsing (comments, escape directive, line continuations, heredocs, stages) and lint rules.
 */

export const MAX_DOCKERFILE_BYTES = 1024 * 1024;

export interface Instruction {
  line: number;
  end_line: number;
  instruction: string;
  args: string;
  stage: number;
}

export interface Stage {
  index: number;
  name: string | null;
  base: string;
  line: number;
}

export interface Parsed {
  instructions: Instruction[];
  stages: Stage[];
  escape: string;
}

export function parseDockerfile(text: string): Parsed {
  if (text.length > MAX_DOCKERFILE_BYTES) throw new Error(`Dockerfile exceeds ${MAX_DOCKERFILE_BYTES} characters`);
  const lines = text.split(/\r?\n/);
  let escape = "\\";
  const instructions: Instruction[] = [];
  const stages: Stage[] = [];
  let stage = -1;
  let i = 0;
  // Parser directives appear before the first instruction or comment.
  while (i < lines.length) {
    const m = /^#\s*escape\s*=\s*(\S)\s*$/i.exec(lines[i]);
    if (m) {
      escape = m[1];
      i++;
      continue;
    }
    if (/^\s*#/.test(lines[i]) && /^#\s*\w+\s*=/.test(lines[i])) {
      i++;
      continue;
    }
    break;
  }
  while (i < lines.length) {
    const raw = lines[i];
    if (raw.trim() === "" || raw.trim().startsWith("#")) {
      i++;
      continue;
    }
    const start = i;
    let logical = raw;
    while (logical.trimEnd().endsWith(escape) && i + 1 < lines.length) {
      logical = logical.trimEnd().slice(0, -1).trimEnd();
      i++;
      const next = lines[i];
      if (next.trim().startsWith("#")) {
        logical += escape;
        continue;
      }
      logical += " " + next.trimStart();
    }
    const heredoc = /<<-?\s*["']?([A-Za-z_][\w]*)["']?/.exec(logical);
    let endLine = i;
    if (heredoc) {
      const terminator = heredoc[1];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== terminator) j++;
      if (j < lines.length) {
        logical += "\n" + lines.slice(i + 1, j + 1).join("\n");
        endLine = j;
        i = j;
      }
    }
    i++;
    const m = /^\s*([A-Za-z]+)\s*(.*)$/s.exec(logical);
    if (!m) continue;
    const instruction = m[1].toUpperCase();
    const args = m[2].trim();
    if (instruction === "FROM") {
      stage++;
      const parts = args.replace(/--\S+\s+/g, "").split(/\s+/);
      const asIdx = parts.findIndex((p) => p.toUpperCase() === "AS");
      stages.push({ index: stage, name: asIdx > 0 && parts[asIdx + 1] ? parts[asIdx + 1] : null, base: parts[0] ?? "", line: start + 1 });
    }
    instructions.push({ line: start + 1, end_line: endLine + 1, instruction, args, stage });
  }
  return { instructions, stages, escape };
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  line: number;
  message: string;
  fix: string;
}

export interface RuleDoc {
  severity: Severity;
  description: string;
  fix: string;
}

export const RULES: Record<string, RuleDoc> = {
  "root-user": { severity: "warning", description: "The final stage runs as root: there is no USER instruction, or the last one selects root or uid 0.", fix: "Create an unprivileged user in the image and add USER <name> after the last instruction that needs root." },
  "latest-tag": { severity: "warning", description: "A base image is used without a tag or with :latest, so the build is not reproducible and can silently change.", fix: "Pin a specific tag such as node:22-bookworm-slim." },
  "unpinned-digest": { severity: "info", description: "A base image is pinned by tag only; tags can be re-pointed, a digest cannot.", fix: "Add the digest: FROM node:22-bookworm-slim@sha256:<digest>, and update it with your dependency tooling." },
  "secret-in-env": { severity: "error", description: "An ENV sets a variable whose name suggests a credential; the value is stored in the image configuration and every layer that reads it.", fix: "Pass secrets at run time (environment from the orchestrator or a secrets manager) and never through ENV." },
  "secret-in-arg": { severity: "warning", description: "An ARG named like a credential; build arguments are recorded in the image history (docker history) even without a default.", fix: "Use RUN --mount=type=secret,id=<name> and read the secret from /run/secrets/<name> during the build." },
  "secret-literal": { severity: "error", description: "A line contains what looks like a credential literal (private key header, cloud access key id, token prefix, password flag).", fix: "Remove the literal, rotate the credential, and use a build secret mount." },
  "no-healthcheck": { severity: "info", description: "The final stage has no HEALTHCHECK, so the runtime cannot tell a hung container from a healthy one.", fix: "Add HEALTHCHECK --interval=30s --timeout=3s CMD <probe> || exit 1, or HEALTHCHECK NONE deliberately for a base image." },
  "apt-no-cleanup": { severity: "warning", description: "apt-get install runs without removing /var/lib/apt/lists in the same RUN, so the package index is baked into the layer.", fix: "Append && rm -rf /var/lib/apt/lists/* to the same RUN instruction." },
  "apt-no-recommends": { severity: "info", description: "apt-get install without --no-install-recommends pulls in packages that are rarely needed in a container.", fix: "Add --no-install-recommends to apt-get install." },
  "apt-upgrade": { severity: "info", description: "apt-get upgrade or dist-upgrade in a Dockerfile makes the result depend on the day it was built.", fix: "Use an up-to-date base image tag instead of upgrading at build time." },
  "apk-no-cache": { severity: "info", description: "apk add without --no-cache leaves the package index in the layer.", fix: "Use apk add --no-cache <packages>." },
  "pip-no-cache": { severity: "info", description: "pip install without --no-cache-dir keeps downloaded wheels in the layer.", fix: "Use pip install --no-cache-dir, or a cache mount." },
  "add-for-copy": { severity: "warning", description: "ADD is used for a plain local file or directory. ADD also extracts archives and fetches URLs, which is surprising; COPY does only what it says.", fix: "Use COPY for local files. Keep ADD only for extracting a local tar archive." },
  "add-remote": { severity: "warning", description: "ADD fetches a remote URL at build time with no checksum, so the image depends on the remote content at build time.", fix: "Download with curl or wget in a RUN, verify the checksum, and remove the downloader's cache; or vendor the file." },
  "curl-pipe-shell": { severity: "error", description: "A RUN pipes downloaded content straight into a shell, executing whatever the server (or an attacker in the path) returns.", fix: "Download to a file, verify a checksum or signature, then run it." },
  sudo: { severity: "warning", description: "RUN uses sudo; the build already runs as root until USER, and sudo in images adds a setuid binary.", fix: "Run the command directly before switching to a non-root user." },
  "workdir-relative": { severity: "warning", description: "WORKDIR is relative, so it depends on the previous WORKDIR and on the base image.", fix: "Use an absolute path such as WORKDIR /app." },
  "multiple-cmd": { severity: "warning", description: "More than one CMD (or ENTRYPOINT) in a stage; only the last one takes effect.", fix: "Keep one CMD and one ENTRYPOINT per stage." },
  "shell-form-cmd": { severity: "info", description: "CMD or ENTRYPOINT uses shell form, so the process runs under /bin/sh -c and does not receive SIGTERM directly.", fix: "Use exec (JSON array) form: CMD [\"node\", \"server.js\"]." },
  "expose-ssh": { severity: "warning", description: "EXPOSE 22 suggests an SSH daemon in the container.", fix: "Remove SSH from the image and use docker exec or the orchestrator's exec for debugging." },
  "maintainer-deprecated": { severity: "info", description: "MAINTAINER is deprecated.", fix: "Use LABEL org.opencontainers.image.authors=\"...\"." },
  "copy-whole-context": { severity: "info", description: "COPY copies the entire build context; without a .dockerignore this includes .git, node_modules, .env files and other secrets.", fix: "Copy only what the image needs, and add a .dockerignore that excludes .git, .env*, node_modules and build output." },
  "copy-chown-missing": { severity: "info", description: "Files are copied as root after USER switched to a non-root user, so the application cannot write to them.", fix: "Use COPY --chown=<user>:<group> when the application needs write access, or copy before switching USER if read-only is intended." },
  "empty-dockerfile": { severity: "error", description: "No instructions were found.", fix: "A Dockerfile starts with FROM (or ARG followed by FROM)." },
  "from-missing": { severity: "error", description: "The first non-ARG instruction is not FROM.", fix: "Start with FROM <image>." },
};

const SECRET_NAME = /(PASS(WORD|WD)?|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIALS?|AUTH[_-]?KEY|CLIENT[_-]?SECRET)/i;
const SECRET_LITERAL = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|--password[= ]\S+|-p\s*['"]?[^\s'"$]{6,})/;
const ARCHIVE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz)$/i;

function splitArgs(args: string): string[] {
  return args.replace(/--\S+(=\S+)?\s+/g, "").trim().split(/\s+/).filter(Boolean);
}

function envPairs(args: string): [string, string | undefined][] {
  const pairs: [string, string | undefined][] = [];
  const re = /([A-Za-z_][\w.-]*)(?:=("(?:[^"\\]|\\.)*"|'[^']*'|\S*))?/g;
  const trimmed = args.trim();
  // Legacy ENV KEY value form.
  if (!/=/.test(trimmed.split(/\s+/)[0] ?? "") && trimmed.split(/\s+/).length >= 2 && !trimmed.includes("=")) {
    const [key, ...rest] = trimmed.split(/\s+/);
    return [[key, rest.join(" ")]];
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    pairs.push([m[1], m[2]]);
  }
  return pairs;
}

export function lint(parsed: Parsed, options: { ignore?: string[] } = {}): Finding[] {
  const findings: Finding[] = [];
  const ignore = new Set(options.ignore ?? []);
  const add = (rule: string, line: number, message: string) => {
    if (ignore.has(rule)) return;
    findings.push({ rule, severity: RULES[rule].severity, line, message, fix: RULES[rule].fix });
  };
  const { instructions, stages } = parsed;
  if (instructions.length === 0) {
    add("empty-dockerfile", 1, "no instructions found");
    return findings;
  }
  const firstReal = instructions.find((x) => x.instruction !== "ARG");
  if (firstReal && firstReal.instruction !== "FROM") add("from-missing", firstReal.line, `first instruction is ${firstReal.instruction}, expected FROM`);

  const stageNames = new Set(stages.map((s) => s.name).filter((n): n is string => n !== null));
  const argNames = new Set(instructions.filter((x) => x.instruction === "ARG" && x.stage === -1).map((x) => x.args.split("=")[0].trim()));
  for (const s of stages) {
    const base = s.base;
    if (base === "scratch" || stageNames.has(base) || /^\d+$/.test(base)) continue;
    if (/^\$/.test(base) || base.includes("${")) {
      const name = base.replace(/^\$\{?([A-Za-z_]\w*).*$/, "$1");
      if (!argNames.has(name)) add("latest-tag", s.line, `FROM ${base} uses an undeclared build argument; the tag cannot be checked`);
      continue;
    }
    const hasDigest = base.includes("@sha256:");
    const withoutDigest = base.split("@")[0];
    const tag = withoutDigest.includes("/") ? withoutDigest.slice(withoutDigest.lastIndexOf("/")).split(":")[1] : withoutDigest.split(":")[1];
    if (!hasDigest && (tag === undefined || tag === "latest")) add("latest-tag", s.line, `FROM ${base} ${tag === "latest" ? "uses the latest tag" : "has no tag"}`);
    else if (!hasDigest) add("unpinned-digest", s.line, `FROM ${base} is pinned by tag only`);
  }

  for (const ins of instructions) {
    const a = ins.args;
    switch (ins.instruction) {
      case "ENV":
        for (const [key, value] of envPairs(a)) {
          if (SECRET_NAME.test(key) && value !== undefined && value !== "" && !/^\$/.test(value.replace(/^["']/, ""))) add("secret-in-env", ins.line, `ENV ${key} looks like a credential with a literal value`);
        }
        break;
      case "ARG": {
        const [key, value] = a.split("=");
        if (SECRET_NAME.test(key.trim())) add("secret-in-arg", ins.line, `ARG ${key.trim()}${value !== undefined ? " has a default value and" : ""} is recorded in the image history`);
        break;
      }
      case "RUN": {
        if (SECRET_LITERAL.test(a)) add("secret-literal", ins.line, "RUN contains what looks like a credential literal");
        if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(a) || /\b(ba|z)?sh\s+<\(\s*(curl|wget)/.test(a)) add("curl-pipe-shell", ins.line, "downloaded content is piped into a shell");
        if (/(^|[\s;&|])sudo\s/.test(a)) add("sudo", ins.line, "RUN uses sudo");
        if (/\bapt(-get)?\s+(-\S+\s+)*install\b/.test(a)) {
          if (!/rm\s+(-\S+\s+)*\/var\/lib\/apt\/lists/.test(a) && !/--mount=type=cache,[^ ]*\/var\/lib\/apt/.test(a)) add("apt-no-cleanup", ins.line, "apt-get install without rm -rf /var/lib/apt/lists/* in the same RUN");
          if (!/--no-install-recommends/.test(a)) add("apt-no-recommends", ins.line, "apt-get install without --no-install-recommends");
        }
        if (/\bapt(-get)?\s+(-\S+\s+)*(dist-)?upgrade\b/.test(a)) add("apt-upgrade", ins.line, "apt-get upgrade at build time");
        if (/\bapk\s+(-\S+\s+)*add\b/.test(a) && !/--no-cache/.test(a) && !/--mount=type=cache/.test(a)) add("apk-no-cache", ins.line, "apk add without --no-cache");
        if (/\bpip3?\s+(-\S+\s+)*install\b/.test(a) && !/--no-cache-dir/.test(a) && !/--mount=type=cache/.test(a)) add("pip-no-cache", ins.line, "pip install without --no-cache-dir");
        break;
      }
      case "ADD": {
        const parts = splitArgs(a);
        const sources = parts.slice(0, -1);
        for (const src of sources) {
          if (/^https?:\/\//i.test(src) || /^git@/.test(src)) add("add-remote", ins.line, `ADD fetches ${src}`);
          else if (!ARCHIVE.test(src)) add("add-for-copy", ins.line, `ADD ${src} copies a plain file or directory`);
        }
        break;
      }
      case "COPY": {
        const parts = splitArgs(a);
        if (parts.length >= 2 && (parts[0] === "." || parts[0] === "./" || parts[0] === "*") && !/--from=/.test(a)) add("copy-whole-context", ins.line, `COPY ${parts[0]} ${parts[parts.length - 1]} copies the whole build context`);
        break;
      }
      case "WORKDIR":
        if (!/^(\/|[A-Za-z]:\\|\$)/.test(a) && !a.startsWith("${")) add("workdir-relative", ins.line, `WORKDIR ${a} is relative`);
        break;
      case "EXPOSE":
        if (/(^|\s)22(\/tcp)?(\s|$)/.test(a)) add("expose-ssh", ins.line, "EXPOSE 22");
        break;
      case "MAINTAINER":
        add("maintainer-deprecated", ins.line, "MAINTAINER is deprecated");
        break;
      case "CMD":
      case "ENTRYPOINT":
        if (!a.startsWith("[")) add("shell-form-cmd", ins.line, `${ins.instruction} uses shell form`);
        break;
      default:
        break;
    }
  }

  for (const s of stages) {
    const inStage = instructions.filter((x) => x.stage === s.index);
    for (const kind of ["CMD", "ENTRYPOINT"]) {
      const multiple = inStage.filter((x) => x.instruction === kind);
      if (multiple.length > 1) add("multiple-cmd", multiple[multiple.length - 1].line, `${kind} appears ${multiple.length} times in stage ${s.name ?? s.index}; only the last one applies`);
    }
  }

  const last = stages[stages.length - 1];
  if (last) {
    const inStage = instructions.filter((x) => x.stage === last.index);
    const users = inStage.filter((x) => x.instruction === "USER");
    const finalUser = users[users.length - 1];
    if (!finalUser) add("root-user", last.line, `final stage${last.name ? ` ${last.name}` : ""} has no USER instruction and runs as root`);
    else if (/^(root|0)(:|$)/.test(finalUser.args.trim())) add("root-user", finalUser.line, "the last USER selects root");
    else {
      const switched = finalUser.line;
      for (const c of inStage) if ((c.instruction === "COPY" || c.instruction === "ADD") && c.line > switched && !/--chown=/.test(c.args)) add("copy-chown-missing", c.line, `${c.instruction} after USER ${finalUser.args.trim()} creates root-owned files`);
    }
    if (!inStage.some((x) => x.instruction === "HEALTHCHECK") && last.base !== "scratch") add("no-healthcheck", last.line, `final stage${last.name ? ` ${last.name}` : ""} has no HEALTHCHECK`);
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((x, y) => order[x.severity] - order[y.severity] || x.line - y.line);
}
