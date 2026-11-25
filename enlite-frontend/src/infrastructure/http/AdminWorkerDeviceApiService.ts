/**
 * AdminWorkerDeviceApiService — "Celular perdido" na ficha da cuidadora (spec 077, D795). Duas rotas de
 * `workerDeviceRoutes.ts` (worker-functions), ambas com a célula `worker_device:revoke`. Auth, base URL, envelope
 * `{success,data}` e `ApiError` são os do cliente da Admissão (`requestJson`), como `AdminEnquadreApiService`.
 * Nada aqui loga corpo nem dado pessoal.
 */
import type { WorkerDeviceRevokeResult, WorkerDeviceStatus } from '@domain/entities/WorkerDevice';
import { AdminAdmissionApiService } from './AdminAdmissionApiService';

const base = (workerId: string): string => `/api/admin/workers/${encodeURIComponent(workerId)}/device`;

export class AdminWorkerDeviceApiService {
  /** `GET .../device/status` — o estado como o servidor o conhece. */
  static async getStatus(workerId: string): Promise<WorkerDeviceStatus> {
    return AdminAdmissionApiService.requestJson<WorkerDeviceStatus>('GET', `${base(workerId)}/status`);
  }

  /** `POST .../device/revoke` — revoga o aparelho ativo e manda a ordem de apagar. NÃO desativa a conta. Sem retry. */
  static async revoke(workerId: string): Promise<WorkerDeviceRevokeResult> {
    return AdminAdmissionApiService.requestJson<WorkerDeviceRevokeResult>('POST', `${base(workerId)}/revoke`);
  }
}
