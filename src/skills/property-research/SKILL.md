---
name: property-research
description: Research a property's market — local rent per m², comparable sale prices, mortgage rates, price and rent trends — and record it on the owner's property with date and source. Triggers on "what rent can I charge", "what is my apartment worth", "rent per square meter in <city>", "should I refinance", "is this a good buy", or before a property review when market data is missing or stale.
---

# Property Research Skill

Works for any country. The structured sources cover the euro area and the EU;
everywhere else the answer comes from searching, and it must say so.

## 1. National trend (structured)

- `housing_market <country>` — Eurostat house prices (existing vs new) and rent
  inflation, EU/EEA.
- `mortgage_rates <country>` — ECB rates on new house-purchase loans by fixation
  period, euro area. US: `get_fred_series MORTGAGE30US`. Elsewhere: the national
  central bank's statistics via `web_search`.

## 2. Local level (search, then cite)

National indices say nothing about one street. For rent per m² and price per m²:

1. Official rent index first — in Germany the municipal *Mietspiegel*
   (qualified where it exists; it also bounds legal rent increases), in
   Austria the *Richtwert*, in France the *observatoires locaux des loyers*.
2. Listing portals for asking rents and prices (e.g. ImmoScout24, Immowelt,
   idealista, Rightmove, Zillow, list.am), filtered to the same size, rooms,
   condition and area. Asking is above achieved: say so.
3. US addresses: `rentcast_rent_estimate` and `rentcast_value_estimate`.

Report a range and the number of comparables, never one number from one ad.

## 3. Record it

`property_manage update` with `market_rent_m2` and/or `value`, each with
`as_of` and `source`. Confirm the figures with the owner first. Then run
`property_review` so the gap to market and the yield are recomputed.

## 4. Rules

- A rent increase must respect local law (in Germany caps on increases and the
  Mietpreisbremse); flag the gap, do not promise it can be closed.
- Refinancing: compare the rate the owner can lock now against what the review
  says the fixation will cost; mention early-repayment penalties.
