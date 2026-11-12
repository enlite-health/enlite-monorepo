import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { MatchResultsResponse } from '../../types/match';

/** Raio e teto da página "Invitar prestadores" (spec 089, emenda 06/11: 500). */
export const INVITE_RADIUS_KM = 50;
export const INVITE_TOP_N = 500;
export const INVITE_LIMIT = 500;

export type InviteBoardStatus = 'idle' | 'loading' | 'ready' | 'noService' | 'error';

interface Loaded {
  status: 'ready' | 'noService';
  results: MatchResultsResponse;
  /** ids do POST desta abertura (resultado do match); vazio sem `match:execute`. */
  currentIds: ReadonlySet<string>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Uma carga (DF-9, DF-11). Com `match:execute`: GET meta (limit=0) → se o serviço não tem coordenada
 * PARA (o POST sem centro gravaria INVITED para todo o perfil) → POST (1×) → GET (500).
 * A coordenada do serviço só existe no GET (a vacante não a traz, F23); por isso o meta vem antes.
 * Sem `match:execute`: só o GET, sem POST.
 */
async function loadBoard(vacancyId: string, canExecute: boolean): Promise<Loaded> {
  if (!canExecute) {
    const results = await AdminApiService.getMatchResults(vacancyId, INVITE_LIMIT);
    return { status: 'ready', results, currentIds: EMPTY_IDS };
  }
  const meta = await AdminApiService.getMatchResults(vacancyId, 0);
  if (meta.service?.lat == null || meta.service?.lng == null) {
    return { status: 'noService', results: meta, currentIds: EMPTY_IDS };
  }
  const fresh = await AdminApiService.triggerMatch(vacancyId, { radiusKm: INVITE_RADIUS_KM, topN: INVITE_TOP_N });
  const results = await AdminApiService.getMatchResults(vacancyId, INVITE_LIMIT);
  return { status: 'ready', results, currentIds: new Set(fresh.candidates.map((c) => c.workerId)) };
}

interface Options {
  /** Só carrega com vacante conhecida, não rascunho, não dada de baja e com `match:read`. */
  enabled: boolean;
  /** `match:execute` e vacante viva: autoriza o POST. */
  canExecute: boolean;
}

/**
 * Dado da página "Invitar prestadores". Trocar de passo, ligar o interruptor ou voltar de um envio
 * NÃO roda nada aqui: só `refetch` (1 GET, DF-18 c) relê o servidor; `reload` refaz a carga inteira
 * (ação explícita depois de erro).
 */
export function useVacancyInviteBoard(vacancyId: string | undefined, { enabled, canExecute }: Options) {
  const [status, setStatus] = useState<InviteBoardStatus>('idle');
  const [results, setResults] = useState<MatchResultsResponse | null>(null);
  const [currentIds, setCurrentIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Uma carga por (vacante, permissão, tentativa): o remount do StrictMode reaproveita a promessa
  // em vez de disparar um segundo POST.
  const inflight = useRef<{ key: string; promise: Promise<Loaded> } | null>(null);

  useEffect(() => {
    if (!enabled || !vacancyId) return;
    const key = `${vacancyId}|${canExecute}|${attempt}`;
    if (inflight.current?.key !== key) {
      inflight.current = { key, promise: loadBoard(vacancyId, canExecute) };
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    inflight.current.promise.then(
      (loaded) => {
        if (cancelled) return;
        setResults(loaded.results);
        setCurrentIds(loaded.currentIds);
        setStatus(loaded.status);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'error');
        setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, vacancyId, canExecute, attempt]);

  /** Só GET: o que mudou por fora (ou o envio que terminou) volta sem rodar o match de novo. */
  const refetch = useCallback(async (): Promise<void> => {
    if (!vacancyId) return;
    setIsRefreshing(true);
    try {
      setResults(await AdminApiService.getMatchResults(vacancyId, INVITE_LIMIT));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'error');
    } finally {
      setIsRefreshing(false);
    }
  }, [vacancyId]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { status, results, currentIds, error, isRefreshing, refetch, reload };
}
