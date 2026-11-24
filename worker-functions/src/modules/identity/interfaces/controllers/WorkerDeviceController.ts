import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { principalUid } from '../middleware/PermissionMiddleware';
import { ConfirmWipe as ConfirmWipeUseCase } from '../../application/ConfirmWipe';
import { GetDevice as GetDeviceUseCase } from '../../application/GetDevice';
import { RegisterDevice as RegisterDeviceUseCase } from '../../application/RegisterDevice';
import { RevokeDevice as RevokeDeviceUseCase } from '../../application/RevokeDevice';
import { PgWorkerDeviceRepository } from '../../infrastructure/PgWorkerDeviceRepository';
import { FirebaseSessionRevoker } from '../../infrastructure/FirebaseSessionRevoker';
import { KmsTokenCipher } from '../../infrastructure/KmsTokenCipher';
import { FcmPushSender } from '../../infrastructure/FcmPushSender';

const registerBody = z.object({
  installationId: z.string(),
  publicKey: z.string(),
  fcmToken: z.string().nullish(),
});
const wipedBody = z.object({ installationId: z.string() });

const STATUS: Record<string, number> = {
  INVALID_WORKER_ID: 400,
  INVALID_INSTALLATION_ID: 400,
  INVALID_PUBLIC_KEY: 400,
  INVALID_FCM_TOKEN: 400,
  OPERATOR_REQUIRED: 401,
  NO_ACTIVE_DEVICE: 404,
  DEVICE_CONFLICT: 409,
};

export interface WorkerDeviceHandlers {
  register: RegisterDeviceUseCase;
  get: GetDeviceUseCase;
  revoke: RevokeDeviceUseCase;
  confirmWipe: ConfirmWipeUseCase;
}

/**
 * Handlers HTTP dos 4 casos de uso. Nunca devolve o token FCM. Log só com o NOME do código de erro (corpo, chave pública,
 * id da instalação e token são dado pessoal e não entram em log).
 */
export class WorkerDeviceController {
  constructor(private readonly uc: WorkerDeviceHandlers) {}

  /** Composição de produção: banco, KMS (token cifrado), Firebase Auth (sessões) e FCM (push de dados). */
  static fromPool(pool: Pool): WorkerDeviceController {
    const devices = new PgWorkerDeviceRepository(pool);
    const cipher = new KmsTokenCipher();
    return new WorkerDeviceController({
      register: new RegisterDeviceUseCase(devices, cipher),
      get: new GetDeviceUseCase(devices),
      revoke: new RevokeDeviceUseCase(devices, new FirebaseSessionRevoker(), new FcmPushSender(), cipher),
      confirmWipe: new ConfirmWipeUseCase(devices),
    });
  }

  private fail(res: Response, error: string, what: string): void {
    const status = STATUS[error] ?? 500;
    if (status === 500) logger.error({ code: error }, `[worker-device] falha em ${what}`);
    res.status(status).json({ success: false, error });
  }

  async register(req: Request, res: Response): Promise<void> {
    const body = registerBody.safeParse(req.body);
    if (!body.success) return this.fail(res, 'INVALID_INSTALLATION_ID', 'register');
    const result = await this.uc.register.execute({ workerId: String(req.params.workerId ?? ''), ...body.data });
    if (result.isFailure) return this.fail(res, result.error as string, 'register');
    res.status(201).json({ success: true, data: result.getValue() });
  }

  async get(req: Request, res: Response): Promise<void> {
    const result = await this.uc.get.execute({ workerId: String(req.params.workerId ?? '') });
    if (result.isFailure) return this.fail(res, result.error as string, 'get');
    res.json({ success: true, data: result.getValue() });
  }

  async revoke(req: Request, res: Response): Promise<void> {
    const result = await this.uc.revoke.execute({
      workerId: String(req.params.workerId ?? ''),
      operatorUid: principalUid(req) ?? '',
    });
    if (result.isFailure) return this.fail(res, result.error as string, 'revoke');
    res.json({ success: true, data: result.getValue() });
  }

  async confirmWipe(req: Request, res: Response): Promise<void> {
    const body = wipedBody.safeParse(req.body);
    if (!body.success) return this.fail(res, 'INVALID_INSTALLATION_ID', 'wiped');
    const result = await this.uc.confirmWipe.execute({ workerId: String(req.params.workerId ?? ''), installationId: body.data.installationId });
    if (result.isFailure) return this.fail(res, result.error as string, 'wiped');
    res.json({ success: true, data: result.getValue() });
  }
}
