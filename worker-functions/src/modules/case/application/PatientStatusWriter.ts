import * as functions from 'firebase-functions';
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { isPatientStatus, isClinicalPatientStatus, isFunnelToSearchingTransition, type PatientStatus } from '../domain/enums/PatientStatus';
import { isManualChangeSource, type PatientChangeSource } from '../domain/enums/PatientChangeSource';
import { recordedChangeSource } from '../domain/enums/PatientChangeSourceOverride';
import type { OnHoldReason } from '../domain/enums/OnHoldReason';
import type { SuspensionExitReason } from '../domain/enums/SuspensionExitReason';
import { blockingCodesForStatusChange } from '../domain/PatientCompleteness';
import { decidirTrocaForaDoFluxo } from '../domain/trocaForaDoFluxo';
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

/**
 * Saída MANUAL de SUSPENDED sem motivo (decisão do Gabriel 29/09/2026) — o controller devolve
 * 422. Mesmo padrão de `OnHoldReasonRequiredError`: motivo fechado (SuspensionExitReason), sem
 * texto livre, que a trilha (`patient_status_history.reason`, migration 486) grava via set_config.
 */
export class SuspensionExitReasonRequiredError extends Error {
  readonly code = 'SUSPENSION_EXIT_REASON_REQUIRED';
  constructor() {
    super('suspensionExitReason is required when leaving SUSPENDED manually');
    this.name = 'SuspensionExitReasonRequiredError';
  }
}

/**
 * Troca clínica→clínica FORA do fluxo (sem linha em `patient_status_transitions`) sem a célula do
 * DESTINO (spec 051) — o controller devolve 403 `{code, details:{from,to,cell}}`, antes de qualquer
 * escrita. `cells=null` (engine neutro) nunca chega aqui: cai no `PatientStatusTransitionError`.
 */
export class PatientStatusPermissionError extends Error {
  readonly code = 'PATIENT_STATUS_MOVE_NOT_PERMITTED';
  constructor(readonly from: PatientStatus | null, readonly to: PatientStatus, readonly cell: string) {
    super(`Patient status move ${from ?? 'null'} → ${to} requires permission ${cell}`);
    this.name = 'PatientStatusPermissionError';
  }
}

/** Origens que podem tirar o paciente do funil de admissão para SEARCHING (D469). */
const FUNNEL_TO_SEARCHING_SOURCES: ReadonlyArray<PatientChangeSource> = [
  'vacancy_launch',
  'recruitment_activation',
  'kanban',
];

/**
 * Guarda D469 (02/10/2026; antes D434/DX-6.4): funil→SEARCHING é ato intencional — foguete, envio à
 * Talentum ou arrasto no Kanban. O PUT /status do select da ficha (admin_panel) e a derivação
 * (system) continuam recusados com o 422. Não depende da FSM: o writer a checa ANTES de consultá-la.
 */
function funilParaSearchingBarrado(from: PatientStatus | null, to: PatientStatus, changeSource: PatientChangeSource): boolean {
  return isFunnelToSearchingTransition(from, to) && !FUNNEL_TO_SEARCHING_SOURCES.includes(changeSource);
}

/**
 * A troca passa pela guarda D469/FSM/célula quando UMA DAS PONTAS é clínica (e o estado muda).
 * Movimento DENTRO do funil (as duas pontas em SOLICITANTE/ADMISSION/PENDING_ADMISSION) é livre —
 * Kanban, sem FSM, sem célula. Único lugar da condição: o writer e a lista de destinos a usam.
 */
export function trocaPassaPelaGuarda(from: PatientStatus | null, to: PatientStatus): boolean {
  return (isClinicalPatientStatus(to) || isClinicalPatientStatus(from)) && from !== to;
}

export type AvaliacaoDaTroca =
  /** Par com linha na FSM: livre para quem tem `patient:update`, como sempre foi. */
  | { resultado: 'dentro_do_fluxo' }
  /** Par fora da FSM e o ator TEM a célula do destino: passa, e grava `*_override`. */
  | { resultado: 'fora_do_fluxo_permitida'; celula: string }
  | { resultado: 'recusa_por_permissao'; celula: string }
  /** Qualquer outra recusa: o `PatientStatusTransitionError` (422) de hoje. */
  | { resultado: 'recusa_de_transicao' };

/**
 * O ÚNICO lugar que responde "esta troca de estado passa pela guarda de transição/permissão?".
 * O writer (PUT /status) e a lista de destinos (GET /status-options) chamam esta função — a lista
 * e o PUT nunca têm duas implementações da regra (spec 051, A6). Ordem preservada de antes: D469
 * primeiro, depois a FSM, e só então a célula.
 */
export function avaliarTroca(e: {
  from: PatientStatus | null;
  to: PatientStatus;
  naFsm: boolean;
  cells: readonly string[] | null;
  changeSource: PatientChangeSource;
}): AvaliacaoDaTroca {
  if (funilParaSearchingBarrado(e.from, e.to, e.changeSource)) return { resultado: 'recusa_de_transicao' };
  if (e.naFsm) return { resultado: 'dentro_do_fluxo' };
  const d = decidirTrocaForaDoFluxo({ de: e.from, para: e.to, naFsm: false, cells: e.cells, changeSource: e.changeSource });
  if (d.resultado === 'permitida_por_permissao') return { resultado: 'fora_do_fluxo_permitida', celula: d.celula };
  if (d.resultado === 'recusada_por_permissao') return { resultado: 'recusa_por_permissao', celula: d.celulaFaltante };
  // Os demais resultados (`nao_se_aplica`, `engine_nao_decidiu`, `fluxo_normal`) NUNCA liberam: o
  // par segue a FSM de hoje, que aqui não tem a seta → 422. A atribuição abaixo é a trava de
  // exaustividade: um resultado novo em `DecisaoTrocaForaDoFluxo` quebra a compilação até alguém decidir.
  const segueAFsmDeHoje: 'nao_se_aplica' | 'engine_nao_decidiu' | 'fluxo_normal' = d.resultado;
  void segueAFsmDeHoje;
  return { resultado: 'recusa_de_transicao' };
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
  changeSource: PatientChangeSource; // união no domínio (PatientChangeSource): o zod da rota HTTP só aceita as MANUAIS
  /**
   * Motivo de SAÍDA de SUSPENDED (decisão do Gabriel 29/09/2026) — exigido só quando `from`
   * (lido dentro da transação) é SUSPENDED, o alvo é outro e `changeSource` é MANUAL
   * (admin_panel/kanban); ausente nesse caso → SuspensionExitReasonRequiredError. Fora desse
   * caso o valor é ignorado (não grava motivo solto), mesmo padrão de `onHoldReason` ao SAIR de
   * ON_HOLD. Vira `patient_status_history.reason` (migration 486) via `app.status_reason`.
   */
  suspensionExitReason?: SuspensionExitReason | null;
  /**
   * Firebase uid de quem pediu a mudança via HTTP (decisão do Gabriel 29/09/2026). Ausente em
   * chamada de SISTEMA (derivação) — a history fica sem ator, como sempre foi.
   * NUNCA logado (nem `functions.logger.info` abaixo) — só viaja por `app.actor_uid`.
   */
  actorUid?: string | null;
  /**
   * Células do ator (spec 051) — SÓ o `AdminPatientsController.updatePatientStatus` passa, com
   * `clinicalCellsOf(req)`. Ausente = `null` = o engine não decidiu = comportamento de antes
   * (troca fora da FSM → 422). `[]` ≠ `null`: ator conhecido sem célula → 403. Nunca `?? []`.
   */
  cells?: readonly string[] | null;
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
 *
 * `txClient` (cadeia Fase 15): quando vem, a transição roda NA transação de quem chama (a
 * derivação, dentro do escritor do itinerário) — sem `BEGIN`/`COMMIT` próprio; `withActorContext`
 * reusaria o client fixado na request e comitaria no meio. Sem ele, a transação própria de sempre.
 */
export async function movePatientStatus(
  patientId: string,
  status: PatientStatus,
  opts: MoveStatusOptions,
  txClient?: PoolClient,
): Promise<{ id: string; status: PatientStatus }> {
  if (!isPatientStatus(status)) {
    throw new Error(`Invalid patient status: ${String(status)}`);
  }
  const goingOnHold = status === 'ON_HOLD';
  if (goingOnHold && !opts.onHoldReason) {
    throw new OnHoldReasonRequiredError();
  }

  const body = async (client: PoolClient): Promise<{ id: string; status: PatientStatus }> => {
    const current = await client.query<{ status: PatientStatus | null }>(
      'SELECT status FROM patients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [patientId],
    );
    if ((current.rowCount ?? 0) === 0 || current.rows.length === 0) {
      throw new Error(`Patient not found: ${patientId}`);
    }
    const from = current.rows[0].status;

    let foraDoFluxo = false;
    // A tabela decide sempre que UMA DAS PONTAS é clínica — não só o alvo. Validar só o alvo
    // deixava a DEMOÇÃO passar sem 422 (arrastar o card de ACTIVE para a coluna de admissão),
    // e o mesmo UPDATE ainda apagava motivo e nota. Movimento DENTRO do funil (as duas pontas
    // em SOLICITANTE/ADMISSION/PENDING_ADMISSION) continua livre, como sempre foi.
    if (trocaPassaPelaGuarda(from, status)) {
      // D469 antes de qualquer consulta (não precisa da FSM); depois FSM + célula do destino
      // (spec 051), tudo em `avaliarTroca` — a mesma função que a lista de destinos usa.
      if (funilParaSearchingBarrado(from, status, opts.changeSource)) {
        throw new PatientStatusTransitionError(from, status);
      }
      const allowed = await client.query(
        'SELECT 1 FROM patient_status_transitions WHERE from_status = $1 AND to_status = $2',
        [from, status],
      );
      const avaliacao = avaliarTroca({
        from, to: status, naFsm: allowed.rows.length > 0, cells: opts.cells ?? null, changeSource: opts.changeSource,
      });
      if (avaliacao.resultado === 'recusa_por_permissao') {
        throw new PatientStatusPermissionError(from, status, avaliacao.celula);
      }
      if (avaliacao.resultado === 'recusa_de_transicao') {
        throw new PatientStatusTransitionError(from, status);
      }
      foraDoFluxo = avaliacao.resultado === 'fora_do_fluxo_permitida';
    }

    // Saída MANUAL de SUSPENDED exige motivo (decisão do Gabriel 29/09/2026). Roda DEPOIS da FSM
    // (mesma ordem do bloco de completude logo abaixo, e pelo mesmo motivo: uma transição que nem
    // existe diz "não existe", não "falta motivo") e SÓ para admin_panel/kanban — chamada de
    // SISTEMA (derivação) nunca sai de SUSPENDED hoje, do mesmo jeito que `changeSource: 'system'`
    // nunca disparou OnHoldReasonRequiredError.
    const leavingSuspendedManually =
      from === 'SUSPENDED' && status !== 'SUSPENDED' &&
      isManualChangeSource(opts.changeSource);
    if (leavingSuspendedManually && !opts.suspensionExitReason) {
      throw new SuspensionExitReasonRequiredError();
    }
    // Motivo mandado fora da saída de SUSPENDED é IGNORADO na trilha (não grava motivo solto) —
    // mesmo padrão de `onHoldReason`, que a UPDATE abaixo zera quando `status !== 'ON_HOLD'`.
    const statusReasonToRecord = from === 'SUSPENDED' && status !== 'SUSPENDED' ? (opts.suspensionExitReason ?? null) : null;

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
      const required = blockingCodesForStatusChange(status, foraDoFluxo);
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

    // Troca fora do fluxo (spec 051 §4): o SERVIDOR marca `*_override` — o corpo da rota nunca
    // aceita esse valor (zod), então o cliente não se declara override.
    const changeSourceGravado = recordedChangeSource(opts.changeSource, foraDoFluxo);
    await client.query("SELECT set_config('app.change_source', $1, true)", [changeSourceGravado]);
    // Motivo de saída de SUSPENDED e ator: mesmo molde do change_source acima, GUCs próprios que
    // os triggers da 254/255 leem via NULLIF(…, '') — string vazia = ausente = NULL na history
    // (migration 486). Duas queries próprias (não uma combinada) para não mudar o formato que os
    // testes já conferem em `set_config('app.change_source'`.
    await client.query("SELECT set_config('app.status_reason', $1, true)", [statusReasonToRecord ?? '']);
    await client.query("SELECT set_config('app.actor_uid', $1, true)", [opts.actorUid ?? '']);
    await client.query(
      `UPDATE patients SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      values,
    );
    // Trilha SEM a nota: from/to/motivo/origem. O texto é clínico restrito (D211.2). NUNCA o
    // actorUid (nem aqui) — ele só viaja pelo set_config acima, direto para a history.
    functions.logger.info('patient_status.moved', {
      patientId, from, to: status, onHoldReason: goingOnHold ? opts.onHoldReason : null, changeSource: changeSourceGravado,
      suspensionExitReason: statusReasonToRecord,
    });
    return { id: patientId, status };
  };
  return txClient ? body(txClient) : inPatientTransaction(body);
}
