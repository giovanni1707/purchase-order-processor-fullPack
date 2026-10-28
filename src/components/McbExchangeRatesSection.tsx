import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import {
  fetchMcbExchangeRates,
  formatExchangeRate,
  formatLastRefreshed,
  type McbExchangeRatesData,
} from '../services/mcbExchangeRates';

export interface McbExchangeRatesSectionProps {
  /** Optional custom fetch implementation for unit/integration testing */
  fetchImpl?: typeof fetch;
}

export default function McbExchangeRatesSection({ fetchImpl }: McbExchangeRatesSectionProps) {
  const [data, setData] = useState<McbExchangeRatesData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const mountedRef = useRef<boolean>(true);
  const requestIdRef = useRef<number>(0);

  const loadRates = useCallback(async () => {
    const currentReq = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await fetchMcbExchangeRates(fetchImpl);
      if (!mountedRef.current || currentReq !== requestIdRef.current) return;
      setData(result);
      setError('');
    } catch (err: any) {
      if (!mountedRef.current || currentReq !== requestIdRef.current) return;
      setError(
        err?.message ||
          'Unable to retrieve the latest MCB exchange rates right now. Please try refreshing.',
      );
    } finally {
      if (mountedRef.current && currentReq === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [fetchImpl]);

  useEffect(() => {
    mountedRef.current = true;
    loadRates();
    return () => {
      mountedRef.current = false;
    };
  }, [loadRates]);

  return (
    <section
      aria-labelledby="mcb-exchange-rates-heading"
      data-testid="mcb-exchange-rates-section"
      className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="mcb-exchange-rates-heading" className="text-sm font-semibold text-slate-900">
            MCB Exchange Rates
          </h2>
          <p className="text-xs text-slate-500">
            {data?.source ? `${data.source} · Selling rates (MUR)` : 'MCB Mauritius · Selling rates (MUR)'}
          </p>
        </div>

        <button
          type="button"
          onClick={loadRates}
          disabled={loading}
          aria-label="Refresh MCB exchange rates"
          data-testid="mcb-refresh-button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />
              <span>Refreshing…</span>
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5 text-slate-500" />
              <span>Refresh</span>
            </>
          )}
        </button>
      </div>

      {/* Loading state when no rates have been loaded yet */}
      {loading && !data && (
        <div
          data-testid="mcb-loading-indicator"
          className="mt-3 flex items-center gap-2 rounded-lg border border-slate-200/80 bg-white px-3.5 py-4 text-xs text-slate-600"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500" />
          <span>Fetching latest MCB EUR and ZAR selling rates…</span>
        </div>
      )}

      {/* Error state when initial fetch fails and no cached data exists */}
      {!loading && error && !data && (
        <div
          role="alert"
          data-testid="mcb-error-message"
          className="mt-3 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <div className="space-y-0.5">
            <div className="font-medium text-red-800">Could not load MCB exchange rates</div>
            <div>{error}</div>
          </div>
        </div>
      )}

      {/* Refresh failure warning when retaining previously fetched rates */}
      {error && data && (
        <div
          role="alert"
          data-testid="mcb-refresh-error-banner"
          className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <span className="font-medium">Refresh failed:</span> {error} Showing the last successfully retrieved rates below.
          </div>
        </div>
      )}

      {/* Currency cards and publication/refresh metadata */}
      {data && (
        <>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* EUR Card */}
            <div
              data-testid="mcb-card-eur"
              data-raw-rate={String(data.eurSellingRate)}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-2xs"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-base font-semibold text-slate-800">
                  €
                </div>
                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-sm font-semibold text-slate-900">EUR</span>
                    <span className="text-xs text-slate-400" aria-hidden="true">·</span>
                    <span className="text-xs text-slate-500">Euro</span>
                  </div>
                  <div className="text-[11px] text-slate-500">Selling rate (1 € in MUR)</div>
                </div>
              </div>
              <div className="text-right">
                <div
                  data-testid="mcb-rate-eur"
                  className="font-mono text-lg font-semibold tracking-tight text-slate-900 tabular-nums"
                >
                  {formatExchangeRate(data.eurSellingRate)}
                </div>
                <div className="text-[11px] font-medium text-slate-500">MUR</div>
              </div>
            </div>

            {/* ZAR Card */}
            <div
              data-testid="mcb-card-zar"
              data-raw-rate={String(data.zarSellingRate)}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-2xs"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-base font-semibold text-slate-800">
                  R
                </div>
                <div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-sm font-semibold text-slate-900">ZAR</span>
                    <span className="text-xs text-slate-400" aria-hidden="true">·</span>
                    <span className="text-xs text-slate-500">South African Rand</span>
                  </div>
                  <div className="text-[11px] text-slate-500">Selling rate (1 R in MUR)</div>
                </div>
              </div>
              <div className="text-right">
                <div
                  data-testid="mcb-rate-zar"
                  className="font-mono text-lg font-semibold tracking-tight text-slate-900 tabular-nums"
                >
                  {formatExchangeRate(data.zarSellingRate)}
                </div>
                <div className="text-[11px] font-medium text-slate-500">MUR</div>
              </div>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-500">
            <div>
              <span className="font-medium text-slate-700">MCB Rate Date:</span>{' '}
              <span data-testid="mcb-rate-date">{data.rateDate}</span>
            </div>
            <div>
              <span className="font-medium text-slate-700">Last refreshed:</span>{' '}
              <span data-testid="mcb-last-refreshed">{formatLastRefreshed(data.lastRefreshedAt)}</span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
