import { Result } from '@shared/utils/Result';
import {
  isInstallationId,
  isUuid,
  MAX_FCM_TOKEN_LENGTH,
  MAX_PUBLIC_KEY_LENGTH,
} from '../domain/WorkerDevice';
import type { TokenCipher, WorkerDeviceRepository } from '../ports/WorkerDeviceRepository';

export interface RegisterDeviceInput {
  workerId: string;
  installationId: string;
  publicKey: string;
  fcmToken?: string | null;
}

/**
 * Liga o aparelho novo e DESLIGA o anterior na mesma transação (G-3: um ativo por cuidadora; G-8: o antigo perde o que
 * estava sem enviar, aceito). A regra do "um só" é do índice único parcial; aqui só se monta a transação.
 */
export class RegisterDevice {
  constructor(
    private readonly devices: WorkerDeviceRepository,
    private readonly cipher: TokenCipher,
  ) {}

  async execute(input: RegisterDeviceInput): Promise<Result<{ deviceId: string }>> {
    if (!isUuid(input.workerId)) return Result.fail('INVALID_WORKER_ID');
    if (!isInstallationId(input.installationId)) return Result.fail('INVALID_INSTALLATION_ID');
    if (typeof input.publicKey !== 'string' || input.publicKey.length === 0 || input.publicKey.length > MAX_PUBLIC_KEY_LENGTH) {
      return Result.fail('INVALID_PUBLIC_KEY');
    }
    const token = input.fcmToken ?? null;
    if (token !== null && (typeof token !== 'string' || token.length === 0 || token.length > MAX_FCM_TOKEN_LENGTH)) {
      return Result.fail('INVALID_FCM_TOKEN');
    }
    try {
      const fcmTokenEnc = token === null ? null : await this.cipher.encrypt(token);
      const { deviceId } = await this.devices.registerReplacingActive({
        workerId: input.workerId,
        installationId: input.installationId,
        publicKey: input.publicKey,
        fcmTokenEnc,
      });
      return Result.ok({ deviceId });
    } catch (error) {
      // 23505 aqui = outro registro da mesma cuidadora ganhou a corrida; o app repete. Sem mensagem do driver (pode ecoar valor).
      const code = (error as { code?: string }).code;
      return Result.fail(code === '23505' ? 'DEVICE_CONFLICT' : 'REGISTER_DEVICE_FAILED');
    }
  }
}
