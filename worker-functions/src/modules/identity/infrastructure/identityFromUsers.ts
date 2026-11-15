/**
 * Fallback de identidade do login: `users` por uid OU e-mail, só conta ativa. UM dono (D514) para o portão
 * (`FirebaseAuthStrategy`) e para o recálculo do claim `areas` (`PgLoginDirectory`) — as duas leituras não podem divergir.
 * `users` só tem staff (D294): quem não está lá não é staff. Erro de banco → `null` (fail-closed: não vira staff).
 *
 * O casamento por E-MAIL só vale com `emailVerified === true` vindo do Firebase (token verificado ou `getUser`):
 * qualquer um cria conta com o e-mail de um staff sem provar que é dono dele, e herdaria o papel. Sem verificação,
 * só o uid casa (fail-closed). O uid não é forjável — é o Firebase quem o emite.
 */
import type { Pool } from 'pg';

export interface UserIdentity {
  role: string | null;
  account_type: string | null;
}

export async function identityFromUsers(
  db: Pick<Pool, 'query'>,
  uid: string,
  email?: string,
  emailVerified?: boolean,
): Promise<UserIdentity | null> {
  const verifiedEmail = emailVerified === true && email ? email : null;
  try {
    const result = await db.query<UserIdentity>(
      'SELECT role, account_type FROM users WHERE (firebase_uid = $1 OR email = $2) AND is_active = true LIMIT 1',
      [uid, verifiedEmail],
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  }
}
