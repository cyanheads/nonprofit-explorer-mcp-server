/**
 * @fileoverview Domain types for the ProPublica Nonprofit Explorer API v2.
 * @module services/nonprofit-explorer/types
 */

// ---------------------------------------------------------------------------
// Raw upstream types — may have absent fields; all optional unless guaranteed
// ---------------------------------------------------------------------------

/** Raw org record from the search results array. */
export interface RawSearchOrg {
  city?: string | null;
  ein: number;
  name?: string;
  ntee_code?: string | null;
  score?: number;
  state?: string | null;
  strein?: string;
  sub_name?: string | null;
  subseccd?: number | null;
}

/**
 * Raw search response envelope.
 *
 * Pagination metadata is present on every shape except the HTTP 400 offset-ceiling
 * response, which carries only `data_source`, `api_version`, and `error`.
 */
export interface RawSearchResponse {
  cur_page?: number;
  data_source?: string;
  /** Upstream failure text — the offset-ceiling response's "Pagination out of range". */
  error?: string;
  num_pages?: number;
  organizations?: RawSearchOrg[];
  /** Zero-indexed offset of the first result on this page. */
  page_offset?: number;
  /** Results per page as applied by the API. */
  per_page?: number;
  total_results?: number;
}

/** Raw filing with extracted financial data. */
export interface RawFiling {
  compnsatncurrofcr?: number | null;
  compofficers?: number | null;
  form_type?: string;
  formtype?: number; // 0=990, 1=990-EZ, 2=990-PF
  invstmntinc?: number | null;
  othrsalwages?: number | null;
  pdf_url?: string | null;
  profndraising?: number | null;
  tax_prd?: number;
  tax_prd_yr?: number;
  totassetsend?: number | null;
  totcntrbgfts?: number | null;
  totfuncexpns?: number | null;
  totliabend?: number | null;
  totnetassetend?: number | null;
  totprgmrevnue?: number | null;
  totrevenue?: number | null;
  updated?: string | null;
}

/** Raw PDF-only filing (filings_without_data). */
export interface RawPdfOnlyFiling {
  formtype?: number; // 0=990, 1=990-EZ, 2=990-PF (numeric — same as filings_with_data)
  formtype_str?: string; // "990", "990EZ", "990PF" (human-readable string field)
  pdf_url?: string | null;
  tax_prd?: number;
  tax_prd_yr?: number;
}

/**
 * Raw organization profile from the org endpoint.
 *
 * The `deductibility_code`, `exempt_organization_status_code`, `foundation_code`, and
 * `tax_period` fields come from the IRS Exempt Organizations Business Master File, not
 * from an extracted Form 990 — their code tables are documented in the IRS EO BMF
 * layout (https://www.irs.gov/pub/foia/ig/tege/eo-info.pdf).
 */
export interface RawOrganization {
  address?: string | null;
  asset_amount?: number | null;
  city?: string | null;
  data_source?: string;
  /** IRS BMF deductibility of contributions: 1 = yes, 2 = no, 4 = yes by treaty. */
  deductibility_code?: number | null;
  ein?: number;
  /** IRS BMF exemption status: 1 = unconditional, 2 = conditional, 12 and 25 are trusts/terminations. */
  exempt_organization_status_code?: number | null;
  filings_with_data?: RawFiling[];
  filings_without_data?: RawPdfOnlyFiling[];
  /** IRS BMF foundation classification: 2–4 are private foundations, 10–25 are public charities. */
  foundation_code?: number | null;
  id?: number;
  income_amount?: number | null;
  name?: string;
  ntee_code?: string | null;
  revenue_amount?: number | null;
  ruling_date?: string | null;
  /** IRS BMF secondary name line (SORT_NAME) — an internal sort key, not an alternate org name. */
  sort_name?: string | null;
  state?: string | null;
  strein?: string;
  subsection_code?: number | null;
  /** Tax period of the latest return recorded in the BMF; often newer than the latest extracted 990. */
  tax_period?: string | null;
  zipcode?: string | null;
}

/** Raw org endpoint response envelope. */
export interface RawOrgResponse {
  data_source?: string;
  filings_with_data?: RawFiling[];
  filings_without_data?: RawPdfOnlyFiling[];
  organization?: RawOrganization;
}

// ---------------------------------------------------------------------------
// Search params
// ---------------------------------------------------------------------------

export interface SearchParams {
  ntee_category?: string | undefined;
  page: number;
  query: string;
  state?: string | undefined;
  subsection_code?: string | undefined;
}
