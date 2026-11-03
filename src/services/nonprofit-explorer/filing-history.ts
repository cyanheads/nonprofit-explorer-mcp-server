/**
 * @fileoverview Period ordering and nullable return metadata across extracted and PDF-only histories.
 * @module services/nonprofit-explorer/filing-history
 */
import type { RawFiling, RawPdfOnlyFiling } from './types.js';

/** Sort newest full tax period first; equal periods retain upstream order, not amendment precedence. */
export function compareTaxPeriods(
  a: RawFiling | RawPdfOnlyFiling,
  b: RawFiling | RawPdfOnlyFiling,
): number {
  return (b.tax_prd ?? (b.tax_prd_yr ?? 0) * 100) - (a.tax_prd ?? (a.tax_prd_yr ?? 0) * 100);
}

/** Normalize known form spellings while retaining unknown labels and absent metadata. */
export function returnFormLabel(filing: RawFiling | RawPdfOnlyFiling): string | null {
  const label =
    'formtype_str' in filing
      ? filing.formtype_str
      : 'form_type' in filing
        ? filing.form_type
        : undefined;
  if (label != null) {
    if (label === '990EZ' || label === '990-EZ') return '990-EZ';
    if (label === '990PF' || label === '990-PF') return '990-PF';
    return label;
  }
  return filing.formtype === 0
    ? '990'
    : filing.formtype === 1
      ? '990-EZ'
      : filing.formtype === 2
        ? '990-PF'
        : null;
}
