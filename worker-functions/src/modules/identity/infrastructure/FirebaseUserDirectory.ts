/**
 * Perfil (nome/e-mail) de logins no Firebase Auth — a fonte das linhas `account` (só Firebase) da aba "Vínculos de área".
 * `getUsers` em lote (teto do Firebase: 100 por chamada) e `getUserByEmail`. Qualquer falha vira `FirebaseLookupError`,
 * cuja mensagem NUNCA carrega o e-mail pedido; nada aqui loga.
 */
import * as admin from 'firebase-admin';
import { FirebaseLookupError, type FirebaseProfile, type FirebaseUserLookup } from '../application/AreaPeople';

const FIREBASE_BATCH = 100;

const toProfile = (u: { uid: string; displayName?: string; email?: string }): FirebaseProfile => ({
  uid: u.uid,
  displayName: u.displayName ?? null,
  email: u.email ?? null,
});

export class FirebaseUserDirectory implements FirebaseUserLookup {
  async getUsers(uids: string[]): Promise<Map<string, FirebaseProfile>> {
    const found = new Map<string, FirebaseProfile>();
    try {
      for (let i = 0; i < uids.length; i += FIREBASE_BATCH) {
        const batch = uids.slice(i, i + FIREBASE_BATCH).map((uid) => ({ uid }));
        const result = await admin.auth().getUsers(batch);
        for (const u of result.users) found.set(u.uid, toProfile(u));
      }
    } catch {
      throw new FirebaseLookupError();
    }
    return found;
  }

  async getByEmail(email: string): Promise<FirebaseProfile | null> {
    try {
      return toProfile(await admin.auth().getUserByEmail(email));
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'auth/user-not-found') return null;
      throw new FirebaseLookupError();
    }
  }
}
