# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and every package in the repository shares one version number.

## [Unreleased]

### Added

- openapi-lint: rules `security-scheme-apikey-query` (warning), `security-scheme-http-basic` (info) and `operation-no-error-response` (info) (#9).

## [0.2.2] - 2026-10-18

### Changed

- Raise `@types/node` to 26 in the root and every package, and narrow the worker `error` event argument in regex-lab with `instanceof Error` (the 26 typings declare it `unknown`) (#20).
- Dependency updates: TypeScript 7, zod 4, the MCP SDK and the GitHub Actions group (#16 to #19).
- Harden the workflows and repository policy for the OpenSSF Scorecard (#22).
