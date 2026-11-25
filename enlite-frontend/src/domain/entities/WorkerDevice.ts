/**
 * Aparelho da cuidadora, como o painel o vê ("Celular perdido", spec 077, D795).
 * Contrato de `GET /api/admin/workers/:workerId/device/status` (worker-functions, `WorkerDeviceController.status`).
 *
 * O dono do estado é o SERVIDOR (`worker_devices`): o painel só exibe, nunca deriva.
 *  · `wipedAt` null = o servidor não ouviu o aparelho desde o pedido — NÃO quer dizer que não apagou.
 *  · `wipedAt` preenchido = o próprio app informou que apagou (o app pode mentir se adulterado: nunca "confirmado").
 *  · `requestedByName` = nome de quem pediu, resolvido no servidor; o uid do operador nunca chega aqui.
 */
export interface OperatorRevocation {
  revokedAt: string;
  wipedAt: string | null;
  requestedByName: string | null;
}

export interface WorkerDeviceStatus {
  hasActiveDevice: boolean;
  lastOperatorRevocation: OperatorRevocation | null;
}

/** Resposta do POST revoke. `pushSent` vale SÓ para o retorno do clique: não é guardado nem reconstruído depois. */
export interface WorkerDeviceRevokeResult {
  deviceId: string;
  sessionsRevoked: boolean;
  pushSent: boolean;
}
