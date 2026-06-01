# nonprofit-explorer-mcp-server — idea

US tax-exempt organizations via [ProPublica's Nonprofit Explorer](https://projects.propublica.org/nonprofits/) — IRS Form 990 data on 1.8M+ nonprofits: mission, revenue, expenses, assets, and executive compensation, with links to the source filings. Keyless.

Nonprofits (charities, foundations, hospitals, universities, advocacy groups) are a large slice of the economy with their own public financial disclosures via the IRS Form 990. This server makes those disclosures queryable and links every figure back to the source filing.

**Audience:** Journalists, donors doing due diligence, researchers, grant-seekers, watchdogs, and agents answering "how much does this charity spend on programs vs. overhead?" or "what does the CEO of this foundation make?"

## User Goals

- Find a nonprofit by name, location, or category
- Get an organization's financial profile: revenue, expenses, assets, net assets
- See executive compensation
- List an org's Form 990 filings over time with the source PDFs
- Compare nonprofits or track financial trends

## API Surface

Keyless REST at `projects.propublica.org/nonprofits/api/v2/`. Organizations are keyed by **EIN** (Employer Identification Number).

| Endpoint | Purpose | Notes |
|:---------|:--------|:------|
| `/search.json?q=` | Search orgs by name/keyword | Filters: `state[id]`, `ntee[id]` (category), `c_code[id]` (501(c) type) |
| `/organizations/{ein}.json` | Full org profile + all filings | Financials per filing year, exec comp, PDF/XML links |

NTEE codes classify the sector (arts, education, health, human services, …); 501(c) subcodes distinguish charities (c3) from social-welfare (c4), business leagues (c6), etc. Financial fields come from each year's 990 (revenue, expenses, assets, liabilities, compensation).

## Tool Surface (sketch)

```
nonprofit_search          — find tax-exempt orgs by name/keyword. Filters: state, NTEE
                            category (arts, education, health, human-services, ...),
                            501(c) subtype. Returns EIN, name, city/state, NTEE code,
                            and subsection. Required first step — profiles key on EIN.

nonprofit_get_organization — full profile by EIN: legal name, address, mission/NTEE
                            classification, ruling year, and the financial summary from
                            the most recent filing (total revenue, expenses, assets, net
                            assets). The "who is this org and how big are they?" tool.

nonprofit_get_filings     — all Form 990 filings for an EIN over time: year, total
                            revenue/expenses/assets, and the source document links
                            (PDF/XML). Surfaces trends and the primary-source filings for
                            verification. Include reported executive compensation where
                            present.
```

## Design Notes

- Low-medium complexity — keyless REST, EIN-keyed. The work is in **financial-field curation** (990s have many line items; surface the ones that answer real questions — program vs. overhead ratio, top-exec pay, year-over-year revenue) and **NTEE/501(c) code translation** (resolve human terms like "homeless shelter" or "charity" to the code filters).
- **Always link the source filing.** This is financial-disclosure data used for due diligence and journalism — return the 990 PDF/XML URL so claims are verifiable. Don't present a derived number without the primary source.
- **Don't fabricate ratios as authoritative.** A "program expense ratio" is a real, computable figure from 990 line items — compute it transparently and show the inputs; never present a synthetic "trust score."
- Data lags (990s are filed annually, often 1–2 years behind) — surface the filing year prominently so the agent doesn't imply current figures.
- Attribution: data via ProPublica Nonprofit Explorer (itself sourced from IRS) — credit both. Respect courtesy rate limits.
- Composes with `secedgar` (a nonprofit hospital/university vs. a for-profit peer), `usaspending` (nonprofits receiving federal grants — cross-reference recipients), `openfec` (501(c)(4) orgs that also appear in campaign finance).
- Moonshot: a "charity due-diligence" workflow — resolve an org, pull the latest financials, compute program/overhead and exec-pay context, and link every figure to its 990.

**README one-liner:** "Nonprofit financials from 1.8M+ IRS Form 990 filings — revenue, spending, and executive pay, no key."
