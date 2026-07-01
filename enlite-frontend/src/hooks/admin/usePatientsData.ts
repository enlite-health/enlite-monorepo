import { useState, useEffect, useCallback } from 'react';
import { AdminPatientsApiService, PatientStats } from '@infrastructure/http/AdminPatientsApiService';

export interface UsePatientsDataFilters {
  search?: string;
  needs_attention?: string;
  attention_reason?: string;
  clinical_specialty?: string;
  dependency_level?: string;
  case_number?: string;
  limit?: string;
  offset?: string;
}

const STATS_FALLBACK: PatientStats = {
  total: 0,
  complete: 0,
  needsAttention: 0,
  createdToday: 0,
  createdYesterday: 0,
  createdLast7Days: 0,
};

export function usePatientsData(filters?: UsePatientsDataFilters) {
  const [patients, setPatients] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<PatientStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    async function fetchData(): Promise<void> {
      try {
        setIsLoading(true);
        setError(null);

        const [patientsResult, statsResult] = await Promise.all([
          AdminPatientsApiService.listPatients(filters),
          AdminPatientsApiService.getPatientStats().catch(() => STATS_FALLBACK),
        ]);

        setPatients(patientsResult.data ?? []);
        setTotal(patientsResult.total ?? 0);
        setStats(statsResult);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch patients');
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters?.search,
    filters?.needs_attention,
    filters?.attention_reason,
    filters?.clinical_specialty,
    filters?.dependency_level,
    filters?.case_number,
    filters?.limit,
    filters?.offset,
    refreshKey,
  ]);

  return { patients, total, stats, isLoading, error, refetch };
}
