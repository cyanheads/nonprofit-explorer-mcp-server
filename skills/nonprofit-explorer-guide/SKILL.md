---
name: nonprofit-explorer-guide
description: Use with nonprofit_* tools for nonprofit diligence, financial trends, peer comparisons, and fundraising or compensation research. Resolve entity identity, distinguish extracted financials from newer returns, and decide when the source Form 990 is required before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use Nonprofit Explorer for historical IRS organization records and Form 990 financial evidence. It cannot establish current exemption from its lagging Business Master File snapshot, supply individual officer pay from aggregate compensation, or reconstruct functional program expenses from the extract. When a decision depends on those facts, obtain the relevant current IRS record or source filing.

## Identifiers

For a name-only request, obtain the EIN from nonprofit_search_organizations. Match the legal name, location, and secondary name line before following the EIN: a chapter or service center can differ from the national organization. A repeated legal name in the secondary name field is not evidence of a separate entity. Use the formatted EIN when presenting identity; numeric EINs can omit leading zeros.

## Gates

1. For the newest available financial evidence, compare the extracted snapshot, the PDF-only history, and the period printed on the organization’s newest rendered e-file. The viewer can cover a later return than either history. Use a historical row’s own PDF for that row.
2. Align fiscal periods, form types, and financial concepts before comparing organizations. Read `income_amount` as computed gross receipts for the BMF period. The BMF dates identify a month even though the API supplies day `01`. Keep distinct returns from the same period until you establish amendment precedence.
3. Before calculating a change or ratio, require the actual inputs. Null is not zero: retain the response's distinction between an unextracted figure, an inapplicable line, and a supported figure reported as zero. Mark gaps rather than filling them.
4. Before concluding that an organization has no filing history, check both extracted and PDF-only records and whether the response was narrowed to a year window. An empty selected window says nothing about other years. Even an entirely empty history establishes only that this dataset holds no return, not noncompliance or a reason for absence.
5. Use decoded BMF filing requirements to contextualize missing history without treating them as proof of why a return is absent. A group exemption number or subordinate affiliation alone does not prove inclusion in a group return. Do not infer Form 990-N solely from missing filings.
6. Before reporting a program-spending ratio, obtain the actual functional allocation. Subtracting officer compensation, other wages, payroll taxes, or professional fundraising fees from total expenses cannot reconstruct program spending. The extract's program_expense_ratio remains null; Form 990 Part IX supplies the allocation.
7. For an individual officer’s pay, use the source return for the requested period. Read Part VII of Form 990 and Schedule J when applicable, or Part IV of Form 990-EZ. The EZ extract omits compensation.
8. For name and city, require both terms, for example `+opera +seattle`. State filters describe headquarters. Feeding a full NTEE code into a peer search selects its entire major group. Check the returned full code and foundation type for each peer and resolve any search-ceiling notice before claiming completeness.

## Workflows

### Donation or grant diligence

Resolve the intended entity, then use nonprofit_get_organization to separate IRS classifications, BMF context, and extracted financials. Distinguish public charities from private foundations rather than treating every 501(c)(3) as the same organization type. For current exemption questions, verify outside the BMF snapshot. Follow nonprofit_get_filings to inspect coverage and source documents before drawing conclusions about activity or financial health.

### Financial trends and peer comparisons

Select the requested fiscal-year interval across both filing collections. Compare the unfiltered counts and year spans before interpreting an empty interval. A year between the endpoints can still have no return. Label financial comparisons with the period and form.

For 990-PF, investment_income covers savings interest plus dividends and securities interest, excluding capital gains, rents, and net investment income. Do not treat it as total investment performance or interchange it with net_investment_income. Keep grants paid, required distributable amount, and fair-market-value assets distinct; their presence does not establish payout compliance.

### Fundraising and compensation research

Keep professional fundraising fees distinct from total fundraising expense. Form 990 event gross, direct expense, and net figures describe events; 990-EZ direct expense and net figures combine gaming with fundraising. Do not compare the combined EZ figures as event-only results or infer event-only net from them. Preserve negative net amounts as reported.

For compensation, use the form-specific source and note returned with the amount. Check the return itself for individual pay. ProPublica’s `pct_compnsatncurrofcr` cannot establish a governance ratio.
