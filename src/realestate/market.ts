/**
 * Housing-market data that needs no key: ECB MFI interest rate statistics for
 * mortgage rates (euro area, by country and by length of rate fixation) and
 * Eurostat for house prices and rents (EU and EEA). Anything outside that
 * coverage returns null so the agent says so and searches instead of guessing.
 */

const ECB = 'https://data-api.ecb.europa.eu/service/data/MIR';
const EUROSTAT = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

/** Euro-area members reporting MFI interest rates, plus U2 (the euro area as a whole). */
export const ECB_MIR_COUNTRIES = ['U2', 'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];

/** ECB MIR maturity codes for house-purchase loans, by initial rate fixation. */
export const FIXATION = {
  all: 'AM',
  'floating_or_up_to_1y': 'F',
  '1y_to_5y': 'I',
  '5y_to_10y': 'O',
  over_10y: 'P',
} as const;

async function text(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** Rate on new house-purchase loans to households, latest and a year earlier, in percent. */
export async function mortgageRates(country: string): Promise<{
  country: string; source: string;
  rates: Record<keyof typeof FIXATION, { period: string; rate: number; year_ago: number | null } | null>;
} | null> {
  const cc = country.toUpperCase() === 'EA' ? 'U2' : country.toUpperCase();
  if (!ECB_MIR_COUNTRIES.includes(cc)) return null;
  const entries = await Promise.all(Object.entries(FIXATION).map(async ([name, code]) => {
    const csv = await text(`${ECB}/M.${cc}.B.A2C.${code}.R.A.2250.EUR.N?lastNObservations=13&format=csvdata&detail=dataonly`);
    const rows = (csv ?? '').trim().split('\n').slice(1).map((l) => l.split(','));
    // dataonly CSV: KEY, dims…, TIME_PERIOD, OBS_VALUE as the last two columns
    const obs = rows.map((r) => ({ period: r[r.length - 2]!, rate: Number(r[r.length - 1]) })).filter((o) => Number.isFinite(o.rate));
    const last = obs.at(-1);
    return [name, last ? { period: last.period, rate: last.rate, year_ago: obs.length >= 13 ? obs[obs.length - 13]!.rate : null } : null] as const;
  }));
  if (entries.every(([, v]) => v == null)) return null;
  return {
    country: cc,
    source: 'ECB MFI interest rate statistics (MIR), new house-purchase loans to households, annualised agreed rate',
    rates: Object.fromEntries(entries) as never,
  };
}

async function eurostatSeries(dataset: string, params: Record<string, string>, periods: number) {
  const q = new URLSearchParams({ ...params, lastTimePeriod: String(periods), format: 'JSON' });
  const raw = await text(`${EUROSTAT}/${dataset}?${q}`);
  if (!raw) return [];
  try {
    const d = JSON.parse(raw);
    const idx: Record<string, number> = d.dimension?.time?.category?.index ?? {};
    return Object.entries(idx)
      .map(([period, i]) => ({ period, value: d.value?.[String(i)] as number | undefined }))
      .filter((o): o is { period: string; value: number } => typeof o.value === 'number')
      .sort((a, b) => a.period.localeCompare(b.period));
  } catch {
    return [];
  }
}

/** House prices (total, existing and new dwellings) and rents: annual change in percent. */
export async function housingMarket(country: string) {
  const geo = country.toUpperCase() === 'GR' ? 'EL' : country.toUpperCase();
  const [all, existing, fresh, rents] = await Promise.all([
    eurostatSeries('prc_hpi_q', { geo, purchase: 'TOTAL', unit: 'RCH_A' }, 8),
    eurostatSeries('prc_hpi_q', { geo, purchase: 'DW_EXST', unit: 'RCH_A' }, 4),
    eurostatSeries('prc_hpi_q', { geo, purchase: 'DW_NEW', unit: 'RCH_A' }, 4),
    eurostatSeries('prc_hicp_minr', { geo, coicop18: 'CP041', unit: 'RCH_A' }, 6),
  ]);
  if (!all.length && !rents.length) return null;
  return {
    country: geo,
    house_prices_yoy_pct: all,
    existing_dwellings_yoy_pct: existing.at(-1) ?? null,
    new_dwellings_yoy_pct: fresh.at(-1) ?? null,
    rents_yoy_pct: rents,
    source: 'Eurostat prc_hpi_q (house price index) and prc_hicp_minr CP041 (actual rentals for housing)',
    note: 'National figures. City and per-m² levels differ widely: get those from local rent indices (e.g. a municipal Mietspiegel) or listing portals, with a date and source.',
  };
}
