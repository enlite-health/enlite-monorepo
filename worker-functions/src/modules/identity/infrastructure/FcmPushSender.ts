import * as admin from 'firebase-admin';
import { logger } from '@shared/logging';
import type { DevicePushMessage, PushSender } from '../ports/PushSender';

/** O recorte do `admin.messaging()` que este adapter usa (o teste injeta um dublê; nenhum teste toca a rede). */
export interface MessagingLike {
  send(message: {
    token: string;
    data: Record<string, string>;
    android: { priority: 'high' };
  }): Promise<string>;
}

/**
 * Push FCM só de DADOS, prioridade alta, sem PII (spec 077, D795, emenda §2.E.2 e §3):
 *   · `data` = `{ order, deviceId }` — a ordem e o id OPACO do aparelho; nenhum nome, telefone ou texto clínico;
 *   · SEM `notification` (nada aparece na tela do aparelho; o app apaga em silêncio);
 *   · `android.priority = 'high'` (acorda o app em segundo plano).
 * O token FCM nunca vai a log: em falha, só o NOME do erro e o `errorInfo.code` do Firebase (códigos fixos, sem valor).
 * Limite honesto (HIPÓTESE, medir no T-F3c-DB-06): só chega com internet e app não forçado a parar.
 */
export class FcmPushSender implements PushSender {
  constructor(private readonly messaging: () => MessagingLike = () => admin.messaging()) {}

  async send(message: DevicePushMessage): Promise<boolean> {
    try {
      await this.messaging().send({
        token: message.token,
        data: { order: message.order, deviceId: message.deviceId },
        android: { priority: 'high' },
      });
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      logger.warn(
        { errorName: error instanceof Error ? error.name : 'error', fcmCode: typeof code === 'string' ? code : undefined, deviceId: message.deviceId },
        '[worker-device] FCM recusou o push de apagar',
      );
      return false;
    }
  }
}
