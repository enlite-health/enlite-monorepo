/**
 * useEnquadresList — carrega a lista GLOBAL de enquadres (spec 076) para os filtros dados. `status`: `loading` (inclui
 * recargas), `ok`, `error`. Os dados da carga anterior ficam enquanto recarrega (a página mostra esqueleto só na 1ª carga e
 * `aria-busy` depois). Resposta atrasada de um filtro antigo é descartada. Nada daqui vai a log.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import type { EnquadreGlobalList, EnquadreGlobalListParams } from '@domain/entities/EnquadreEvent';

export type EnquadresListStatus = 'loading' | 'ok' | 'error';

export interface UseEnquadresList {
  status: EnquadresListStatus;
  data: EnquadreGlobalList | null;
  /** `code` estável do servidor quando há; `null` em falha sem code (rede). */
  errorCode: string | null;
  reload: () => void;
}

/** `enabled: false` = não chama a API (sem acesso à tela, nada é carregado). */
export function useEnquadresList(params: EnquadreGlobalListParams, enabled = true): UseEnquadresList {
  const [state, setState] = useState<Omit<UseEnquadresList, 'reload'>>({ status: 'loading', data: null, errorCode: null });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const key = JSON.stringify(params);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++latest.current;
    setState((s) => ({ ...s, status: 'loading', errorCode: null }));
    AdminEnquadreApiService.listAll(JSON.parse(key) as EnquadreGlobalListParams).then(
      (data) => { if (mine === latest.current) setState({ status: 'ok', data, errorCode: null }); },
      (err: unknown) => {
        if (mine !== latest.current) return;
        setState((s) => ({ ...s, status: 'error', errorCode: err instanceof ApiError ? err.code ?? null : null }));
      },
    );
  }, [key, tick, enabled]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}
