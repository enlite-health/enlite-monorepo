/**
 * Aparelho da cuidadora (spec 077, D795). O dono do conceito "aparelho ativo" é a tabela `worker_devices`
 * (índice único parcial por worker); este arquivo só dá nome aos tipos que atravessam as camadas.
 *
 * `publicKey` e `installationId` são identificadores (dado pessoal, não de saúde): nunca vão a log.
 */
export type WorkerDeviceStatus = 'ativo' | 'revogado';

export interface ActiveWorkerDevice {
  deviceId: string;
  installationId: string;
  publicKey: string;
}

/**
 * O que o painel mostra do aparelho (GET status, "Celular perdido"). Lido do banco, nunca derivado no cliente:
 * `wipedAt` NULL = o servidor não ouviu o aparelho confirmar (NÃO é "não apagou"). Quem pediu sai só como NOME
 * (`users.display_name`, resolvido no servidor): o `firebase_uid` do operador nunca sai da API.
 */
export interface OperatorRevocationView {
  revokedAt: string;
  wipedAt: string | null;
  requestedByName: string | null;
}

export interface WorkerDeviceStatusView {
  hasActiveDevice: boolean;
  /** Última revogação por OPERADOR (`revoked_reason = 'operador'`); a substituição por login em outro celular não entra. */
  lastOperatorRevocation: OperatorRevocationView | null;
}

/** Ordem enviada no push de dados. Única ordem do contrato: apagar tudo, sem tela. */
export const WIPE_ORDER = 'wipe' as const;
export type DeviceOrder = typeof WIPE_ORDER;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PUBLIC_KEY_LENGTH = 2048;
export const MAX_FCM_TOKEN_LENGTH = 4096;

export const isInstallationId = (v: unknown): v is string => typeof v === 'string' && UUID_V4.test(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_ANY.test(v);
