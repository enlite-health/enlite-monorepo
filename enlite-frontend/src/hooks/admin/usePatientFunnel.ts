import { useEffect, useState } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientFunnelData } from '@domain/entities/PatientDetail';

/**
 * Fase 4 — funnel/traceability metrics for the patients page.
 * Fetches GET /api/admin/patients/funnel scoped by country and a relative date
 * window (`periodDays` back from now; default 30). Refetches on either change.
 */
export function usePatientFunnel(country: string, periodDays: number) {
  const [funnel, setFunnel] = useState<PatientFunnelData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);
        const to = new Date();
        const from = new Date(to.getTime() - periodDays * 24 * 60 * 60 * 1000);
        const data = await AdminApiService.getPatientFunnel({
          country: country || undefined,
          from: from.toISOString(),
          to: to.toISOString(),
        });
        if (!cancelled) setFunnel(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load funnel');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [country, periodDays]);

  return { funnel, isLoading, error };
}
