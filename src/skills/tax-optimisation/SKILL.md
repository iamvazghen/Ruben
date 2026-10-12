---
name: tax-optimisation
description: Research the tax rules of the owner's residence and of every country where their assets sit, then find the legal ways to pay less — allowances, exemptions, holding periods, treaty relief, deductions, account choices — ranked by money. Triggers on "how can I pay less tax", "tax benefits in <country>", "set my tax residence", "I moved to …", "what do I owe on my crypto/rent/dividends", "optimise my taxes", or a new jurisdiction appearing in /accounts.
---

# Tax Optimisation Skill

Legal optimisation only — never evasion, never hiding assets or income. The
owner's situation is read from their data, not assumed: residence, accounts
and where each sits, asset types, properties, salary.

## Workflow Checklist

```
Tax Progress:
- [ ] Step 1: Map the position
- [ ] Step 2: Research what is missing
- [ ] Step 3: Apply it to the owner's numbers
- [ ] Step 4: Compliance duties
- [ ] Step 5: Deliver, ranked by money
```

## Step 1: Map the position

`tax_jurisdiction show`. It lists the residence and every jurisdiction where
assets sit (from account and property countries), what is held in each, and
the topics still to research — including the treaty between residence and each
foreign country. If residence is not set, ask and `tax_jurisdiction set` it.
If holdings are not tied to accounts, fix that first (`accounts`,
`portfolio_update` with `account`): without it, nothing can be attributed to
a country.

## Step 2: Research what is missing

For each `to_research` topic, search official sources first: the tax
authority, the finance ministry, the statute, the treaty text (OECD and
national treaty pages), then reputable secondary sources. Read the page
(`web_fetch`), extract the rule with its numbers (rates, allowances,
thresholds, holding periods, deadlines) and the year it applies to, and save
it: `tax_knowledge save` with topic, rule, benefit, source URL, date, and
whether the source is official. One rule per note. Re-check notes flagged
stale.

Topics that usually carry the money:
- **Allowances and exemptions** — annual capital-income allowances, partial
  exemptions for funds, tax-free thresholds.
- **Holding periods** — crypto, gold and private assets are often tax-free
  after a holding period (Germany: one year).
- **Withholding and treaties** — the treaty rate on foreign dividends,
  reclaiming excess withholding, forms such as the US W-8BEN.
- **Losses** — which losses offset which gains, carry-forward, certificates.
- **Real estate** — deductible interest, depreciation, maintenance, holding
  periods for tax-free sale.
- **Pension and retirement accounts** — state-subsidised schemes and their limits.
- **Salary** — work-related deductions, tax class or filing choice.
- **Fund type** — accumulating vs distributing, and the fund's domicile.

## Step 3: Apply it to the owner's numbers

Use `tax_year_summary` (current year for planning, last year for the
return), `accounts`, `portfolio_view`, `property_review`, `salary show`. Turn
each rule into a concrete action with an estimate: "realise €640 of the VWCE
gain before 31 December: it fits the remaining allowance, saves about €169".
State assumptions.

## Step 4: Compliance duties

Duties that follow from where things sit: declaring foreign accounts and
foreign income, cross-border payment reporting, crypto reporting, exit
taxation when moving, deadlines. Missing one costs more than any optimisation
saves; list them.

## Step 5: Deliver, ranked by money

Lead with the largest legal saving. Each item: the action, the money, the rule
with its source, the deadline. Mark anything that depends on facts RUBEN does
not have. For decisions with large sums, cross-border moves or company
structures, recommend confirming with a licensed tax adviser in that country —
and say what to ask them.
