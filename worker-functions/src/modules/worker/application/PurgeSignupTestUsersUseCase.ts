import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';

/** Porta do Firebase: apaga o usuário de login pelo uid. Falha = rejeita a promise. */
export interface FirebaseUserDeleter {
  deleteUser(uid: string): Promise<void>;
}

export interface PurgeSignupTestUsersResult {
  /** Contas no escopo (ficha is_test + e-mail qa.signup.*@enlite.test). */
  inScope: number;
  deleted: number;
  failed: number;
}

interface SignupCandidateRow {
  auth_uid: string | null;
  email: string | null;
  is_test: boolean;
}

const log = logger.child({ source: 'PurgeSignupTestUsersUseCase' });

/**
 * FR-95/DP-23: a faxina apaga o usuário Firebase das contas de E2E do cadastro — senão
 * `qa.signup.<run>@enlite.test` fica ocupado e o próximo run vê `email-already-in-use`.
 *
 * ESCOPO DURO (fecha aqui, no código, não no SQL): ficha `is_test = true` E e-mail que começa por
 * `qa.signup.` e termina em `@enlite.test`. Conta real, conta `qa.worker.` (massa-base) e qualquer
 * outro usuário Firebase não são tocados. Falha numa conta é contada e o lote segue.
 * Deve rodar ANTES da faxina de dados (que apaga a ficha e com ela o `auth_uid`).
 * Log só com contagens — nunca uid nem e-mail.
 */
export class PurgeSignupTestUsersUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly firebase: FirebaseUserDeleter,
  ) {}

  async execute(): Promise<PurgeSignupTestUsersResult> {
    const res = await this.pool.query<SignupCandidateRow>(
      `SELECT auth_uid, email, is_test FROM workers
        WHERE is_test = true AND auth_uid IS NOT NULL
          AND lower(btrim(email)) LIKE 'qa.signup.%@enlite.test'`,
    );

    const inScope = res.rows.filter((r) => {
      const email = (r.email ?? '').trim().toLowerCase();
      return r.is_test === true && !!r.auth_uid && email.startsWith('qa.signup.') && email.endsWith('@enlite.test');
    });

    let deleted = 0;
    let failed = 0;
    for (const row of inScope) {
      try {
        await this.firebase.deleteUser(row.auth_uid!);
        deleted += 1;
      } catch (err) {
        failed += 1;
        reportError(err instanceof Error ? err : new Error(String(err)), { source: 'PurgeSignupTestUsersUseCase:deleteUser' });
      }
    }

    const result = { inScope: inScope.length, deleted, failed };
    log.info({ msg: 'signup_test_users_purged', ...result });
    return result;
  }
}
