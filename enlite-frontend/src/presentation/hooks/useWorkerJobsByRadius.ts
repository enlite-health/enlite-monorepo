import { useEffect, useState } from 'react';
import type { MissingProfileItem, WorkerJobsByRadius } from '@domain/entities/WorkerJobByRadius';
import { WorkerJobsByRadiusApiService, WorkerJobsByRadiusError } from '@infrastructure/http/WorkerJobsByRadiusApiService';

export type WorkerJobsByRadiusState =
  /** Sem usuário (desabilitado): a home segue como sempre. */
  | { status: 'idle' }
  | { status: 'loading' }
  /** Cadastro completo: mapa + vagas do raio. `data.center` existe. */
  | { status: 'ok'; data: WorkerJobsByRadius & { center: { lat: number; lng: number } } }
  /** Faltam itens do cadastro (decisão 19/11): a home mostra o aviso, nunca mapa nem vagas. */
  | { status: 'incomplete'; missing: MissingProfileItem[] }
  | { status: 'inactive' }
  | { status: 'error' };

/** Uma chamada (`radius_km=100&view=home`) quando `enabled`; o slider filtra no cliente (096 DD-3). `attempt` sobe a cada
 *  "Reintentar": refaz a chamada e volta a 'loading'. */
export function useWorkerJobsByRadius(enabled: boolean, attempt = 0): WorkerJobsByRadiusState {
  const [state, setState] = useState<WorkerJobsByRadiusState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: 'loading' });
    WorkerJobsByRadiusApiService.getHome()
      .then((data) => {
        if (cancelled) return;
        if (data.missing.length > 0 || !data.center) {
          setState({ status: 'incomplete', missing: data.missing.length > 0 ? data.missing : ['address'] });
        } else {
          setState({ status: 'ok', data: { ...data, center: data.center } });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 409 só existe na rota SEM `view`; se vier, é "sem endereço".
        if (err instanceof WorkerJobsByRadiusError && err.code === 'NO_SERVICE_AREA') setState({ status: 'incomplete', missing: ['address'] });
        else if (err instanceof WorkerJobsByRadiusError && err.code === 'ACCOUNT_INACTIVE') setState({ status: 'inactive' });
        else setState({ status: 'error' });
      });
    return () => { cancelled = true; };
  }, [enabled, attempt]);

  return enabled ? state : { status: 'idle' };
}
