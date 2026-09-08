import * as functions from 'firebase-functions';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { isPatientStatus, isClinicalPatientStatus, type PatientStatus } from '../domain/enums/PatientStatus';
import type { OnHoldReason } from '../domain/enums/OnHoldReason';
import { blockingCodesForStatusChange } from '../domain/PatientCompleteness';
import { loadPatientCompleteness } from '../infrastructure/PatientCompletenessLoader';

/**
 * PatientStatusWriter — a TRANSIÇÃO DE ESTADO do paciente, e só ela.
 *
 * Extraído de `PatientService` para manter aquele arquivo dentro do teto de 400 linhas — o
 * mesmo motivo, e o mesmo molde, de `PatientRelatedWriter`. Nada de comportamento mudou de
 * lugar: mesma transação, mesma trava `FOR UPDATE`, mesma consulta a
 * `patient_status_transitions`, mesmo SET montado, mesma linha de log sem a nota.
 *
 * `PatientService.moveStatus` continua sendo a porta (é ela que o controller e o Kanban
 * conhecem) e é lá que mora o `changeSource` padrão — repetir o default aqui criaria um ramo
 * que chamador nenhum exercita.
 */

/** Transição fora de `patient_status_transitions` (migration 315) — o controller devolve 422. */
export class PatientStatusTransitionError extends Error {
  readonly code = 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED';
  constructor(readonly from: string | null, readonly to: string) {
    super(`Patient status transition not allowed: ${from ?? 'null'} → ${to}`);
    this.name = 'PatientStatusTransitionError';
  }
}

/**
 * Pré-condição de completude não atendida para o status pedido (decisão do Gabriel 07/09) — o
 * controller devolve 422. Carrega `missing` para que a tela possa NOMEAR o que falta, no mesmo
 * formato que o `POST /activate` já devolve (`details.missing`), e assim reusar as traduções do
 * checklist em vez de inventar um segundo vocabulário.
 */
export class PatientStatusNotReadyError extends Error {
  readonly code = 'PATIENT_STATUS_NOT_READY';
  constructor(
    readonly to: string,
    readonly missing: readonly string[],
  ) {
    super(`Patient not ready for status ${to}: falta ${missing.join(', ')}`);
    this.name = 'PatientStatusNotReadyError';
  }
}

/** ON_HOLD sem motivo (spec 012, US-B7) — o controller devolve 422. */
export class OnHoldReasonRequiredError extends Error {
  readonly code = 'ON_HOLD_REASON_REQUIRED';
  constructor() {
    super('on_hold_reason is required when status is ON_HOLD');
    this.name = 'OnHoldReasonRequiredError';
  }
}

export interface MoveStatusOptions {
  onHoldReason?: OnHoldReason | null;
  /**
   * Texto clínico restrito (pacote D211.2) — nunca logado, nunca copiado para a history.
   *
   * TRÊS estados, de propósito (a nota não tem segunda cópia — apagar é irreversível):
   *   - `undefined` → o chamador NÃO mandou a chave: a coluna não é tocada (o texto sobrevive);
   *   - `string`    → grava o texto;
   *   - `null`      → APAGA a nota, de propósito.
   * Sair de ON_HOLD limpa a nota de qualquer jeito (lex C7.1-e), independente deste campo.
   */
  onHoldNote?: string | null;
  /** Vira `change_source` em patient_status_history (trigger 254, via app.change_source). */
  changeSource: 'admin_panel' | 'kanban' | 'activate' | 'system';
}

/**
 * Moves a patient to a new lifecycle status — v2 (spec 012, US-B7).
 *
 *   - alvo CLÍNICO (ACTIVE, ON_HOLD, …): a transição (status atual → alvo) tem de existir em
 *     `patient_status_transitions` (315); ausente → PatientStatusTransitionError (422);
 *   - alvo DENTRO do funil de admissão (SOLICITANTE/ADMISSION/PENDING_ADMISSION): é o Kanban,
 *     livre como sempre foi — `admission_status` acompanha pelo trigger da 313;
 *   - ON_HOLD exige `onHoldReason`; sair de ON_HOLD LIMPA motivo e nota (nenhuma 2ª cópia);
 *   - `changeSource` vai por `set_config('app.change_source', …, true)` na MESMA transação: é o
 *     que o trigger da 254 grava em patient_status_history (a coluna "origem" do Historial);
 *   - `on_hold_note` NUNCA entra no log (lex C7.1-b) nem na history (C7.3).
 * Never touches `origin` (a native patient stays native).
 */
export async function movePatientStatus(
  patientId: string,
  status: PatientStatus,
  opts: MoveStatusOptions,
): Promise<{ id: string; status: PatientStatus }> {
  if (!isPatientStatus(status)) {
    throw new Error(`Invalid patient status: ${String(status)}`);
  }
  const goingOnHold = status === 'ON_HOLD';
  if (goingOnHold && !opts.onHoldReason) {
    throw new OnHoldReasonRequiredError();
  }

  const db     = DatabaseConnection.getInstance();
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    const current = await client.query<{ status: string | null }>(
      'SELECT status FROM patients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [patientId],
    );
    if ((current.rowCount ?? 0) === 0 || current.rows.length === 0) {
      throw new Error(`Patient not found: ${patientId}`);
    }
    const from = current.rows[0].status;

    // A tabela decide sempre que UMA DAS PONTAS é clínica — não só o alvo. Validar só o alvo
    // deixava a DEMOÇÃO passar sem 422 (arrastar o card de ACTIVE para a coluna de admissão),
    // e o mesmo UPDATE ainda apagava motivo e nota. Movimento DENTRO do funil (as duas pontas
    // em SOLICITANTE/ADMISSION/PENDING_ADMISSION) continua livre, como sempre foi.
    if ((isClinicalPatientStatus(status) || isClinicalPatientStatus(from)) && from !== status) {
      const allowed = await client.query(
        'SELECT 1 FROM patient_status_transitions WHERE from_status = $1 AND to_status = $2',
        [from, status],
      );
      if (allowed.rows.length === 0) {
        throw new PatientStatusTransitionError(from, status);
      }
    }

    // Pré-condição de COMPLETUDE (decisão do Gabriel 07/09). Roda DEPOIS da FSM de propósito:
    // uma transição que nem existe deve dizer "não existe", não "falta horário".
    //
    // Só quando o status MUDA — reenviar o status atual (a tela salva o select sem alterar nada)
    // não pode virar erro por um dado que já estava faltando antes.
    //
    // ACTIVE cobra o checklist bloqueante inteiro: até aqui, arrastar o card para a coluna
    // "Activo" no Kanban ativava sem checklist NENHUM, furando inclusive o ADDRESS que barra o
    // botão "Activar" desde a D255. SEARCHING/REPLACEMENT cobram só o horário.
    if (from !== status) {
      const required = blockingCodesForStatusChange(status);
      if (required.length > 0) {
        const { missing } = await loadPatientCompleteness(client, patientId);
        const faltando = required.filter((code) => missing.includes(code));
        if (faltando.length > 0) {
          throw new PatientStatusNotReadyError(status, faltando);
        }
      }
    }

    // SET montado (mesmo molde de `updatePatientSection` acima): a nota só entra no UPDATE
    // quando o chamador a MANDOU, ou quando o paciente SAI de ON_HOLD (limpeza, lex C7.1-e).
    // Sem isto, reordenar o motivo de um ON_HOLD já existente destruía o texto clínico.
    // `onHoldReason` é garantido em ON_HOLD (OnHoldReasonRequiredError lá em cima) — nenhum
    // `?? null` aqui, que seria um ramo inalcançável.
    const values: unknown[] = [patientId, status, goingOnHold ? opts.onHoldReason : null];
    const sets = ['status = $2', 'on_hold_reason = $3'];
    if (!goingOnHold || opts.onHoldNote !== undefined) {
      values.push(goingOnHold ? opts.onHoldNote ?? null : null);
      sets.push(`on_hold_note = $${values.length}`);
    }

    await client.query("SELECT set_config('app.change_source', $1, true)", [opts.changeSource]);
    await client.query(
      `UPDATE patients SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      values,
    );
    await client.query('COMMIT');

    // Trilha SEM a nota: from/to/motivo/origem. O texto é clínico restrito (D211.2).
    functions.logger.info('patient_status.moved', {
      patientId, from, to: status, onHoldReason: goingOnHold ? opts.onHoldReason : null, changeSource: opts.changeSource,
    });
    return { id: patientId, status };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
