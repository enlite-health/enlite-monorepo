import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { avaliarTroca } from './PatientStatusWriter';
import { CLINICAL_PATIENT_STATUSES, isClinicalPatientStatus } from '../domain/enums/PatientStatus';
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

export interface PatientStatusOption {
  status: string;
  /** `fluxo` = tem linha na FSM; `permissao` = fora da FSM, liberada pela célula do destino. */
  via: 'fluxo' | 'permissao';
  /** Códigos de completude que faltam para ESTE destino; ausente quando nada falta. */
  blockedBy?: PatientCompletenessCode[];
}

export interface PatientStatusOptions {
  current: string | null;
  options: PatientStatusOption[];
}

export async function loadStatusOptions(
  client: PoolClient,
  patientId: string,
  cells: readonly string[] | null,
): Promise<PatientStatusOptions> {
  const cur = await client.query<{ status: string | null }>(
    'SELECT status FROM patients WHERE id = $1 AND deleted_at IS NULL',
    [patientId],
  );
  if (cur.rows.length === 0) throw new Error(`Patient not found: ${patientId}`);
  const current = cur.rows[0].status;

  const fsm = await client.query<{ to_status: string }>(
    'SELECT to_status FROM patient_status_transitions WHERE from_status = $1',
    [current],
  );
  const naFsm = new Set(fsm.rows.map((r) => r.to_status));
  // Candidatos: o que a FSM oferece + os clínicos (fora da FSM só vale se o estado atual é clínico;
  // `avaliarTroca` recusa o resto). Nunca o estado atual.
  const candidatos = new Set<string>([...naFsm, ...(isClinicalPatientStatus(current) ? CLINICAL_PATIENT_STATUSES : [])]);
  candidatos.delete(current ?? '');

  const aceitos: Array<{ status: string; via: 'fluxo' | 'permissao' }> = [];
  for (const para of candidatos) {
    const a = avaliarTroca({ from: current, to: para, naFsm: naFsm.has(para), cells, changeSource: 'admin_panel' });
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
  return { current, options };
}

export function listPatientStatusOptions(patientId: string, cells: readonly string[] | null): Promise<PatientStatusOptions> {
  return inPatientTransaction((client) => loadStatusOptions(client, patientId, cells));
}
