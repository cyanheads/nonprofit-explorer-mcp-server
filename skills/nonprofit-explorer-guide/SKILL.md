---
name: nonprofit-explorer-guide
description: Use with nonprofit_* tools for nonprofit diligence, financial trends, peer comparisons, and fundraising or compensation research. Resolve entity identity, distinguish extracted financials from newer returns, and decide when the source Form 990 is required before drawing conclusions.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use Nonprofit Explorer for historical IRS organization records and Form 990 financial evidence. It cannot establish current exemption from its lagging Business Master File snapshot, supply individual officer pay from aggregate compensation, or reconstruct functional program expenses from the extract. When a decision depends on those facts, obtain the relevant current IRS record or source filing.

## Identifiers

For a name-only request, obtain the EIN from nonprofit_search_organizations. Match the legal name, location, and secondary name line before following the EIN: a chapter or service center can differ from the national organization. A repeated legal name in the secondary name field is not evidence of a separate entity. Use the formatted EIN when presenting identity; numeric EINs can omit leading zeros.

## Gates

1. Before calling figures “latest,” distinguish the newest return from the newest extracted snapshot. Check PDF-only returns as well as extracted filings. A newer PDF establishes a newer return, not newer extracted financials; inspect that document if the question requires its figures.
2. Before comparing years or organizations, align fiscal years, full tax periods, form types, and financial concepts. Keep BMF amounts separate from dated filing figures. Preserve multiple returns for the same year or period; ordering alone does not establish amendment precedence.
3. Before calculating a change or ratio, require the actual inputs. Null is not zero: retain the response's distinction between an unextracted figure, an inapplicable line, and a supported figure reported as zero. Mark gaps rather than filling them.
4. Before concluding that an organization has no filing history, check both extracted and PDF-only records and whether the response was narrowed to a year window. An empty selected window says nothing about other years. Even an entirely empty history establishes only that this dataset holds no return, not noncompliance or a reason for absence.
5. Use decoded BMF filing requirements to contextualize missing history without treating them as proof of why a return is absent. A group exemption number or subordinate affiliation alone does not prove inclusion in a group return. Do not infer Form 990-N solely from missing filings.
6. Before reporting a program-spending ratio, obtain the actual functional allocation. Subtracting officer compensation, other wages, payroll taxes, or professional fundraising fees from total expenses cannot reconstruct program spending. The extract's program_expense_ratio remains null; Form 990 Part IX supplies the allocation.
7. Before answering a named person's compensation question, inspect the source filing. Aggregate officer compensation is not CEO pay. For 990-EZ, the extract supplies no compensation amount; consult Part IV of its PDF rather than interpreting null as an organization reporting no compensation.
8. Before describing a search-derived peer set as complete, resolve any search-ceiling notice. State filters describe headquarters, not service areas; NTEE major groups are broad. Check the full NTEE classification and foundation type when the comparison requires narrower peers.

## Workflows

### Donation or grant diligence

Resolve the intended entity, then use nonprofit_get_organization to separate IRS classifications, BMF context, and extracted financials. Distinguish public charities from private foundations rather than treating every 501(c)(3) as the same organization type. For current exemption questions, verify outside the BMF snapshot. Follow nonprofit_get_filings to inspect coverage and source documents before drawing conclusions about activity or financial health.

### Financial trends and peer comparisons

Select the requested fiscal-year interval across both filing collections. Check the unfiltered counts before interpreting an empty interval. Build comparisons from compatible figures and label each with its period and form; explain a form change or a missing year rather than silently treating the series as continuous.

For 990-PF, investment_income covers savings interest plus dividends and securities interest, excluding capital gains, rents, and net investment income. Do not treat it as total investment performance or interchange it with net_investment_income. Keep grants paid, required distributable amount, and fair-market-value assets distinct; their presence does not establish payout compliance.

### Fundraising and compensation research

Keep professional fundraising fees distinct from total fundraising expense. Form 990 event gross, direct expense, and net figures describe events; 990-EZ direct expense and net figures combine gaming with fundraising. Do not compare the combined EZ figures as event-only results or infer event-only net from them. Preserve negative net amounts as reported.

For compensation, use the form-specific source and note returned with the amount. Follow the PDF for individual pay or unavailable EZ amounts. Do not substitute ProPublica's pct_compnsatncurrofcr field for a missing compensation figure or treat it as a reliable governance ratio.
