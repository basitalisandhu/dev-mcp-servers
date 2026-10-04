# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and every package in the repository shares one version number.

## [Unreleased]

## [0.1.0] - 2026-10-03

### Added

- `osv-advisories`: `query_package`, `query_batch`, `scan_lockfile` (package-lock.json v1 to v3, requirements.txt `==` pins, poetry.lock, go.sum) and `get_vulnerability`, all against `api.osv.dev` only, with a 15 s timeout and an 8 MB response cap.
- `security-headers`: `check_url_headers` (HEAD with GET fallback, limited redirects, private and metadata addresses refused, body never read), `grade_headers` and `explain_header`, grading CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, CORP, X-XSS-Protection, Server, X-Powered-By and Set-Cookie.
- `jwt-tools`: `decode_jwt` (never verifies; findings for `alg: none`, expiry, missing claims, long lifetimes, key URLs in the header, sensitive claims), `verify_jwt` (HS256/384/512 and RS256/384/512 for exactly the requested algorithm) and `sign_test_jwt`.
- `regex-lab`: `test_regex` in a terminated-on-timeout worker thread, `explain_regex`, and `check_redos` with static findings plus timed probes.
- `cron-tools`: `parse_cron`, `explain_cron`, `validate_cron` and `next_runs` with IANA time zones and DST handling, implemented with `Intl` and no extra dependency.
- `json-schema-tools`: `validate_json` (drafts 07, 2019-09, 2020-12 via Ajv with formats), `infer_schema` and `diff_schemas` with breaking/compatible/review verdicts.
- `openapi-lint`: `lint_openapi` with 22 rules, `list_operations`, `get_operation` and `explain_rule`; JSON or YAML from a path or inline, local references only.
- `dockerfile-lint`: `lint_dockerfile` with 25 rules, `parse_dockerfile` (escape directive, continuations, heredocs, stages) and `explain_rule`.
- `git-insights`: `repo_summary`, `git_log`, `blame_summary`, `churn` (renames followed), `authors` and `large_files` (tree or full history), read-only with validated arguments.
- `llms-txt`: `generate_llms_txt` from a Markdown directory, `generate_from_sitemap` from a local sitemap, and `check_llms_txt`.
- Root workspace with shared `tsconfig.base.json`, CI on Node 20 and 22, a release workflow that publishes every workspace with npm provenance, an offline `server.json` schema check, and six good first issues in `docs/good-first-issues.md`.
