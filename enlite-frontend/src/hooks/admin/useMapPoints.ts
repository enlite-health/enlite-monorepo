/**
 * useMapPoints — carrega os pontos de UM dos dois mapas (prestadores ou
 * pacientes) a cada mudança de filtro. O filtro é serializado (JSON) para a
 * dependência do effect ser por VALOR, não por identidade do objeto.
 *
 * `enabled=false` NÃO chama a API: a página monta os dois mapas, mas só a
 * aba visível busca — a outra fica vazia e parada até ser aberta (e o
 * seletor "centrar en paciente" só busca depois que alguém o toca).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AdminMapApiService,
  type MapResponse,
  type PatientMapPoint,
  type PatientsMapFilters,
  type WorkerMapPoint,
  type WorkersMapFilters,
} from '@infrastructure/http/AdminMapApiService';

export type MapKind = 'workers' | 'patients';

interface State<P> {
  points: P[];
  total: number;
  withoutCoordinates: number;
  truncated: boolean;
  isLoading: boolean;
  error: string | null;
}

export type MapPointsResult<P> = State<P> & { refetch: () => void };

const EMPTY = { points: [], total: 0, withoutCoordinates: 0, truncated: false };

export function useWorkersMapPoints(filters: WorkersMapFilters, enabled = true): MapPointsResult<WorkerMapPoint> {
  return useMapPoints<WorkerMapPoint>('workers', filters, enabled);
}

export function usePatientsMapPoints(filters: PatientsMapFilters, enabled = true): MapPointsResult<PatientMapPoint> {
  return useMapPoints<PatientMapPoint>('patients', filters, enabled);
}

function useMapPoints<P>(kind: MapKind, filters: WorkersMapFilters | PatientsMapFilters, enabled: boolean): MapPointsResult<P> {
  const [state, setState] = useState<State<P>>({ ...EMPTY, isLoading: enabled, error: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);
  const key = JSON.stringify(filters);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, error: null }));
    const call: Promise<MapResponse<P>> =
      kind === 'workers'
        ? (AdminMapApiService.getWorkersMap(filters as WorkersMapFilters) as Promise<MapResponse<P>>)
        : (AdminMapApiService.getPatientsMap(filters as PatientsMapFilters) as Promise<MapResponse<P>>);
    call
      .then((res) => {
        if (cancelled) return;
        setState({ points: res.data, total: res.total, withoutCoordinates: res.withoutCoordinates, truncated: res.truncated, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load map';
        setState({ ...EMPTY, isLoading: false, error: msg });
      });
    return () => {
      cancelled = true;
    };
    // `key` é o filtro por valor; `filters` muda de identidade a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, key, refreshKey, enabled]);

  return { ...state, refetch };
}
