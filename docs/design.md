# Nonprofit Explorer MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `nonprofit_search` | Search 1.8M+ tax-exempt orgs by name/keyword with optional state, NTEE sector, and 501(c) type filters. Returns EINs for use with other tools. | `query`, `state`, `ntee_category`, `subsection_code`, `page` | `readOnlyHint: true` |
| `nonprofit_get_organization` | Full profile for an org by EIN: legal name, address, NTEE classification, ruling year, IRS status, and financial summary from the most recent filing (revenue, expenses, assets, net assets). | `ein` | `readOnlyHint: true, idempotentHint: true` |
| `nonprofit_get_filings` | All Form 990 filings for an EIN over time: year, form type, curated financial figures, transparent program-expense ratio, executive compensation, and source PDF/XML links. | `ein` | `readOnlyHint: true, idempotentHint: true` |

### Resources

None. All data is reachable via the tool surface; search clients are tool-only so there is no payoff for adding resources.

### Prompts

None. The tool surface is data-oriented; no recurring interaction pattern warrants a prompt template.

---

## Overview

Wraps the [ProPublica Nonprofit Explorer API](https://projects.propublica.org/nonprofits/api/v2/) (keyless, read-only REST) to expose IRS Form 990 financial data on 1.8M+ tax-exempt organizations. Targets journalists, donors, grant-seekers, researchers, and watchdogs running due-diligence queries like "how much does this charity spend on programs vs. overhead?" or "what does the CEO earn?"

Two upstream endpoints:
- `GET /search.json` — full-text org search with state/NTEE/subsection filters
- `GET /organizations/{ein}.json` — full org profile + all filings

Every tool links back to the source Form 990 PDF where available, supporting verifiable journalism and research. Financial ratios are computed transparently with inputs shown.

---

## Requirements

- Keyless — no API key, no auth header required
- Read-only throughout; no mutations exist in the API
- Rate-limit: ProPublica asks for courtesy limits (no documented ceiling); the service layer respects that with a per-request delay guard and retry logic
- Data lags 1–2 years (990s are filed annually, IRS processing takes additional time) — filing year surfaces prominently in every financial figure
- EIN is the primary key; search is the discovery path (no bulk listing)
- Pagination: 25 results per page, zero-indexed `page` parameter, up to `num_pages` pages

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `nonprofit-explorer-service` | ProPublica Nonprofit Explorer API v2 | All three tools |

Single service; all three tools share one HTTP client and one retry boundary. No auth state to manage.

**Service methods:**
- `search(params)` → raw search response
- `getOrganization(ein)` → raw org + filings response

**Resilience:**
- Retry boundary: full fetch + parse pipeline
- Backoff: 500ms base, exponential, 3 retries (API is stable; 500s are rare transient errors)
- HTML 500 responses (the API returns `text/html` for server errors) → classify as transient `ServiceUnavailable`, not `SerializationError`
- `pdf_url: null` is valid (not a fetch error); the field is simply absent for some IRS batches
- Deterministic failures carry `retryable: false` so `withRetry` fails fast instead of burning the budget on a request that can never succeed
- Every service throw spreads `ctx.recoveryFor(reason)` into the error `data`. The framework never auto-injects a contract's `recovery` at runtime — `data.recovery.hint` is what reaches the client on both surfaces, and it is only there if the throw site puts it there. Because `ctx.recoveryFor` is rebuilt per invocation from the calling tool's own contract, one shared service method (`getOrganization`) returns each caller's own `not_found` wording.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| _(none)_ | — | API is keyless; no env vars needed |

The framework's `OTEL_*` and transport vars still apply as always.

---

## Implementation Order

1. Service: `src/services/nonprofit-explorer/nonprofit-explorer-service.ts`
2. `nonprofit_search` tool (no deps beyond service)
3. `nonprofit_get_organization` tool
4. `nonprofit_get_filings` tool (needs org profile for formtype context)

Each step is independently testable.

---

## Tool Specifications

### `nonprofit_search`

**Purpose:** Find tax-exempt orgs by name/keyword, optionally filtered by US state, NTEE major sector, or 501(c) subsection type. Always the first step — other tools require an EIN, which this produces.

**Upstream call:** `GET /search.json?q=...&state%5Bid%5D=...&ntee%5Bid%5D=...&c_code%5Bid%5D=...&page=...`

**Input schema:**

```ts
z.object({
  query: z.string().describe(
    'Keyword search string. Searched against org name, alternate name, and city in order of relevance. ' +
    'Supports: quoted phrases ("Red Cross"), required terms (+evanston), excluded terms (-dental). ' +
    'Empty string returns all orgs within the active filters.'
  ),
  state: z.string().length(2).optional().describe(
    'Two-letter US state, territory, or military postal code (e.g., "WA", "NY", "PR"). ' +
    'Use "ZZ" for foreign entities. Case-insensitive — normalized to uppercase before filtering. ' +
    'A code outside that set is rejected rather than silently returning national results. ' +
    'Restricts results to orgs headquartered in that state.'
  ),
  ntee_category: z.enum([
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  ]).optional().describe(
    'NTEE (National Taxonomy of Exempt Entities) major group integer (1–10). ' +
    '1=Arts/Culture/Humanities, 2=Education, 3=Environment/Animals, 4=Health, ' +
    '5=Human Services, 6=International/Foreign Affairs, 7=Public/Societal Benefit, ' +
    '8=Religion Related, 9=Mutual/Membership Benefit, 10=Unknown/Unclassified.'
  ),
  subsection_code: z.enum([
    '2','3','4','5','6','7','8','9','10','11','12','13','14','15',
    '16','17','18','19','21','22','23','25','26','27','28','92',
  ]).optional().describe(
    '501(c) subsection code. "3" = public charity (most common — donations tax-deductible), ' +
    '"4" = social welfare org, "6" = business league/trade association, ' +
    '"92" = 4947(a)(1) nonexempt charitable trust. Filters by tax status, not sector.'
  ),
  page: z.number().int().min(0).default(0).describe(
    'Zero-indexed page number. 25 results per page. Total pages is in the response. ' +
    'Increment to paginate large result sets.'
  ),
})
```

**Output shape:**

```ts
{
  total_results: number;          // Total matching orgs (up to 10000 per API)
  num_pages: number;              // Total pages (total_results / 25, ceiling); last valid page is num_pages - 1
  cur_page: number;               // Current page (zero-indexed)
  per_page: number;               // Results per page applied by the API (25)
  page_offset: number;            // Zero-indexed offset of the first result on this page
  organizations: Array<{
    ein: number;                  // Employer Identification Number — use with other tools
    strein: string;               // EIN in "XX-XXXXXXX" format (preserves leading zeros)
    name: string;                 // Legal org name per IRS
    sub_name: string | null;      // Alternate/subtitle name or chapter identifier
    city: string | null;
    state: string | null;         // Two-letter abbreviation
    ntee_code: string | null;     // Full NTEE code (e.g. "E210") — more specific than the filter
    subseccd: number | null;      // 501(c) subsection code
    score: number;                // Relevance score (higher = better match)
  }>;
  // Active filters echoed back — state is the normalized (uppercased) value actually sent
  active_filters: {
    query: string;
    state: string | null;
    ntee_category: string | null;
    subsection_code: string | null;
  };
  data_source: string;            // ProPublica attribution text
}
```

**Enrichment:**

```ts
enrichment: {
  notice: z.string().optional().describe(
    'Present when the page carried no organizations — distinguishes a zero-match query from ' +
    'a page past the end of the result set, and names the next call.'
  ),
}
```

An empty page is a *successful* search, never an error, and `total_results` (not the HTTP status) says which kind: zero means nothing matched, nonzero means the requested page is past `num_pages`. The two cases route the agent differently — relax the query vs. re-request an in-range page — so each gets its own notice text. `ctx.enrich.notice` is last-wins, so the branches resolve to one string and one call.

**Error contract:**

```ts
errors: [
  {
    reason: 'invalid_state',
    code: JsonRpcErrorCode.ValidationError,
    when: 'The state filter is not a US state, territory, or military postal code (or ZZ for foreign entities)',
    recovery: 'Pass a two-letter USPS code such as WA, NY, or PR; use ZZ for foreign-address organizations, or omit state to search nationally.',
  },
  {
    reason: 'pagination_ceiling',
    code: JsonRpcErrorCode.ValidationError,
    when: 'The requested page is at or beyond ProPublica\'s 10,000-result offset ceiling',
    retryable: false,
    recovery: 'Narrow the result set with the state, ntee_category, or subsection_code filters or a more specific query, then request a page below 400.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'ProPublica API returns a 500 or network error',
    retryable: true,
    recovery: 'Wait a moment and retry. ProPublica\'s API is keyless and generally stable.',
  },
]
```

**Annotations:** `readOnlyHint: true`

---

### `nonprofit_get_organization`

**Purpose:** Full profile for a single org by EIN: legal identity, IRS classification, and a financial snapshot from the most recent filed 990. The "who is this org and how big are they?" lookup. Requires an EIN — use `nonprofit_search` first if you only have a name.

**Upstream call:** `GET /organizations/{ein}.json`

**Input schema:**

```ts
z.object({
  ein: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d{2}-?\d{7}$/).describe('EIN as string, with or without hyphen (e.g., "53-0196605" or "530196605")'),
  ]).describe(
    'Employer Identification Number. Accepts integer (530196605) or string with optional hyphen ("53-0196605"). ' +
    'Obtain from nonprofit_search results. Note: the API strips leading zeros — treat EIN as an integer key.'
  ),
})
```

**Output shape:**

```ts
{
  ein: number;
  strein: string;                 // "XX-XXXXXXX" format
  name: string;
  sort_name: string | null;       // API field name is sort_name in org response (not sub_name); contains alternate/subtitle name or chapter identifier
  address: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  ntee_code: string | null;       // e.g., "E210" — health hospital
  subsection_code: number | null; // 501(c) subsection
  ruling_date: string | null;     // ISO date of IRS recognition
  asset_amount: number | null;    // Most recent IRS BMF total assets
  income_amount: number | null;   // Most recent IRS BMF total income
  revenue_amount: number | null;  // Most recent IRS BMF total revenue
  // Latest filing snapshot (may be null if no filings_with_data)
  latest_filing: {
    tax_prd_yr: number;           // Fiscal year (e.g., 2023) — NOT the current year; data lags 1-2 years
    form_type: '990' | '990-EZ' | '990-PF';
    total_revenue: number | null;
    total_expenses: number | null;
    total_assets: number | null;
    total_liabilities: number | null;
    net_assets: number | null;    // totnetassetend from API (direct field, not computed)
    pdf_url: string | null;       // Source Form 990 PDF (may be null for some IRS batches)
  } | null;
  filing_count: number;           // Total filings_with_data count (for context)
  data_source: string;            // Top-level response.data_source (full ProPublica + IRS attribution text); NOT organization.data_source (which is the IRS BMF version string like "current_2026_04_15")
  propublica_url: string;         // Constructed link: https://projects.propublica.org/nonprofits/organizations/{ein}
}
```

**Error contract:**

```ts
errors: [
  {
    reason: 'not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'HTTP 404 with error body, or HTTP 200 with id=0, or HTTP 200 with "Unknown Organization" and all fields null — EIN has no real record',
    recovery: 'Verify the EIN with nonprofit_search. EINs with leading zeros are stored without them — try the integer value.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'ProPublica API returns a non-JSON body (HTML 500) or network error',
    retryable: true,
    recovery: 'Wait a moment and retry.',
  },
]
```

**Implementation note:** The API has three not-found patterns — all must be classified as `not_found`:
1. **HTTP 404 + `{"error": "Organization not found"}`** — EIN is a valid numeric format but not in the database (e.g., EIN 100000001). This is the primary not-found case.
2. **HTTP 200 + `id: 0, name: "Unknown Organization"`, all org fields null** — non-numeric or malformed EIN path segment (e.g., `/organizations/abc.json`).
3. **HTTP 200 + `id: <requested_ein>, name: "Unknown Organization"`, all org fields null, `filings_with_data: []`** — the EIN is recognized as a placeholder/dummy EIN (e.g., 999999999) or exists only as an artifact in the system. Detect by: `organization.name === "Unknown Organization"` AND all address/classification fields null. Note: a real sparse org (EIN in BMF but no 990 data) will have `name` set to the org name, not "Unknown Organization" — those are not `not_found`, just `no_filings`.

**Annotations:** `readOnlyHint: true, idempotentHint: true`

---

### `nonprofit_get_filings`

**Purpose:** All Form 990 filings for an org over time — year by year financial figures, computed program-expense ratio (with inputs shown), executive compensation, and source PDF links. Used for trend analysis, due diligence, and accessing the primary 990 documents.

**Upstream call:** `GET /organizations/{ein}.json` (same as `nonprofit_get_organization`; reuses the org endpoint; both arrays are in the same response)

**Input schema:**

```ts
z.object({
  ein: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d{2}-?\d{7}$/).describe('EIN as string, with or without hyphen'),
  ]).describe(
    'Employer Identification Number. Use nonprofit_search to resolve an org name to its EIN.'
  ),
})
```

**Output shape:**

```ts
{
  ein: number;
  name: string;
  filings: Array<{
    tax_prd_yr: number;           // Fiscal year — NOT the filing date; always show this prominently
    tax_prd: number;              // YYYYMM (month fiscal year ended, e.g., 202306 = June 2023 FY)
    form_type: '990' | '990-EZ' | '990-PF';
    pdf_url: string | null;       // Source Form 990 PDF — null for some IRS processing batches
    updated: string | null;       // ISO datetime ProPublica last updated this record
    // Core financials
    total_revenue: number | null;
    total_expenses: number | null;
    total_assets: number | null;
    total_liabilities: number | null;
    net_assets: number | null;    // totnetassetend from API (direct field)
    // Revenue breakdown (990/990-EZ only; null for 990-PF)
    contributions_and_grants: number | null;  // totcntrbgfts
    program_service_revenue: number | null;   // totprgmrevnue
    investment_income: number | null;         // invstmntinc
    // Program expense ratio (990/990-EZ only; null for 990-PF where field set differs)
    // Computed as: (total_expenses - management_expenses - fundraising_expenses) / total_expenses
    // Inputs shown so the derivation is transparent and verifiable against the PDF
    program_expense_ratio: {
      ratio: number | null;         // 0.0–1.0; null if inputs insufficient
      program_expenses: number | null;   // Numerator (computed)
      total_expenses: number | null;     // Denominator (= totfuncexpns)
      management_compensation: number | null;  // compnsatncurrofcr (officer/director comp)
      other_salaries: number | null;           // othrsalwages
      fundraising_expenses: number | null;     // profndraising (professional fundraising fees)
      note: string;  // e.g., "Program expenses = total - officer comp - other wages - fundraising"
    } | null;
    // Executive compensation
    // Field varies by form type: compnsatncurrofcr (990/990-EZ) vs compofficers (990-PF)
    executive_compensation: {
      amount: number | null;
      field_name: string;  // Source field name for transparency: "compnsatncurrofcr" or "compofficers"
      form_type: string;   // Which form this came from
      note: string;        // e.g., "990: total compensation of current officers, directors, trustees, key employees"
    } | null;
  }>;
  // Filings with PDF links only (no extracted financial data)
  filings_pdf_only: Array<{
    tax_prd_yr: number;
    form_type_str: string;  // "990", "990EZ", "990PF"
    pdf_url: string | null;
  }>;
  total_filings_with_data: number;
  total_filings_pdf_only: number;
  data_source: string;            // Top-level response.data_source (ProPublica + IRS attribution text)
  propublica_url: string;
}
```

**Error contract:**

```ts
errors: [
  {
    reason: 'not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'No organization exists for the given EIN',
    recovery: 'Verify the EIN with nonprofit_search. Use the integer EIN value (leading zeros stripped).',
  },
  {
    reason: 'no_filings',
    code: JsonRpcErrorCode.NotFound,
    when: 'Org exists with a real name but has empty filings_with_data and filings_without_data arrays — typically small orgs filing Form 990N',
    recovery: 'Small organizations with under $50,000 in revenue file Form 990N (e-Postcard), which is not included in Nonprofit Explorer. The org exists but has no 990 data to display.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'ProPublica API returns a non-JSON body or network error',
    retryable: true,
    recovery: 'Wait a moment and retry.',
  },
]
```

**Program expense ratio computation:**

For Form 990 (`formtype: 0`) and 990-EZ (`formtype: 1`):
- `program_expenses = totfuncexpns - compnsatncurrofcr - othrsalwages - profndraising`
- `ratio = program_expenses / totfuncexpns`

Three overhead components are subtracted: officer/director compensation (`compnsatncurrofcr`), other salaries and wages (`othrsalwages`), and professional fundraising fees (`profndraising`). All three are surfaced as named fields in the output schema for transparency. Note: `payrolltx` (payroll taxes) is intentionally excluded from the computation here — it is not surfaced in the output schema, and adding it would create a hidden deduction. If a more precise breakdown is needed, users should consult the full 990 PDF (Part IX).

For Form 990-PF (`formtype: 2`): `compnsatncurrofcr`, `othrsalwages`, and `profndraising` are all `null` in the API response (confirmed by live probing of Gates Foundation filings); program expense ratio is `null` with a note explaining why.

**Executive compensation field mapping:**
- `formtype: 0` or `1` (990/990-EZ): `compnsatncurrofcr` — total compensation of current officers, directors, trustees, and key employees
- `formtype: 2` (990-PF): `compofficers` — compensation of officers, directors, trustees

Both `field_name` and a plain-English `note` are included in the output so downstream consumers (and the source PDF) can verify the figure.

**Annotations:** `readOnlyHint: true, idempotentHint: true`

---

## Domain Mapping

| Noun | Operations | Endpoint |
|:-----|:-----------|:---------|
| Organization | search by keyword/filters | `GET /search.json` |
| Organization | get profile by EIN | `GET /organizations/{ein}.json` |
| Filing | list all filings for org | `GET /organizations/{ein}.json` (nested) |

The API has only two endpoints. `nonprofit_get_organization` and `nonprofit_get_filings` both call the same endpoint; the service layer makes one HTTP request and splits the response. The tool distinction is about what the agent is trying to do: profile lookup vs. filing history.

---

## Design Decisions

**1. Two tools on one upstream endpoint**
`nonprofit_get_organization` and `nonprofit_get_filings` both call `GET /organizations/{ein}.json`. The response contains both `organization` (profile) and `filings_with_data` (array). Splitting into two tools is correct: profile lookup and filing history are distinct agent intents. The service method fetches once; both tools call the same service method and each extract what they need. This is more honest than either forcing the agent to call one tool to get data it doesn't want, or silently including filing arrays in the profile response.

**2. NTEE filter accepts integers 1–10, not letter codes**
The API docs and live probing confirm: `ntee[id]` accepts integers 1–10, not NTEE letter codes like "K" (Food) or "E" (Health). Letter codes cause HTTP 500. The enum in the input schema uses string literals `'1'`–`'10'` with clear labels in `.describe()`. The server translates the idea.md's "resolve human NTEE terms to codes" into resolving human sector names to these integers.

**3. Program expense ratio: compute transparently, show inputs**
The 990 line items ProPublica extracts don't break out program service expenses as a single field. The ratio is approximated from `totfuncexpns - (officer comp + other wages + professional fundraising)`. All three overhead components surface in the output schema as named fields (`management_compensation`, `other_salaries`, `fundraising_expenses`). `payrolltx` is excluded from the formula — it is not surfaced as a named output field, and a hidden deduction violates the transparency requirement. The `note` field explains the methodology. Per-filer accuracy varies (the 990 Part IX has a more precise breakdown not in the extract), which is why the PDF link is always returned.

**4. Form type differences handled explicitly**
990 (`formtype: 0`), 990-EZ (`formtype: 1`), and 990-PF (`formtype: 2`) have different field sets. Executive compensation lives in `compnsatncurrofcr` for 990/990-EZ and `compofficers` for 990-PF. Program expense ratio is computable for 990/990-EZ and null for 990-PF. The output schema uses type-tagged fields and explicit null so the agent sees what's available vs. absent rather than receiving a zero that looks like data.

**5. EIN not-found detection requires three checks**
Live probing reveals three distinct patterns — all must be treated as `not_found`:
- HTTP 404 + `{"error": "Organization not found"}` — EIN is a valid numeric format but not in the database
- HTTP 200 + `{"id": 0, "name": "Unknown Organization"}` — non-numeric or malformed EIN path segment (e.g., `/organizations/abc.json`)
- HTTP 200 + `{"id": <requested_ein>, "name": "Unknown Organization"}` with all org fields null — placeholder/dummy EIN (e.g., 999999999) that exists as an artifact but is not a real organization

Detection order in the service layer: (1) non-2xx → check for `{"error": ...}` JSON → `not_found`; (2) 200 with `id === 0` → `not_found`; (3) 200 with `organization.name === "Unknown Organization"` AND `organization.address === null` → `not_found`. Note: a real sparse org (in the IRS BMF but no 990 filings) has a real org name — that is `no_filings`, not `not_found`.

**6. `pdf_url` can be null in filings_with_data**
The API marks `pdf_url` as nullable in the response schema; IRS PDF processing batches occasionally lag behind the extracted financial data, leaving `pdf_url: null` temporarily. The output schema marks `pdf_url` as `string | null`. The format function renders "PDF not yet available for this period" when null rather than omitting the field silently. The `filings_pdf_only` array (from `filings_without_data`) surfaces older filings that have a PDF but no extracted data.

**7. Search total_results caps at 10000, and pagination has four distinguishable end states**
Verified: when filters return more than 10000 results, the API reports `total_results: 10000` and `num_pages: 400`. This is an API ceiling, not the actual count. The output schema documents this; the format function adds a note when `total_results === 10000` indicating the actual count may be higher.

The boundary itself has four shapes, and the HTTP status alone does not separate them:

| Case | HTTP | Discriminator | Classification |
|:-----|:-----|:--------------|:---------------|
| Zero-match query | 404 | `total_results: 0` | Success, empty list, zero-match notice |
| First exhausted page (`cur_page === num_pages`) | 200 | `total_results` nonzero | Success, empty list, past-the-end notice |
| Well past the last page, under the offset ceiling | 404 | `total_results` nonzero | Success, empty list, past-the-end notice |
| Offset at/beyond 10,000 (`page * per_page >= 10000`) | 400 | body has `error`, no pagination fields | `pagination_ceiling`, non-retryable |

`total_results` — not the status code — is what separates a zero-match query from an exhausted page, since 404 covers both. Only the 400 shape is an error: it is a deterministic input problem the caller must correct by narrowing the query or lowering `page`, so it is non-retryable rather than the `upstream_error` a tolerated-status list of `[404]` alone produced. A 400 whose body is not a pagination failure stays `upstream_error` — silently reading it as an empty result set would reintroduce the wrong-answer failure mode.

**8. No resources or prompts**
The workflow is linear: search → profile → filings. All data reachable via tools. No stable URI pattern earns a resource (there's no cross-session injectable context that would help). No recurring message template warrants a prompt.

**9. Attribution in every response**
The `data_source` field from the API carries ProPublica + IRS attribution text. Every tool passes it through in the output and renders it in `format()`. ProPublica asks for courtesy credit; surfacing it in `format()` text ensures it reaches both `structuredContent` (Claude Code) and `content[]` (Claude Desktop) clients.

**10. The state filter is validated before the request, not after**
ProPublica honors `state[id]` only on an exact match against a real postal code. Lowercase (`wa`), title-case (`Wa`), and a syntactically valid but nonexistent code (`XX`) are all answered with HTTP 200 and the **unfiltered national result set** — a plausible-looking wrong answer, not an error. The handler therefore uppercases the input and rejects anything outside the USPS state/territory/military set plus `ZZ`.

The rejection lives in the handler rather than the input schema deliberately. The MCP SDK validates tool arguments against the Zod input schema *before* the registered handler runs, so a `.regex()` / `.refine()` / `z.enum()` rejection surfaces as a raw JSON-RPC `-32602` carrying the SDK's generic message — never reaching `ctx.fail`, the tool's `errors[]` contract, or its recovery hint. Validating in the handler keeps the failure inside the typed error path, where the caller gets `invalid_state` plus an actionable next step.

---

## Known Limitations

- **Data lag:** 990 filings are annual and IRS processing adds further delay. The most recent `tax_prd_yr` is typically 1–2 years behind the current year. The tools surface `tax_prd_yr` prominently; agents must not present these figures as current.
- **No individual officer compensation detail:** The extract includes total officer compensation (`compnsatncurrofcr`) but not per-officer breakdown. Individual named executive pay appears only in Schedule J of the full 990 PDF. Users needing per-person data must read the linked PDF.
- **Small orgs omitted:** Organizations filing Form 990N (under $50,000 revenue) are not in Nonprofit Explorer. The API will return not-found for valid EINs of these organizations.
- **Program expense ratio approximation:** The extract-level computation is an approximation (see Decision 3). High-stakes research should verify against the PDF.
- **No bulk search or EIN lookup list:** The API has no batch endpoint. Multiple EIN lookups require separate requests.
- **Search results beyond 10,000 are unreachable:** ProPublica refuses any page whose result offset reaches 10,000, so pages above 399 cannot be fetched at all (see Decision 7). `nonprofit_search` reports this as `pagination_ceiling` and directs the caller to narrow the query; there is no workaround that walks past the ceiling.
- **NTEE filter is coarse:** The integer categories (1–10) map to major NTEE groups. There's no filter for sub-codes like "E210" (hospitals within Health). Search results include `ntee_code` (full sub-code) for post-hoc filtering in the client.
