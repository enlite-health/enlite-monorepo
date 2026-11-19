import { useEffect, useState } from 'react';
import type { WorkerJobsByRadius } from '@domain/entities/WorkerJobByRadius';
import { WorkerJobsByRadiusApiService, WorkerJobsByRadiusError } from '@infrastructure/http/WorkerJobsByRadiusApiService';

export type WorkerJobsByRadiusState =
  | { status: 'loading' }
  | { status: 'ok'; data: WorkerJobsByRadius }
  | { status: 'no_service_area' }
  | { status: 'inactive' }
  | { status: 'error' };

/** Uma chamada (`radius_km=100&view=home`) quando `enabled`; o slider filtra no cliente (096 DD-3). */
export function useWorkerJobsByRadius(enabled: boolean): WorkerJobsByRadiusState {
  const [state, setState] = useState<WorkerJobsByRadiusState>({ status: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    WorkerJobsByRadiusApiService.getHome()
      .then((data) => { if (!cancelled) setState({ status: 'ok', data }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof WorkerJobsByRadiusError && err.code === 'NO_SERVICE_AREA') setState({ status: 'no_service_area' });
        else if (err instanceof WorkerJobsByRadiusError && err.code === 'ACCOUNT_INACTIVE') setState({ status: 'inactive' });
        else setState({ status: 'error' });
      });
    return () => { cancelled = true; };
  }, [enabled]);

  return state;
}
