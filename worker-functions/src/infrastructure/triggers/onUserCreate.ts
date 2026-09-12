import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { mergeCustomClaims } from '@modules/identity/infrastructure/mergeCustomClaims';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { loggingAls, logger, reportError } from '@shared/logging';
import { maskEmailForLog } from '@shared/utils/emailMask';

/**
 * Firebase Auth trigger — sincroniza usuário criado no Firebase com
 * a tabela `users` do Postgres e seta custom claim de role.
 *
 * TD-017: Firebase Functions runtime não usa Express, então o
 * correlationMiddleware não roda. Envolvemos manualmente em loggingAls.run
 * pra que os logs do trigger tenham `traceId` agrupável.
 */
export const onUserCreate = functions.auth.user().onCreate(async (user) => {
  const traceId = uuidv4();

  return loggingAls.run({ traceId }, async () => {
    const log = logger.child({ source: 'firebase-trigger:onUserCreate', firebaseUid: user.uid });
    const db = DatabaseConnection.getInstance();
    const client = await db.getPool().connect();

    try {
      await client.query('BEGIN');

      const defaultRole = 'worker';

      await client.query(`
        INSERT INTO users (firebase_uid, email, display_name, photo_url, role, email_verified)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (firebase_uid) DO UPDATE
        SET email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            photo_url = EXCLUDED.photo_url,
            email_verified = EXCLUDED.email_verified,
            updated_at = NOW()
      `, [
        user.uid,
        user.email,
        user.displayName || null,
        user.photoURL || null,
        defaultRole,
        user.emailVerified
      ]);

      // D294: o tipo da conta viaja junto (`worker`); a coluna `users.account_type` é derivada pelo trigger da 414.
      await mergeCustomClaims(user.uid, { role: defaultRole, account_type: 'worker' });

      await client.query('COMMIT');

      log.info({ email: maskEmailForLog(user.email), role: defaultRole }, 'User created successfully');
    } catch (error) {
      await client.query('ROLLBACK').catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        reportError(e, { source: 'onUserCreate:rollback', firebaseUid: user.uid });
      });
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ error: err.message }, 'Error creating user');
      reportError(err, { source: 'onUserCreate', firebaseUid: user.uid });
      throw err;
    } finally {
      client.release();
    }
  });
});
