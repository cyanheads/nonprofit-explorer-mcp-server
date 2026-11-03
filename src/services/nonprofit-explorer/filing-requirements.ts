/**
 * @fileoverview IRS BMF filing and affiliation classifications and neutral empty-history guidance.
 * @module services/nonprofit-explorer/filing-requirements
 */
import type { RawOrganization } from './types.js';

const FILING = new Map([
  [0, 'Not required to file (all other)'],
  [1, '990 (all other) or 990-EZ return'],
  [2, 'Required to file Form 990-N (income less than $50,000 per year)'],
  [3, '990 group return'],
  [4, 'Required to file Form 990-BL (Black Lung Trusts)'],
  [6, 'Not required to file (church)'],
  [7, 'Government 501(c)(1)'],
  [13, 'Not required to file (religious organization)'],
  [14, 'Not required to file (instrumentalities of states or political subdivisions)'],
]);
const PF = new Map([
  [0, 'No 990-PF return'],
  [1, '990-PF return'],
]);
const AFFILIATION = new Map([
  [1, 'Central organization (no group exemption)'],
  [2, 'Intermediate organization (no group exemption)'],
  [3, 'Independent organization or independent auxiliary'],
  [6, 'Central parent in a group ruling (not a church or 501(c)(1) organization)'],
  [7, 'Intermediate group exemption organization'],
  [8, 'Central parent in a group ruling (church or 501(c)(1) organization)'],
  [9, 'Subordinate in a group ruling'],
]);

function decode(
  code: number | null | undefined,
  labels: ReadonlyMap<number, string>,
): string | null {
  return code == null ? null : `${code} — ${labels.get(code) ?? 'unrecognized code'}`;
}

/** Decode published IRS EO BMF classifications without conflating missing and zero codes. */
export function filingRequirements(org: RawOrganization) {
  return {
    filing_requirement: decode(org.filing_requirement_code, FILING),
    pf_filing_requirement: decode(org.pf_filing_requirement_code, PF),
    affiliation: decode(org.affiliation_code, AFFILIATION),
    group_exemption_number: org.exemption_number ?? null,
  };
}

/** Describe dataset absence, never infer the cause of an individual organization's missing return. */
export function emptyHistoryNotice(org: RawOrganization, ein: number): string {
  const fields = filingRequirements(org);
  const classification = `BMF filing requirement: ${fields.filing_requirement ?? 'not on record'}; PF filing requirement: ${fields.pf_filing_requirement ?? 'not on record'}.`;
  const postcard =
    org.filing_requirement_code === 2
      ? ' Form 990-N e-Postcards are not covered by this dataset.'
      : '';
  const group =
    org.exemption_number || [6, 7, 8, 9].includes(org.affiliation_code ?? -1)
      ? ' A group exemption or affiliation does not establish inclusion in a group return.'
      : '';
  return `Organization "${org.name ?? ''}" (EIN ${ein}) resolved, but Nonprofit Explorer holds no Form 990 for it. ${classification}${postcard}${group} These classifications do not establish why a particular return is absent; filing data also lags 1–2 years.`;
}
