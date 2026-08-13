# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-08-12

Narrows nonprofit_get_filings' executive_compensation to a non-nullable, tightly-typed shape and removes +-concatenation from every tool description string.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-08-12

Removes nonprofit_get_filings' non-derivable program-expense ratio, adds IRS Business Master File classification fields to nonprofit_get_organization, and renders null values consistently across all three tools' output.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-08-13

Fixes nonprofit_search state-filter case handling and pagination-boundary misclassification, wires recovery hints into service-originated errors, and adopts mcp-ts-core ^0.11.5.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-20

Maintenance — mcp-ts-core ^0.10.9 adoption; devcheck gains dependency-specifier and plugin-manifest guards, fresh-scaffold script hardening, and re-synced vendored skills. No tool-surface changes.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-15

Public hosted endpoint at https://nonprofit-explorer.caseyjhand.com/mcp — server.json remotes, README hosted block and install section.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-12

Maintenance — mcp-ts-core ^0.10.6 adoption, explicit machine-name identity, MCPB bundle hardening, and a HEALTHCHECK + version-stamped Docker image.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-01

Public launch — nonprofit search, organization lookup, and Form 990 filing history over the ProPublica Nonprofit Explorer API.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-31

Initial scaffold from @cyanheads/mcp-ts-core.
