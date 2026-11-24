import type { ActiveWorkerDevice } from '../domain/WorkerDevice';

export interface RegisterDeviceRecord {
  workerId: string;
  installationId: string;
  publicKey: string;
  /** Já CIFRADO (nunca o token em claro); `null` = o app não informou token. */
  fcmTokenEnc: string | null;
}

export interface RevokedDeviceView {
  deviceId: string;
  /** Ciphertext do token (decifrado só na hora do push); `null` = sem token. */
  fcmTokenEnc: string | null;
}

/** Porta de persistência de `worker_devices`. A regra "um ativo por cuidadora" mora no banco; aqui só se a usa. */
export interface WorkerDeviceRepository {
  /** UMA transação: revoga o ativo anterior (motivo `substituido`) e insere o novo ativo. */
  registerReplacingActive(record: RegisterDeviceRecord): Promise<{ deviceId: string; replacedDeviceId: string | null }>;
  findActive(workerId: string): Promise<ActiveWorkerDevice | null>;
  /** Marca o ativo como revogado por operador. `null` = não havia aparelho ativo. */
  revokeActive(workerId: string, operatorUid: string): Promise<RevokedDeviceView | null>;
  /** Grava `wiped_at` uma só vez. `false` = aparelho desconhecido ou já confirmado. */
  confirmWipe(workerId: string, installationId: string): Promise<boolean>;
  /** `workers.auth_uid` (uid do Firebase) da cuidadora; `null` = ficha inexistente. */
  findAuthUid(workerId: string): Promise<string | null>;
}

/** Revogação de sessão do Firebase (molde: `areasClaim.ts`). */
export interface SessionRevoker {
  revokeRefreshTokens(uid: string): Promise<void>;
}

/** Cifra do token FCM (KMS). Nunca devolve nem registra o token em claro fora do envio. */
export interface TokenCipher {
  encrypt(plain: string): Promise<string | null>;
  decrypt(cipher: string): Promise<string>;
}
