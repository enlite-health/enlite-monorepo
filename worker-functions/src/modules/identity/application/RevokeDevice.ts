import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { isUuid, WIPE_ORDER } from '../domain/WorkerDevice';
import type { PushSender } from '../ports/PushSender';
import type { SessionRevoker, TokenCipher, WorkerDeviceRepository } from '../ports/WorkerDeviceRepository';

export interface RevokeDeviceResult {
  deviceId: string;
  /** Sessão do Firebase derrubada? `false` = falhou (o aparelho já está revogado; o `DEVICE_REVOKED` vale na próxima chamada). */
  sessionsRevoked: boolean;
  /** Push aceito pelo FCM? `false` = sem token ou recusado (o painel mostra "pendente"). */
  pushSent: boolean;
}

/**
 * "Celular perdido" (D795, G-9): marca o aparelho ativo como revogado, derruba as sessões e manda o push de apagar.
 * NÃO desativa a conta: o administrativo faz isso à parte, pela ação que já existe (`ACCOUNT_INACTIVE`). Este caso de uso
 * não tem porta para mexer em conta — só em `worker_devices`, nas sessões e no push.
 * Quem pode chamar é decidido na rota (célula ABAC `worker_device:revoke`); aqui só se registra QUEM pediu.
 */
export class RevokeDevice {
  constructor(
    private readonly devices: WorkerDeviceRepository,
    private readonly sessions: SessionRevoker,
    private readonly push: PushSender,
    private readonly cipher: TokenCipher,
  ) {}

  async execute(input: { workerId: string; operatorUid: string }): Promise<Result<RevokeDeviceResult>> {
    if (!isUuid(input.workerId)) return Result.fail('INVALID_WORKER_ID');
    if (!input.operatorUid || input.operatorUid.trim().length === 0) return Result.fail('OPERATOR_REQUIRED');

    let revoked: Awaited<ReturnType<WorkerDeviceRepository['revokeActive']>>;
    let uid: string | null;
    try {
      revoked = await this.devices.revokeActive(input.workerId, input.operatorUid);
      if (!revoked) return Result.fail('NO_ACTIVE_DEVICE');
      uid = await this.devices.findAuthUid(input.workerId);
    } catch {
      return Result.fail('REVOKE_DEVICE_FAILED');
    }

    let sessionsRevoked = false;
    if (uid) {
      try {
        await this.sessions.revokeRefreshTokens(uid);
        sessionsRevoked = true;
      } catch (error) {
        logger.error({ errorName: error instanceof Error ? error.name : 'error', deviceId: revoked.deviceId }, '[worker-device] falha ao derrubar as sessões');
      }
    }

    let pushSent = false;
    if (revoked.fcmTokenEnc) {
      try {
        const token = await this.cipher.decrypt(revoked.fcmTokenEnc);
        pushSent = token.length > 0 && (await this.push.send({ token, order: WIPE_ORDER, deviceId: revoked.deviceId }));
      } catch (error) {
        logger.error({ errorName: error instanceof Error ? error.name : 'error', deviceId: revoked.deviceId }, '[worker-device] falha ao enviar o push de apagar');
      }
    }

    return Result.ok({ deviceId: revoked.deviceId, sessionsRevoked, pushSent });
  }
}
