/**
 * @fileoverview Complete IRS BMF filing/affiliation dictionary and neutral notice coverage.
 * @module tests/services/nonprofit-explorer/filing-requirements.test
 */
import { describe, expect, it } from 'vitest';
import {
  emptyHistoryNotice,
  filingRequirements,
} from '@/services/nonprofit-explorer/filing-requirements.js';

describe('filingRequirements', () => {
  it.each([
    [0, 'Not required to file (all other)'],
    [1, '990 (all other) or 990-EZ return'],
    [2, 'Required to file Form 990-N (income less than $50,000 per year)'],
    [3, '990 group return'],
    [4, 'Required to file Form 990-BL (Black Lung Trusts)'],
    [6, 'Not required to file (church)'],
    [7, 'Government 501(c)(1)'],
    [13, 'Not required to file (religious organization)'],
    [14, 'Not required to file (instrumentalities of states or political subdivisions)'],
    [99, 'unrecognized code'],
  ])('decodes filing code %i and limits 990-N guidance to code 2', (code, label) => {
    expect(filingRequirements({ filing_requirement_code: code }).filing_requirement).toBe(
      `${code} — ${label}`,
    );
    const notice = emptyHistoryNotice({ name: 'Test', filing_requirement_code: code }, 123456789);
    expect(notice.includes('990-N')).toBe(code === 2);
    expect(notice).toContain('do not establish why');
  });

  it.each([
    [1, 'Central organization (no group exemption)'],
    [2, 'Intermediate organization (no group exemption)'],
    [3, 'Independent organization or independent auxiliary'],
    [6, 'Central parent in a group ruling (not a church or 501(c)(1) organization)'],
    [7, 'Intermediate group exemption organization'],
    [8, 'Central parent in a group ruling (church or 501(c)(1) organization)'],
    [9, 'Subordinate in a group ruling'],
    [0, 'unrecognized code'],
    [99, 'unrecognized code'],
  ])('decodes affiliation %i', (code, label) => {
    expect(filingRequirements({ affiliation_code: code }).affiliation).toBe(`${code} — ${label}`);
  });

  it.each([
    [0, 'No 990-PF return'],
    [1, '990-PF return'],
    [99, 'unrecognized code'],
  ])('decodes PF requirement %i', (code, label) => {
    expect(filingRequirements({ pf_filing_requirement_code: code }).pf_filing_requirement).toBe(
      `${code} — ${label}`,
    );
  });

  it('keeps absent codes and group numbers distinct from zero', () => {
    expect(filingRequirements({})).toEqual({
      filing_requirement: null,
      pf_filing_requirement: null,
      affiliation: null,
      group_exemption_number: null,
    });
    expect(filingRequirements({ exemption_number: 0 }).group_exemption_number).toBe(0);
    expect(emptyHistoryNotice({ exemption_number: 928 }, 123456789)).toContain(
      'does not establish inclusion in a group return',
    );
    expect(emptyHistoryNotice({ affiliation_code: 9 }, 123456789)).toContain(
      'does not establish inclusion in a group return',
    );
  });
});
