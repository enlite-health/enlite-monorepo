import type { DeviceOrder } from '../domain/WorkerDevice';

export interface DevicePushMessage {
  /** Token FCM em claro, só para o envio; nunca vai a log. */
  token: string;
  order: DeviceOrder;
  /** Id OPACO do aparelho (uuid de `worker_devices.id`). Nenhum nome, telefone ou texto clínico. */
  deviceId: string;
}

/** Porta de envio de push. Só DADOS, prioridade alta, sem PII. */
export interface PushSender {
  /** `true` = aceito pelo FCM; `false` = recusado/falhou (a ordem ainda vale na próxima chamada, `DEVICE_REVOKED`). */
  send(message: DevicePushMessage): Promise<boolean>;
}
