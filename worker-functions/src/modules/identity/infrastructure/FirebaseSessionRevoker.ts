import * as admin from 'firebase-admin';
import type { SessionRevoker } from '../ports/WorkerDeviceRepository';

/** Derruba as sessões do login (mesma chamada do `areasClaim.ts`). Não toca no estado da conta: só os refresh tokens. */
export class FirebaseSessionRevoker implements SessionRevoker {
  async revokeRefreshTokens(uid: string): Promise<void> {
    await admin.auth().revokeRefreshTokens(uid);
  }
}
