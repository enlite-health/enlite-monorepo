/**
 * src/modules/anacare-hours/application/AnaCareHoursMapper.ts
 *
 * Junta o turno da FONTE (`SourceShiftDTO`, adapter falso em F1) com a validação nossa
 * (`ValidationRow`, pode não existir = pendente) e projeta no shape do contrato
 * (`AnaCareShift`/`AnaCarePatient`/`AnaCareMonthSnapshot`) que o front consome — mesma
 * interface do protótipo (spec §Contrato de dados).
 *
 * Vínculo de PRESTADOR (D349, item 1): `groupIntoPatients` recebe `linkedNurseIds` — só decide
 * `linked` (presença do `anaCareNurseId` no cruzamento com `workers.ana_care_id`, lookup em LOTE
 * feito por `AnaCareHoursService`/`WorkerLinkRepository`, D195/`MirrorWorkerService`).
 *
 * NOME (item 1 da conferência de horas, decisão do Gabriel 17/09): "o nome vem junto na requisição
 * do Ana Care e é de lá que você precisa pegar" — `patientName`/`nurseName` chegam já resolvidos
 * em cada entrada de `shifts` (montados por `AnaCareHoursService.buildPatients` a partir de
 * `SourceShiftDTO.patientFirstName/patientLastName/nurseFirstName/nurseLastName`), e são
 * INDEPENDENTES de `linked` — nome vem da FONTE, vínculo vem do cruzamento com nosso banco. O
 * gate `worker_contact:read` (`canReadProviderName`) continua aplicado ANTES de chegar aqui (quem
 * não tem a célula manda `nurseName: undefined`, mesmo que a fonte tenha mandado o nome) — este
 * módulo não decide permissão, só agrupa.
 *
 * Vínculo de PACIENTE continua SEMPRE `false` — bloqueado por decisão (D349 item 2): não existe
 * hoje ID nosso do lado do paciente no Ana Care, nem API de leitura de paciente. O NOME do
 * paciente, porém, não depende desse vínculo — vem sempre da fonte quando presente.
 */

import type { AnaCareRetratoSourceStatus, SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { SyncRunConclusion } from '../domain/AnaCareHoursSyncPorts';
import type { ValidationRow } from '../infrastructure/ShiftHoursValidationRepository';
import type { AnaCareListPatient, AnaCareMonthSnapshot, AnaCarePatient, AnaCareProvider, AnaCareShift, AnaCareSnapshotState, ValidationStatus } from '../domain/AnaCareShift';
import type { AxonicoLancamentoSentRecord, EnliteServiceType, IAnaCarePatientDocumentRepository } from '@modules/integration';

const STATUS_MAP: Record<ValidationRow['status'], ValidationStatus> = {
  pendente: 'pendiente',
  validado: 'validado',
  contestado: 'contestado',
};

/**
 * Junta nome+sobrenome vindos da FONTE (item 1) — `undefined` quando nenhum dos dois veio (a
 * fonte pode não mandar nome para um turno específico; `Sin vínculo · ID X` continua o fallback
 * honesto na tela, `selectors.ts` `providerDisplayName`/`patientDisplayName`).
 */
export function joinSourceName(firstName: string | null | undefined, lastName: string | null | undefined): string | undefined {
  const joined = [firstName, lastName].filter((part): part is string => Boolean(part && part.trim())).join(' ');
  return joined.trim() || undefined;
}

function hoursBetween(startIso: string, endIso: string): number {
  return Math.round(((new Date(endIso).getTime() - new Date(startIso).getTime()) / (1000 * 60 * 60)) * 100) / 100;
}

/**
 * Horas PREVISTAS — SEMPRE um número real no contrato (`AnaCareShift.hoursScheduled: number`,
 * nunca `null`/`NaN`). Item 7 (revisão de PR): antes, `AnaCareShiftRepository.toDTO` mascarava
 * `planned_start`/`planned_end` ausentes como `''`, e `hoursBetween('', '')` devolvia `NaN` — que o
 * JSON serializa como `null`, mentindo silenciosamente sobre um campo tipado `number`. Agora a
 * fonte propaga `null` explícito (nunca `''`) até aqui, e SEM o previsto conhecido o valor seguro é
 * `0` (mesmo padrão de "ausência de dado nunca produz um número inválido" de `computeActualHours`).
 */
export function hoursScheduledOf(scheduledStart: string | null, scheduledEnd: string | null): number {
  if (!scheduledStart || !scheduledEnd) return 0;
  return hoursBetween(scheduledStart, scheduledEnd);
}

/**
 * Horas REALMENTE trabalhadas — SEMPRE de `actualStart`/`actualEnd` (check-in/checkout), nunca do
 * previsto. `null` quando falta qualquer um dos dois (turno sem check-in, ou em andamento sem
 * checkout ainda) — medido 17/09: a fonte não tem campo de hora trabalhada, só previsto
 * (`duration`), inclusive em turno não finalizado (`is_finalized=false`).
 */
export function computeActualHours(source: Pick<SourceShiftDTO, 'actualStart' | 'actualEnd'>): number | null {
  if (!source.actualStart || !source.actualEnd) return null;
  return hoursBetween(source.actualStart, source.actualEnd);
}

/**
 * `canReadNote` — espelha a célula clínica (`patient_clinical:read`, backlog D345, mas o
 * contrato já reserva o corte: sem a célula a nota NUNCA sai no payload, mesmo cifrada).
 */
export function mapShift(source: SourceShiftDTO, validation: ValidationRow | undefined, canReadNote: boolean, decryptedNote: string | null): AnaCareShift {
  const status = STATUS_MAP[validation?.status ?? 'pendente'];
  const hoursActual = status === 'validado' ? validation!.approvedHours : computeActualHours(source);
  const origin = source.checkinSource === null ? 'sin_checkin' : source.checkinSource;

  const shift: AnaCareShift = {
    id: source.sourceShiftId,
    date: source.date,
    // Contrato de wire (`AnaCareShift.scheduledStart/scheduledEnd: string`) não muda — o `''` de
    // fallback fica só AQUI, na fronteira de exibição, nunca escondido dentro do cálculo de horas
    // (ver `hoursScheduledOf`, que usa o `null` original antes desse fallback).
    scheduledStart: source.scheduledStart ?? '',
    scheduledEnd: source.scheduledEnd ?? '',
    actualStart: source.actualStart,
    actualEnd: source.actualEnd,
    hoursActual,
    hoursScheduled: hoursScheduledOf(source.scheduledStart, source.scheduledEnd),
    origin,
    status,
    anaCareShiftId: source.sourceShiftId,
  };

  if (status === 'validado' && validation?.validatedBy) {
    shift.validatedBy = { id: validation.validatedBy, name: validation.validatedByName ?? validation.validatedBy };
    shift.validatedAt = validation.validatedAt ?? undefined;
  }
  if (status === 'contestado' && validation?.reason) {
    shift.contestReason = validation.reason;
    if (canReadNote) shift.contestNote = decryptedNote ?? undefined;
  }
  return shift;
}

/**
 * Agrupa turnos JÁ MAPEADOS por paciente → prestador.
 *
 * `providerLinks`: chave = `anaCareNurseId`. Presença da chave = `linked: true`; o valor é o
 * nome já decidido pelo chamador (`undefined` quando o ator não tem `worker_contact:read`, mesmo
 * que o vínculo exista — D349/D344). Ausência da chave = `linked: false` (sem vínculo em `workers`).
 * Paciente permanece sempre sem vínculo (item 2 da D349, bloqueado).
 */
export function groupIntoPatients(
  shifts: ReadonlyArray<{
    shift: AnaCareShift;
    anaCarePatientId: string;
    anaCareNurseId: string;
    /** Nome do paciente resolvido pela FONTE (já combinado first+last name) — ver cabeçalho do arquivo. */
    patientName?: string;
    /** Nome do prestador resolvido pela FONTE — já `undefined` quando o chamador não tem `worker_contact:read`. */
    nurseName?: string;
    /**
     * Documento do paciente resolvido pela FONTE — já `undefined` quando o chamador não tem
     * `patient_identity:read` (mesmo desenho de `nurseName`/`worker_contact:read`), mesmo que o
     * par tenha documento. Este módulo não decide permissão, só agrupa (ver cabeçalho).
     */
    patientDocumentType?: string;
    patientDocumentNumber?: string;
  }>,
  linkedNurseIds: ReadonlySet<string> = new Set(),
): AnaCarePatient[] {
  const byPatient = new Map<string, Map<string, { shifts: AnaCareShift[]; name?: string }>>();
  const patientNames = new Map<string, string>();
  const patientDocuments = new Map<string, { documentType?: string; documentNumber?: string }>();
  for (const { shift, anaCarePatientId, anaCareNurseId, patientName, nurseName, patientDocumentType, patientDocumentNumber } of shifts) {
    if (!byPatient.has(anaCarePatientId)) byPatient.set(anaCarePatientId, new Map());
    const byProvider = byPatient.get(anaCarePatientId)!;
    if (!byProvider.has(anaCareNurseId)) byProvider.set(anaCareNurseId, { shifts: [] });
    const entry = byProvider.get(anaCareNurseId)!;
    entry.shifts.push(shift);
    if (nurseName && !entry.name) entry.name = nurseName;
    if (patientName && !patientNames.has(anaCarePatientId)) patientNames.set(anaCarePatientId, patientName);
    if ((patientDocumentType || patientDocumentNumber) && !patientDocuments.has(anaCarePatientId)) {
      patientDocuments.set(anaCarePatientId, { documentType: patientDocumentType, documentNumber: patientDocumentNumber });
    }
  }

  const patients: AnaCarePatient[] = [];
  for (const [anaCareId, byProvider] of byPatient) {
    const providers: AnaCareProvider[] = [];
    for (const [providerAnaCareId, entry] of byProvider) {
      const linked = linkedNurseIds.has(providerAnaCareId);
      providers.push({ anaCareId: providerAnaCareId, linked, name: entry.name, shifts: entry.shifts });
    }
    const document = patientDocuments.get(anaCareId);
    patients.push({
      anaCareId,
      linked: false,
      name: patientNames.get(anaCareId),
      documentType: document?.documentType,
      documentNumber: document?.documentNumber,
      providers,
    });
  }
  return patients;
}

/** Sem corrida gravada para o mês (nem linha em `anacare_sync_run`, nem rodada gravada) — o MESMO "não sei" que `status IS NULL`. */
export const NO_SYNC_RUN_CONCLUSION: SyncRunConclusion = { status: null, reservationsTotal: null, reservationsDone: null };

export interface SnapshotStateInput {
  /** Item 3: `freshness.shifts === 0` — o retrato NUNCA foi sincronizado para este mês. Tem PRECEDÊNCIA sobre tudo abaixo. */
  naoConstruido: boolean;
  /** Retrato sincronizou, mas ficou velho (>24h) — só é avaliado depois de `desconhecido`/`parcial` descartados. */
  stale: boolean;
  /** `anacare_sync_run.status` do mês — `null` cobre "sem linha" E "linha com status IS NULL" (ver `SyncRunConclusion`). */
  syncStatus: SyncRunConclusion['status'];
  reservationsTotal: SyncRunConclusion['reservationsTotal'];
  reservationsDone: SyncRunConclusion['reservationsDone'];
}

/**
 * F2 (change `anacare-horas-conclusao-de-corrida`, proposal.md §Decisão fechada) — precedência
 * FECHADA, cada passo só avaliado depois que os anteriores foram descartados:
 *
 *   1. `nao_construido` — sem linha nenhuma para o mês (retrato AGREGADO nunca sincronizado).
 *   2. `desconhecido`   — `syncStatus === null`. 🔴 Regra dura: as linhas de agosto/setembro
 *      pré-existentes (status IS NULL após a migration 457) caem AQUI e NUNCA em `parcial` — dizer
 *      "parcial" sobre elas seria afirmar algo que o sistema não tem base para saber (não têm
 *      cursor/contagem registrados, só ausência de dado). Ver teste-régua em
 *      `AnaCareHoursMapper.test.ts` ("morre se status IS NULL virar parcial").
 *   3. `parcial`        — `syncStatus` é `running`/`failed`, OU `done` com
 *      `reservationsDone < reservationsTotal` (as duas contagens PRECISAM existir para essa
 *      comparação — `done` sem contagens gravadas não vira `parcial` por falta de base, cai para
 *      o passo seguinte).
 *   4. `velho`          — `stale` (regra já existente, inalterada).
 *   5. `fresco`         — só sobra quando nada acima capturou o estado.
 *
 * Extraída de `buildSnapshot` para ser testável isoladamente (um teste por ramo) sem montar
 * `AnaCareListPatient[]`/`AnaCareRetratoSourceStatus` inteiros.
 */
export function computeSnapshotState(input: SnapshotStateInput): AnaCareSnapshotState {
  if (input.naoConstruido) return 'nao_construido';
  if (input.syncStatus === null) return 'desconhecido';
  const incompleta =
    input.syncStatus === 'running' ||
    input.syncStatus === 'failed' ||
    (input.syncStatus === 'done' &&
      input.reservationsTotal !== null &&
      input.reservationsDone !== null &&
      input.reservationsDone < input.reservationsTotal);
  if (incompleta) return 'parcial';
  if (input.stale) return 'velho';
  return 'fresco';
}

/** F6.2: `patients` já vem AGREGADO (`AnaCareListPatient[]`, montado por `AnaCareHoursService.getMonthSnapshot`) — esta função só decide `snapshotState`/`stale`, não agrupa turno. */
export function buildSnapshot(
  month: string,
  patients: AnaCareListPatient[],
  retrato: AnaCareRetratoSourceStatus & {
    /** Item 3: `freshness.shifts === 0` — o retrato NUNCA foi sincronizado para este mês (distinto de "sincronizou, mas ficou velho"). Default `false` por compat com chamadores antigos. */
    naoConstruido?: boolean;
  },
  /** F2 (migration 457) — conclusão da corrida para este mês; ausente = `NO_SYNC_RUN_CONCLUSION` (equivalente a `desconhecido`, compat com chamadores antigos/testes que não passam este argumento). */
  conclusion: SyncRunConclusion = NO_SYNC_RUN_CONCLUSION,
): AnaCareMonthSnapshot {
  const naoConstruido = retrato.naoConstruido ?? false;
  const snapshotState = computeSnapshotState({
    naoConstruido,
    stale: retrato.stale,
    syncStatus: conclusion.status,
    reservationsTotal: conclusion.reservationsTotal,
    reservationsDone: conclusion.reservationsDone,
  });
  const snapshot: AnaCareMonthSnapshot = {
    month,
    updatedAt: new Date().toISOString(),
    // Vem da FONTE agora (`AnaCareShiftsSource.getRetratoStatus`) — fase 1 (adapter falso) sempre
    // devolve `{ stale: false, circuitBreakerOpen: false }`; staleness real é do job da fase 2/4
    // (sob PARE do lex). O bloqueio de escrita (`AnaCareHoursService.assertRetratoOk`) lê a MESMA
    // fonte, não este snapshot — as duas camadas convergem porque comem do mesmo `getRetratoStatus`.
    stale: retrato.stale,
    snapshotState,
    circuitBreakerOpen: retrato.circuitBreakerOpen,
    patients,
  };
  // Só sai no wire quando `parcial` E o sync já gravou as duas contagens — nunca um `0` fingido
  // para "sem dado" (ver comentário de `AnaCareMonthSnapshot.reservationsTotal/reservationsDone`).
  if (snapshotState === 'parcial' && conclusion.reservationsTotal !== null && conclusion.reservationsDone !== null) {
    snapshot.reservationsTotal = conclusion.reservationsTotal;
    snapshot.reservationsDone = conclusion.reservationsDone;
  }
  return snapshot;
}

/**
 * change `axonico-envio-rastreavel` (24/09/2026, migration 473) — único tipo de serviço lançado
 * no Axonico a partir desta tela, mesmo hardcode do front (`AxonicoComprobanteHttpService.ts`:
 * `serviceType: 'AT' as const`).
 */
export const AXONICO_SERVICE_TYPE: EnliteServiceType = 'AT';

/**
 * Anexa `axonico` a cada `AnaCareShift` cujo `date` casa com o `serviceDate` de uma tentativa
 * `enviado` do mês (`IAxonicoLancamentoRepository.findSentByDocumentAndMonth`) — mutação IN-PLACE
 * dos turnos já montados por `AnaCareHoursService.buildPatients` (objeto que só a requisição atual
 * enxerga, nunca compartilhado entre requisições). Vários turnos podem cair no MESMO dia
 * (prestadores diferentes) — todos ganham o mesmo `axonico`, porque o lançamento foi feito pelo
 * DIA inteiro, não por turno. `sent.length === 0` (nunca lançado neste mês) é no-op.
 */
export function attachAxonicoToPatient(patient: AnaCarePatient, sent: readonly AxonicoLancamentoSentRecord[]): void {
  if (sent.length === 0) return;
  const byServiceDate = new Map(sent.map((s) => [s.serviceDate, s]));
  for (const provider of patient.providers) {
    for (const shift of provider.shifts) {
      const record = byServiceDate.get(shift.date);
      if (!record) continue;
      shift.axonico = {
        status: 'enviado',
        numeroComprobante: record.numeroComprobante,
        codAutorizacion: record.codAutorizacion,
        sentAt: record.createdAt.toISOString(),
        ...(record.sentBy ? { sentBy: { uid: record.sentBy, displayName: record.sentByName } } : {}),
      };
    }
  }
}

/**
 * A2 (achado do gate `revisao-pr`, 25/09/2026): documento para a CHAVE de busca do Axonico —
 * SEMPRE resolvido, independente da célula `patient_identity:read` (que só filtra o campo EXPOSTO
 * ao front, `AnaCarePatient.documentNumber`, em `AnaCareHoursService.buildPatients`). Antes,
 * `getPatientMonth` só consultava o Axonico quando esse campo gated saía preenchido — sem a
 * célula, o dia perdia `axonico` a cada reload, mesmo já lançado por outra pessoa (o botão
 * "Enviar" reaparecia). Mesma fonte que `resolveRegisteredDocuments` usa (fonte primeiro, fallback
 * no documento REGISTRADO manualmente) — mas o valor NUNCA é devolvido ao chamador, só usado como
 * chave de `findSentByDocumentAndMonth`.
 *
 * R1 (achado do gate, 25/09/2026): o `find` tem de casar `anaCarePatientId === patientId` — antes
 * pegava o 1º turno de `sourceShifts` com `patientDocumentNumber`, qualquer que fosse o paciente.
 * Em produção `sourceShifts` já vem filtrado por paciente (`this.source.listShifts({ month,
 * patientId })`, ver `getPatientMonth`), então o defeito ficava mascarado — só aparece se a fonte
 * um dia devolver turnos de outro paciente na mesma lista.
 */
export async function resolveDocumentNumberForAxonico(
  sourceShifts: readonly SourceShiftDTO[],
  patientId: string,
  patientDocuments: IAnaCarePatientDocumentRepository,
): Promise<string | null> {
  const fromSource = sourceShifts.find((s) => s.anaCarePatientId === patientId && s.patientDocumentNumber)?.patientDocumentNumber;
  if (fromSource) return fromSource;
  const registered = await patientDocuments.findByPatientId(patientId);
  return registered?.documentNumber ?? null;
}
