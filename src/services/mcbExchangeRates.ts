export const MCB_EXCHANGE_RATES_API_URL =
  'https://script.google.com/macros/s/AKfycbybWiLhqKoABhYBN_ahWdHugnm5Vm04bKN7Wrs8U-3UhKHN1jdaenisX3NrfpTtbhi-RQ/exec';

export interface McbExchangeRatesData {
  /** Exact numeric EUR selling rate received from the API (preserved for calculations) */
  eurSellingRate: number;
  /** Exact numeric ZAR selling rate received from the API (preserved for calculations) */
  zarSellingRate: number;
  /** Official MCB exchange-rate publication date from the API (`rateDate`) */
  rateDate: string;
  /** Data source returned by the API (`source`) */
  source: string;
  /** Timestamp when the application last successfully retrieved the rates */
  lastRefreshedAt: Date;
}

function parsePositiveRate(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Formats a numeric exchange rate consistently to two decimal places for display,
 * while callers retain the underlying numeric value for calculations.
 */
export function formatExchangeRate(rate: number): string {
  return rate.toFixed(2);
}

/**
 * Formats the local retrieval timestamp in the application's local time zone.
 */
export function formatLastRefreshed(date: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * Validates and extracts EUR and ZAR selling rates, `rateDate`, and `source` from the API payload.
 * Throws an error if required fields are missing or invalid.
 */
export function parseMcbExchangeRatesResponse(
  payload: unknown,
  fetchedAt: Date = new Date(),
): McbExchangeRatesData {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid response received from the MCB exchange rate service.');
  }

  const raw = payload as Record<string, any>;
  if (raw.success === false) {
    const msg =
      typeof raw.error === 'string' && raw.error.trim()
        ? raw.error.trim()
        : 'The MCB exchange rate service reported an error.';
    throw new Error(msg);
  }

  const rates = raw.rates;
  if (!rates || typeof rates !== 'object') {
    throw new Error('Exchange rate data is missing from the API response.');
  }

  const eurSellingRate = parsePositiveRate(rates.EUR?.sellingRate);
  const zarSellingRate = parsePositiveRate(rates.ZAR?.sellingRate);

  if (eurSellingRate === null || zarSellingRate === null) {
    throw new Error('EUR or ZAR selling rate is missing or invalid in the API response.');
  }

  const rateDate = typeof raw.rateDate === 'string' ? raw.rateDate.trim() : '';
  if (!rateDate) {
    throw new Error('Official MCB rate publication date (rateDate) is missing from the API response.');
  }

  const source =
    typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'MCB Mauritius';

  return {
    eurSellingRate,
    zarSellingRate,
    rateDate,
    source,
    lastRefreshedAt: fetchedAt,
  };
}

/**
 * Fetches the latest MCB Mauritius selling exchange rates for EUR and ZAR from the Google Apps Script Web API.
 */
export async function fetchMcbExchangeRates(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<McbExchangeRatesData> {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Network fetch is not available in this environment.');
  }

  let response: Response;
  try {
    response = await fetchImpl(MCB_EXCHANGE_RATES_API_URL);
  } catch {
    throw new Error(
      'Unable to connect to the MCB exchange rate service. Please check your internet connection and try again.',
    );
  }

  if (!response || !response.ok) {
    const statusText = response ? ` (HTTP ${response.status})` : '';
    throw new Error(`Could not retrieve MCB exchange rates${statusText}. Please try refreshing.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Received an unreadable response from the MCB exchange rate service.');
  }

  return parseMcbExchangeRatesResponse(payload, new Date());
}
