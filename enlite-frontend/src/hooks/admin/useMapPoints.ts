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

  /**
   * A virada DESLIGADO → LIGADO entra em `isLoading` na hora, no render, e não
   * só quando o effect roda. Sem isto existe um render em que `enabled` já é
   * true, o effect ainda não disparou, e o estado é `{ points: [], isLoading:
   * false }` — que a tela lê como "0 en 5 km · Nadie en este radio". É a
   * afirmação mais forte que a tela pode fazer, feita antes de existir uma
   * pergunta. Com o portão da âncora isso deixou de ser teórico: TODO hook
   * nasce desligado e liga quando alguém escolhe a âncora.
   *
   * Só na VIRADA — mudança de filtro com o hook já ligado continua guardando os
   * pontos antigos de propósito, que é o que sustenta o "Buscando…" por cima da
   * lista em vez de uma tela que pisca vazia.
   */
  const [wasEnabled, setWasEnabled] = useState(enabled);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    // Ao RELIGAR: só apaga os pontos se a pergunta mudou. Apagar sempre parecia
    // seguro e não era — o seletor da âncora desliga ao trocar de aba e religa
    // ao voltar, com o MESMO escopo; zerar ali esvaziava a lista de opções e o
    // `SearchableSelect`, sem achar o valor selecionado, voltava ao placeholder:
    // a âncora continuava ativa e a tela dizia que não havia nenhuma.
    if (enabled) {
      setState((s) => (loadedKey === key
        ? { ...s, isLoading: true, error: null }
        : { ...EMPTY, isLoading: true, error: null }));
    }
  }

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
        setLoadedKey(key);
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
