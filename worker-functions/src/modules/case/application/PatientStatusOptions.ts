import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import type { ManualChangeSource } from '../domain/enums/PatientChangeSource';
import { avaliarTroca, trocaPassaPelaGuarda } from './PatientStatusWriter';
import { PATIENT_STATUSES, type PatientStatus } from '../domain/enums/PatientStatus';
import { blockingCodesForStatusChange, type PatientCompletenessCode } from '../domain/PatientCompleteness';
import { loadPatientCompleteness } from '../infrastructure/PatientCompletenessLoader';

/**
 * Spec 051 (F3) — a LISTA de destinos de estado que o servidor aceitaria para este paciente e este
 * ator. É o que o select da ficha e o arrasto do Kanban vão renderizar (PR-C): o front não decide
 * (`permissions=null` no front ≠ `cells=null` no servidor; e a FSM só existe aqui).
 *
 * NÃO tem regra própria: cada candidato passa por `avaliarTroca`, a MESMA função do
 * `movePatientStatus` (PUT /status) — lista e PUT não podem divergir (A6). O que a lista acrescenta
 * é só (a) quem são os candidatos e (b) `blockedBy`, da completude.
 */

/** `fluxo` = tem linha na FSM; `permissao` = fora da FSM, liberada pela célula do destino. */
export type ViaDaTroca = 'fluxo' | 'permissao';

export interface PatientStatusOption {
  status: PatientStatus;
  via: ViaDaTroca;
  /** Códigos de completude que faltam para ESTE destino; ausente quando nada falta. */
  blockedBy?: PatientCompletenessCode[];
}

export interface PatientStatusOptions {
  current: PatientStatus | null;
  /** A origem com que a lista foi calculada — o front confere que é a mesma do PUT que vai mandar. */
  changeSource: ManualChangeSource;
  options: PatientStatusOption[];
}

export async function loadStatusOptions(
  client: PoolClient,
  patientId: string,
  cells: readonly string[] | null,
  changeSource: ManualChangeSource,
): Promise<PatientStatusOptions> {
  const cur = await client.query<{ status: PatientStatus | null }>(
    'SELECT status FROM patients WHERE id = $1 AND deleted_at IS NULL',
    [patientId],
  );
  if (cur.rows.length === 0) throw new Error(`Patient not found: ${patientId}`);
  const current = cur.rows[0].status;

  const fsm = await client.query<{ to_status: PatientStatus }>(
    'SELECT to_status FROM patient_status_transitions WHERE from_status = $1',
    [current],
  );
  const naFsm = new Set(fsm.rows.map((r) => r.to_status));

  // A lista é o conjunto de destinos que o PUT aceitaria com esta origem e estas células — nem a
  // mais, nem a menos. Candidatos = o vocabulário inteiro menos o estado atual; cada um passa pela
  // MESMA decisão do writer: dentro do funil (nenhuma ponta clínica) é livre (`fluxo`); o resto vai
  // para `avaliarTroca`. Status nulo: o PUT só aceita destinos do funil (clínico fica sem linha → 422).
  const aceitos: Array<{ status: PatientStatus; via: ViaDaTroca }> = [];
  for (const para of PATIENT_STATUSES.filter((s) => s !== current)) {
    if (!trocaPassaPelaGuarda(current, para)) {
      aceitos.push({ status: para, via: 'fluxo' });
      continue;
    }
    const a = avaliarTroca({ from: current, to: para, naFsm: naFsm.has(para), cells, changeSource });
    if (a.resultado === 'dentro_do_fluxo') aceitos.push({ status: para, via: 'fluxo' });
    else if (a.resultado === 'fora_do_fluxo_permitida') aceitos.push({ status: para, via: 'permissao' });
  }

  // Completude lida uma vez, só se algum destino pede algo. Motivo de ON_HOLD e de saída de
  // SUSPENDED NÃO entram: são dado que a tela coleta, não falta no paciente.
  const { missing } = aceitos.some((o) => blockingCodesForStatusChange(o.status, o.via === 'permissao').length > 0)
    ? await loadPatientCompleteness(client, patientId)
    : { missing: [] as PatientCompletenessCode[] };

  const options = aceitos.map((o): PatientStatusOption => {
    const faltando = blockingCodesForStatusChange(o.status, o.via === 'permissao').filter((c) => missing.includes(c));
    return faltando.length > 0 ? { ...o, blockedBy: [...faltando] } : o;
  });
  return { current, changeSource, options };
}

export function listPatientStatusOptions(
  patientId: string,
  cells: readonly string[] | null,
  changeSource: ManualChangeSource,
): Promise<PatientStatusOptions> {
  return inPatientTransaction((client) => loadStatusOptions(client, patientId, cells, changeSource));
}
