import type { PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { isCaseNumberConflict } from './patientCaseNumberConflict';

/**
 * Toda escrita de paciente roda aqui (ABAC país, BLOCKER-5 — veio da `stage`,
 * reaplicado no sync main→stage sobre os helpers em que o `main` repartiu o
 * `PatientService`: `PatientNativeCreator`, `PatientSectionWriter`,
 * `PatientStatusWriter`).
 *
 * `DatabaseConnection.getClient()` entrega o pool CRU: sem o roteamento por
 * identidade (runtime × sistema) e sem o contexto de país da request — sob RLS,
 * uma escrita por ali sai como a role errada ou sem `app.user_country`.
 * `withActorContext` abre a transação no client certo (reusando o client já
 * fixado na request, quando há), carimba ator + contexto e faz
 * BEGIN/COMMIT/ROLLBACK — por isso não há mais controle de transação à mão.
 */
export function inPatientTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withActorContext(DatabaseConnection.getInstance().getPool(), fn);
}

/**
 * Sinaliza PARA FORA da transação que o retry sem `case_number` deve rodar.
 *
 * O retry precisa de uma transação NOVA (a que bateu na constraint está abortada
 * no Postgres), e quem controla transação aqui é `withActorContext` — então o
 * caminho de conflito sai por exceção e o retry é disparado fora dela. Só o erro
 * vindo do upsert de IDENTIDADE vira este sinal: um 23505 do bloco clínico/
 * responsáveis continua sendo erro de verdade.
 */
export class CaseNumberConflictRetry extends Error {
  constructor(readonly original: unknown) {
    super('patients_case_number_active_unique');
    this.name = 'CaseNumberConflictRetry';
  }
}

/** Converte o 23505 da constraint de `case_number` no sinal de retry; o resto passa. */
export function rethrowAsCaseNumberRetry(err: unknown): never {
  if (isCaseNumberConflict(err)) throw new CaseNumberConflictRetry(err);
  throw err;
}
