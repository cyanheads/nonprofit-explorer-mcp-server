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

/** Raw search response envelope. */
export interface RawSearchResponse {
  cur_page?: number;
  data_source?: string;
  num_pages?: number;
  organizations?: RawSearchOrg[];
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
  formtype?: string; // "990", "990EZ", "990PF"
  pdf_url?: string | null;
  tax_prd_yr?: number;
}

/** Raw organization profile from the org endpoint. */
export interface RawOrganization {
  address?: string | null;
  asset_amount?: number | null;
  city?: string | null;
  data_source?: string;
  ein?: number;
  filings_with_data?: RawFiling[];
  filings_without_data?: RawPdfOnlyFiling[];
  id?: number;
  income_amount?: number | null;
  name?: string;
  ntee_code?: string | null;
  revenue_amount?: number | null;
  ruling_date?: string | null;
  sort_name?: string | null;
  state?: string | null;
  strein?: string;
  subsection_code?: number | null;
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
