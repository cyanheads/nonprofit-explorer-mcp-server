# Nonprofit Explorer MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `nonprofit_search` | Search 1.8M+ tax-exempt orgs by name/keyword with optional state, NTEE sector, and 501(c) type filters. Returns EINs for use with other tools. | `query`, `state`, `ntee_category`, `subsection_code`, `page` | `readOnlyHint: true` |
| `nonprofit_get_organization` | Full profile for an org by EIN: legal name, address, NTEE classification, ruling year, IRS status, and financial summary from the most recent filing (revenue, expenses, assets, net assets). | `ein` | `readOnlyHint: true, idempotentHint: true` |
| `nonprofit_get_filings` | All Form 990 filings for an EIN over time: year, form type, curated financial figures, revenue breakdown, executive compensation, and source PDF links. | `ein` | `readOnlyHint: true, idempotentHint: true` |

### Resources

None. All data is reachable via the tool surface; search clients are tool-only so there is no payoff for adding resources.

### Prompts

None. The tool surface is data-oriented; no recurring interaction pattern warrants a prompt template.

---

## Overview

Wraps the [ProPublica Nonprofit Explorer API](https://projects.propublica.org/nonprofits/api/v2/) (keyless, read-only REST) to expose IRS Form 990 financial data on 1.8M+ tax-exempt organizations. Targets journalists, donors, grant-seekers, researchers, and watchdogs running due-diligence queries like "is this org still tax-exempt and are donations deductible?", "how has its revenue moved over the last five years?", or "what does the CEO earn?"

Two upstream endpoints:
- `GET /search.json` — full-text org search with state/NTEE/subsection filters
- `GET /organizations/{ein}.json` — full org profile + all filings

Every tool links back to the source Form 990 PDF where available, supporting verifiable journalism and research. Figures are passed through from the extract, never derived or approximated — a figure it does not carry is reported as absent.

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
    'Keyword search string. Searched against org name, the secondary name line, and city in order of relevance. ' +
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
    '501(c) subsection code. "3" = charitable/religious/educational organization (most common — includes both public charities and private foundations; nonprofit_get_organization returns foundation_type to tell them apart), ' +
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
    sub_name: string | null;      // Legal name with the BMF secondary name line appended (division/service-center/chapter identifier), not a separate trade name
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
    'Present when the response needs a caveat the domain fields cannot carry: a page that ' +
    'returned no organizations, a total_results sitting on the API result ceiling, or both.'
  ),
}
```

An empty page is a *successful* search, never an error, and `total_results` (not the HTTP status) says which kind: zero means nothing matched, nonzero means the requested page is past `num_pages`. The two cases route the agent differently — relax the query vs. re-request an in-range page — so each gets its own notice text.

A third condition rides the same notice: `total_results === 10000` is ProPublica's ceiling, not a count (Decision 7). Carrying that only in `format()` left it invisible to `structuredContent` clients, which saw a bare `10000` with nothing marking it as saturated. It co-occurs with either empty-page cause, and `ctx.enrich.notice` is last-wins, so all applicable segments compose into one string emitted by one call — a second call would silently drop everything before it. `format()` does not repeat the cap caveat (the trailer already carries it) but does mark a past-the-end page inline, so a client reading `content[]` top to bottom does not hit `Page 245 of 245 pages` as an unexplained contradiction before reaching the trailer.

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
  sort_name: string | null;       // IRS BMF secondary name line (SORT_NAME) — an internal sort key, not an alternate org name
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
  // IRS BMF classification, decoded as "<code> — <meaning>" (see Decision 11)
  deductible: string | null;      // deductibility_code — 1 deductible, 2 not, 4 by treaty
  exempt_status: string | null;   // exempt_organization_status_code — 1 is unconditional exemption
  foundation_type: string | null; // foundation_code — public charity (10–25) vs private foundation (2–4); 0 and 9 are neither
  bmf_tax_period: string | null;  // tax_period — latest BMF return period; often newer than latest_filing
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
3. **HTTP 200 + `id: <requested_ein>, name: "Unknown Organization"`, all org fields null, `filings_with_data: []`** — the EIN is recognized as a placeholder/dummy EIN (e.g., 999999999) or exists only as an artifact in the system. Detect by: `organization.name === "Unknown Organization"` AND all address/classification fields null. Note: a real sparse org (EIN in BMF but no 990 data) will have `name` set to the org name, not "Unknown Organization" — that is a successful lookup with an empty filing list, not `not_found`.

**Annotations:** `readOnlyHint: true, idempotentHint: true`

---

### `nonprofit_get_filings`

**Purpose:** All Form 990 filings for an org over time — year by year financial figures, revenue breakdown, executive compensation, and source PDF links. Used for trend analysis, due diligence, and accessing the primary 990 documents.

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
    // Program expense ratio — always null against ProPublica (see Decision 3)
    // The shape is retained for a future source that reports the Part IX allocation
    program_expense_ratio: {
      ratio: number | null;              // 0.0–1.0
      program_expenses: number | null;   // Part IX column (B), line 25
      total_expenses: number | null;     // Part IX column (A) (= totfuncexpns)
      management_compensation: number | null;  // compnsatncurrofcr (officer/director comp)
      other_salaries: number | null;           // othrsalwages
      fundraising_expenses: number | null;     // profndraising (professional fundraising fees)
      note: string;  // Source of the functional allocation
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

**Enrichment:**

```ts
enrichment: {
  notice: z.string().optional().describe(
    'Present when the organization resolved but Nonprofit Explorer holds no filing of any ' +
    'kind for it — names the org and why the filing history is empty. An empty filings ' +
    'array without this notice means the org has filings that carry a PDF but no extracted ' +
    'data; read filings_pdf_only.'
  ),
}
```

The notice fires only when both upstream arrays are empty, so its absence does not mean the extracted set is complete — an org whose only filings are older PDF-only ones gets an empty `filings`, no notice, and a populated `filings_pdf_only`.

An EIN that resolves to a real organization with no 990 on record is a *successful* lookup with an empty result set — the org's name is already in hand, and "this org has never filed a 990" is a citable fact about it. It returns `filings: []` plus a notice, never an error, matching `nonprofit_search`'s treatment of a zero-match query and `nonprofit_get_organization`'s `latest_filing: null` on the same underlying response.

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
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'ProPublica API returns a non-JSON body or network error',
    retryable: true,
    recovery: 'Wait a moment and retry.',
  },
]
```

`not_found` stays an error: an EIN that resolves to no organization at all is a genuine failure to answer.

**Program expense ratio:**

Not computed. `program_expense_ratio` is `null` on every filing, for every form type — see Decision 3. `format()` renders the section with a line stating that the split lives in Part IX of the source PDF, so a `content[]`-only client sees the same fact the null in `structuredContent` carries.

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

**3. Program expense ratio: not derivable, so not derived**
`program_expense_ratio` is `null` on every filing. `totfuncexpns` is Form 990 Part IX column (A); the program-service total is column (B), line 25 — a separately allocated column ProPublica does not return. Part IX allocates *every* expense line (occupancy, professional fees, travel, IT, insurance, depreciation, …) across program, management, and fundraising, so subtracting officer compensation, other wages, and professional fundraising fees from the column (A) total cannot reconstruct it. A live pull of the fullest filing shape the API returns (67 fields) has all three subtrahends populated and still carries no program-service figure, so the gap is structural rather than a sparse-input problem — and on a 990-EZ, which has no Part IX allocation at all, the three fields are absent entirely and the residual reported a 100% program ratio.

The field and its nested shape are retained (nullable) so a future source that reports the real allocation can populate them without a schema change. The independently sourced figures — total expenses, revenue breakdown, executive compensation, PDF link — are unaffected. Deriving the real ratio requires parsing IRS 990 XML/PDF filings, which is out of scope.

**4. Form type differences handled explicitly**
990 (`formtype: 0`), 990-EZ (`formtype: 1`), and 990-PF (`formtype: 2`) have different field sets. Executive compensation lives in `compnsatncurrofcr` for 990/990-EZ and `compofficers` for 990-PF. The revenue breakdown (`totcntrbgfts`, `totprgmrevnue`, `invstmntinc`) is 990/990-EZ only and null for 990-PF. The output schema uses type-tagged fields and explicit null so the agent sees what's available vs. absent rather than receiving a zero that looks like data, and `format()` names *why* a field is null — not applicable to this form type vs. not extracted (see Decision 12).

**5. EIN not-found detection requires three checks**
Live probing reveals three distinct patterns — all must be treated as `not_found`:
- HTTP 404 + `{"error": "Organization not found"}` — EIN is a valid numeric format but not in the database
- HTTP 200 + `{"id": 0, "name": "Unknown Organization"}` — non-numeric or malformed EIN path segment (e.g., `/organizations/abc.json`)
- HTTP 200 + `{"id": <requested_ein>, "name": "Unknown Organization"}` with all org fields null — placeholder/dummy EIN (e.g., 999999999) that exists as an artifact but is not a real organization

Detection order in the service layer: (1) non-2xx → check for `{"error": ...}` JSON → `not_found`; (2) 200 with `id === 0` → `not_found`; (3) 200 with `organization.name === "Unknown Organization"` AND `organization.address === null` → `not_found`. Note: a real sparse org (in the IRS BMF but no 990 filings) has a real org name — that is a successful lookup with an empty filing list, not `not_found`.

**6. `pdf_url` can be null in filings_with_data**
The API marks `pdf_url` as nullable in the response schema; IRS PDF processing batches occasionally lag behind the extracted financial data, leaving `pdf_url: null` temporarily. The output schema marks `pdf_url` as `string | null`. The format function renders "PDF not yet available for this period" when null rather than omitting the field silently. The `filings_pdf_only` array (from `filings_without_data`) surfaces older filings that have a PDF but no extracted data.

**7. Search total_results caps at 10000, and pagination has four distinguishable end states**
Verified: when filters return more than 10000 results, the API reports `total_results: 10000` and `num_pages: 400`. This is an API ceiling, not the actual count. The output schema documents the field's ceiling as static prose; the runtime signal that *this* response hit it rides the enrichment notice, so it reaches `structuredContent` and `content[]` alike.

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

**11. IRS Business Master File codes are decoded, and the raw code is kept**
`deductibility_code`, `exempt_organization_status_code`, and `foundation_code` arrive as opaque integers. Each is rendered as `"<code> — <meaning>"` against the tables in the [IRS EO BMF layout](https://www.irs.gov/pub/foia/ig/tege/eo-info.pdf), so the caller neither has to hold the code tables nor loses the ability to trace the value back to the upstream record. Deductibility decodes to a label rather than a boolean: `4` (deductible by treaty, foreign organizations) is a third state that `true`/`false` would silently fold into one of the other two. A code outside the published table renders as `"<code> — unrecognized code"` rather than `null` — the tables gain entries over time, and dropping an unmapped code would report "not on record" for a value the IRS did record.

`sort_name` is the BMF secondary name line (`SORT_NAME`), an internal sort key — a division or service-center label — not an alternate organization name. It is surfaced under that name so it is not read as one.

**12. `format()` renders nulls, and names why each one is null**
Every nullable terminal field in `output` renders in `format()`, null included. Omitting the line when a value is null diverges the two response surfaces: `structuredContent` keeps the explicit `null`, while a `content[]`-only client cannot tell an absent value from a field the response never carried. The same reasoning applies to a section gated on a subset of its contents — the Business Master File summary was gated on `asset_amount`/`income_amount`, which dropped a populated `revenue_amount` whenever the other two were null.

The labels stay distinct per condition, because the nulls mean different things and collapsing them to one generic marker discards information the agent needs. The set below is the whole vocabulary — one label per condition, no synonyms. Reuse one of these rather than coining a new spelling:

| Label | Meaning |
|:------|:--------|
| `Not applied` | A filter the caller did not supply |
| `Not on record` | A value the IRS Business Master File does not carry for this org |
| `Not classified` | No IRS classification code on record — an absent NTEE code or 501(c) subsection |
| `Not extracted` | A figure ProPublica did not pull from a filing that carries it |
| `Not reported` | A figure the organization left blank on the filing |
| `Not applicable for <form type>` | A line item that does not exist on the form type filed |
| `Not derivable from this data source` | A figure no field in the response can produce (the program-expense ratio, Decision 3) |
| `Not provided` | A ProPublica record field the API left empty (`updated`) |
| `Not yet available for this period` | A `pdf_url` the IRS has not published yet (Decision 6) |

`Not on record` and `Not reported` are the pair most easily conflated, so the boundary is the source: anything read from the Business Master File that the IRS never recorded is `Not on record`, and `Not reported` is reserved for a figure an organization left blank on a *filing*, where the enclosing section header already names which filing. Naming an org's own omission on a due-diligence surface is a claim about the org, so it is not applied to values the IRS simply never captured.

The form type picks the label where it decides the meaning: a null `contributions_and_grants` on a 990-PF is inapplicable, the same null on a 990 is unextracted.

---

## Known Limitations

- **Data lag:** 990 filings are annual and IRS processing adds further delay. The most recent `tax_prd_yr` is typically 1–2 years behind the current year. The tools surface `tax_prd_yr` prominently; agents must not present these figures as current.
- **No individual officer compensation detail:** The extract includes total officer compensation (`compnsatncurrofcr`) but not per-officer breakdown. Individual named executive pay appears only in Schedule J of the full 990 PDF. Users needing per-person data must read the linked PDF.
- **Small orgs have no filings:** Form 990N (e-Postcard) returns from organizations under $50,000 in revenue are not in Nonprofit Explorer. Such an org may still resolve from the IRS BMF with a real name and address, in which case `nonprofit_get_filings` returns an empty `filings` array with a notice; an EIN that resolves to nothing at all is `not_found`.
- **No program expense ratio:** ProPublica's extract carries no Form 990 Part IX column (B) program-service total, so the program/management/fundraising split cannot be derived from it (see Decision 3). `program_expense_ratio` is always `null`; the split is available only by reading Part IX of the linked PDF.
- **No bulk search or EIN lookup list:** The API has no batch endpoint. Multiple EIN lookups require separate requests.
- **Search results beyond 10,000 are unreachable:** ProPublica refuses any page whose result offset reaches 10,000, so pages above 399 cannot be fetched at all (see Decision 7). `nonprofit_search` reports this as `pagination_ceiling` and directs the caller to narrow the query; there is no workaround that walks past the ceiling.
- **NTEE filter is coarse:** The integer categories (1–10) map to major NTEE groups. There's no filter for sub-codes like "E210" (hospitals within Health). Search results include `ntee_code` (full sub-code) for post-hoc filtering in the client.
