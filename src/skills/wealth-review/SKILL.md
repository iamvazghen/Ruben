---
name: wealth-review
description: Full review of the owner's whole financial position — securities, funds, cash, real estate, commitments, income and tax — ending in concrete allocation recommendations. Triggers on "review my portfolio", "how is my allocation", "what should I do with my dividends", "am I diversified", "check my properties", "year-end tax planning", "prepare my tax return", or a scheduled review.
---

# Wealth Review Skill

Person-agnostic: every number comes from the owner's own records and settings
(base currency, tax residence, targets). Never assume a country, a broker or a
risk appetite — read them, and ask when they are missing.

## Workflow Checklist

```
Review Progress:
- [ ] Step 1: The whole picture
- [ ] Step 2: What is really owned
- [ ] Step 3: What is going wrong
- [ ] Step 4: Income and what to do with it
- [ ] Step 5: Real estate
- [ ] Step 6: Tax
- [ ] Step 7: Recommendations
```

## Step 1: The whole picture

`wealth_overview`. Net worth, allocation across asset classes (stocks, ETFs,
bonds, cash reserve, real estate equity), 12-month income against mortgage
payments and other `commitments`. Read every flag. If targets are not set
(`rebalance_targets`), say that drift cannot be judged and offer to set them.

## Step 2: What is really owned

`fund_look_through`. Three ETFs can be one bet on the same ten companies. Report
the largest underlying names across funds and direct holdings, overlap, sector
tilt and the annual fund cost in money, not just percent.

## Step 3: What is going wrong

`portfolio_alerts`, then for each flagged holding the news behind it
(`get_company_news`; `news_materiality` and `thesis_check` when available).
A fall with no news is market noise until shown otherwise; a fall with a
guidance cut is a thesis question. Say which.

## Step 4: Income and what to do with it

`income_forecast`: what arrives over 12 months net of tax, by month and holding,
and the yield plan's split. For the reinvested part, the deployment section says
which underweight bucket it should fill. Before naming instruments, check the
market: `ecb_policy_rate` (what cash earns — the bar a reinvestment must beat),
`grade_ticker` on candidates, and `dividend_safety` on the largest payers. A
reserve that earns more than a holding yields after tax is a fair answer too.

## Step 5: Real estate

`property_review`. Cash flow after debt service, loan-to-value, yield against
`mortgage_rates` and `housing_market`, rent per m² against the local market, and
every fixation ending within two years priced at today's rate. If a property has
no `market_rent_m2` or its valuation is over a year old, use the
property-research skill to update it first.

## Step 6: Tax

`tax_year_summary` for the current year: unused allowance, losses that could
offset realised gains, gains that fit in the allowance. In tax season, the same
tool for the previous year gives the figures for the return and, for German
residents, the forms they go on. RUBEN prepares; the owner or an adviser files.

## Step 7: Recommendations

Group them: **act now** (a thesis broken, a fixation about to reset, a dividend
cut), **next contribution** (where new money and dividends go), **watch**.
Each with the number behind it and its source. Never execute a trade or change
a stored setting without the owner's explicit yes.
