/**
 * ItineraryAbsenceUseCase — DX-13.7 (caso de uso) + DX-13.6 (o gate): registra a ausência pontual
 * do titular, põe/tira o substituto e cancela. Molde de injeção `ItineraryAllocationUseCase.ts`
 * (Fase 11): `reader` é o MESMO `ServiceTeamReader` (nenhuma 2ª leitura do time), `writer` é o
 * `ItineraryAbsenceWriter` (P16), `allocationWriter` é o `ItineraryAllocationWriter` (Fase 11,
 * REUSADO — porta com `findAllocation`/`findApplicationId`, nunca copiado), `runInTransaction =
 * inPatientTransaction`.
 *
 * O gate do substituto é `canAllocate` da Fase 11 (DX-13.6, IMPORTADO — nenhuma 2ª definição de
 * Selecionado): `team.selected` sempre aceita; `team.inService` só quando o mesmo prestador AINDA é
 * candidato da vaga viva (Q-13.3, a 2ª data do mesmo substituto). O próprio titular da alocação é
 * recusado pelo BANCO (`piab_substituto_e_o_titular`), nunca checado aqui — 1 lugar só para essa
 * regra.
 *
 * `asOf` é sempre `operationDateOf(row.country, now)` (data LOCAL do país, nunca o relógio do
 * processo) — a mesma fonte de `ItineraryAllocationUseCase`/`GetServiceTeamUseCase`. `team` sai de
 * `deriveServiceTeamFromRows` (nunca `deriveServiceTeam` direto — 2ª definição proibida).
 *
 * Nenhuma escrita na tabela do paciente, em `contracted_service_rejections`, na alocação antiga do
 * card de atendimento (Fase 14) ou em `worker_job_applications` (só leitura, via
 * `allocationWriter.findApplicationId`, REUSADO). A ausência não move nada fora dela mesma
 * (invariantes 3/9).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from './patientTransaction';
import { operationDateOf } from './itineraryCoverage';
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { ItineraryAbsenceWriter, type InsertAbsenceInput, type InsertedAbsence, type AbsenceRow } from '../infrastructure/ItineraryAbsenceWriter';
import { ItineraryAllocationWriter, type AllocationRow } from '../infrastructure/ItineraryAllocationWriter';
import { deriveServiceTeamFromRows } from './serviceTeamPresentation';
import { canAllocate } from '../domain/itineraryAllocationGate';
import { fromPgError, type PgOverlapLikeError } from '../domain/itineraryOverlap';
import { NotSelectedForServiceError, AllocationNotFoundError, AllocationNotActiveError } from './ItineraryAllocationUseCase';

/** Ausência inexistente, ou não pertence a este serviço/paciente — o controller mapeia para 404. */
export class AbsenceNotFoundError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
    readonly absenceId: string,
  ) {
    super(`Itinerary absence not found: ${absenceId} (serviceId=${serviceId}, patientId=${patientId})`);
    this.name = 'AbsenceNotFoundError';
  }
}

/** Ausência já cancelada — não aceita substituto novo nem cancelar de novo. */
export class AbsenceCancelledError extends Error {
  constructor(readonly absenceId: string) {
    super(`Itinerary absence is cancelled: ${absenceId}`);
    this.name = 'AbsenceCancelledError';
  }
}

/** A ausência nasce para hoje ou depois — a passada é SEMENTE por SQL (DX-13.15, critério 10). */
export class AbsenceDateInPastError extends Error {
  constructor(
    readonly allocationId: string,
    readonly date: string,
  ) {
    super(`Absence date is in the past: ${date} (allocationId=${allocationId})`);
    this.name = 'AbsenceDateInPastError';
  }
}

/** Corrida no índice `uq_piab_open` (23505): já há uma ausência aberta nesta alocação/data. */
export class AbsenceAlreadyExistsError extends Error {
  constructor(
    readonly allocationId: string,
    readonly date: string,
  ) {
    super(`An open absence already exists for this allocation/date: ${date} (allocationId=${allocationId})`);
    this.name = 'AbsenceAlreadyExistsError';
  }
}

/** `piab_dia_da_semana` (23514): a data não cai no dia da semana do slot da alocação. */
export class AbsenceWeekdayMismatchError extends Error {
  constructor(
    readonly allocationId: string,
    readonly date: string,
  ) {
    super(`Absence date does not match the allocation's slot weekday: ${date} (allocationId=${allocationId})`);
    this.name = 'AbsenceWeekdayMismatchError';
  }
}

/** `piab_fora_da_vigencia` (23514): a data cai fora de `valid_from`/`valid_to` da alocação. */
export class AbsenceOutsideAllocationError extends Error {
  constructor(
    readonly allocationId: string,
    readonly date: string,
  ) {
    super(`Absence date is outside the allocation's validity: ${date} (allocationId=${allocationId})`);
    this.name = 'AbsenceOutsideAllocationError';
  }
}

/** `piab_substituto_e_o_titular` (23514): o substituto é o mesmo prestador titular da alocação. */
export class SubstituteIsTitularError extends Error {
  constructor(
    readonly allocationId: string,
    readonly date: string,
  ) {
    super(`Substitute cannot be the allocation's own titular (allocationId=${allocationId}, date=${date})`);
    this.name = 'SubstituteIsTitularError';
  }
}

export interface ItineraryAbsenceReaderPort {
  readWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceTeamRows | null>;
}

export interface ItineraryAbsenceWriterPort {
  insertAbsence(client: PoolClient, input: InsertAbsenceInput): Promise<InsertedAbsence>;
  findAbsence(client: PoolClient, patientId: string, serviceId: string, absenceId: string): Promise<AbsenceRow | null>;
  updateSubstitute(
    client: PoolClient,
    id: string,
    substituteWorkerId: string | null,
    substituteApplicationId: string | null,
    actorUid: string,
  ): Promise<number>;
  cancelAbsence(client: PoolClient, id: string, actorUid: string): Promise<number>;
}

export interface ItineraryAbsenceAllocationPort {
  findAllocation(client: PoolClient, patientId: string, serviceId: string, allocationId: string): Promise<AllocationRow | null>;
  findApplicationId(client: PoolClient, workerId: string, vacancyId: string): Promise<string | null>;
}

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface ItineraryAbsenceRegisterInput {
  patientId: string;
  serviceId: string;
  allocationId: string;
  date: string;
  substituteWorkerId?: string | null;
  actorUid: string;
  now?: Date;
}

export interface ItineraryAbsenceSetSubstituteInput {
  patientId: string;
  serviceId: string;
  absenceId: string;
  substituteWorkerId: string | null;
  actorUid: string;
  now?: Date;
}

export interface ItineraryAbsenceCancelInput {
  patientId: string;
  serviceId: string;
  absenceId: string;
  actorUid: string;
}

export interface ItineraryAbsenceResult {
  absenceId: string;
  allocationId: string;
  date: string;
  substituteWorkerId: string | null;
  status: 'OPEN' | 'CANCELLED';
}

/**
 * Decodifica o erro do banco na classe certa (função pura, sem estado) — `fromPgError` primeiro (o
 * 23P01 da trava de sobreposição, DX-13.2, reusado sem mudança), depois os 23505/23514 específicos
 * da ausência. Qualquer outro código/constraint/mensagem → `null` (quem chama relança o original).
 */
function absenceErrorFromPg(err: unknown, allocationId: string, date: string): Error | null {
  const overlap = fromPgError(err as PgOverlapLikeError);
  if (overlap !== null) return overlap;

  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505' && e.constraint === 'uq_piab_open') return new AbsenceAlreadyExistsError(allocationId, date);
  if (e.code === '23514' && e.message === 'piab_dia_da_semana') return new AbsenceWeekdayMismatchError(allocationId, date);
  if (e.code === '23514' && e.message === 'piab_fora_da_vigencia') return new AbsenceOutsideAllocationError(allocationId, date);
  if (e.code === '23514' && e.message === 'piab_substituto_e_o_titular') return new SubstituteIsTitularError(allocationId, date);
  return null;
}

export class ItineraryAbsenceUseCase {
  constructor(
    private readonly reader: ItineraryAbsenceReaderPort = new ServiceTeamReader(),
    private readonly writer: ItineraryAbsenceWriterPort = new ItineraryAbsenceWriter(),
    private readonly allocationWriter: ItineraryAbsenceAllocationPort = new ItineraryAllocationWriter(),
    private readonly runInTransaction: TransactionRunner = inPatientTransaction,
  ) {}

  /** Só o gate + `findApplicationId` quando HÁ substituto — sem substituto, os 2 campos gravam `null`. */
  private async substituteApplicationFor(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    row: ServiceTeamRows,
    substituteWorkerId: string,
    now: Date,
  ): Promise<string> {
    const team = deriveServiceTeamFromRows(row, now);
    const candidacyIds = new Set(row.candidacies.map((c) => c.workerId));
    if (!canAllocate(team, candidacyIds, substituteWorkerId)) {
      throw new NotSelectedForServiceError(patientId, serviceId, substituteWorkerId);
    }
    if (row.liveVacancyId === null) throw new NotSelectedForServiceError(patientId, serviceId, substituteWorkerId);

    const applicationId = await this.allocationWriter.findApplicationId(client, substituteWorkerId, row.liveVacancyId);
    if (applicationId === null) throw new NotSelectedForServiceError(patientId, serviceId, substituteWorkerId);
    return applicationId;
  }

  async register(input: ItineraryAbsenceRegisterInput): Promise<ItineraryAbsenceResult> {
    const { patientId, serviceId, allocationId, date, substituteWorkerId = null, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const allocation = await this.allocationWriter.findAllocation(client, patientId, serviceId, allocationId);
      if (allocation === null) throw new AllocationNotFoundError(patientId, serviceId, allocationId);
      if (allocation.status !== 'ACTIVE') throw new AllocationNotActiveError(allocationId);

      const row = await this.reader.readWith(client, patientId, serviceId);
      if (row === null) throw new AllocationNotFoundError(patientId, serviceId, allocationId);

      const asOf = operationDateOf(row.country, now);
      if (date < asOf) throw new AbsenceDateInPastError(allocationId, date);

      const substituteApplicationId =
        substituteWorkerId === null ? null : await this.substituteApplicationFor(client, patientId, serviceId, row, substituteWorkerId, now);

      try {
        const inserted = await this.writer.insertAbsence(client, { allocationId, date, substituteWorkerId, substituteApplicationId, actorUid });
        return { absenceId: inserted.id, allocationId, date: inserted.date, substituteWorkerId, status: 'OPEN' as const };
      } catch (err) {
        const mapped = absenceErrorFromPg(err, allocationId, date);
        throw mapped ?? err;
      }
    });
  }

  /** `substituteWorkerId: null` tira o substituto (o dia volta a ser alerta) — sem gate, sem candidatura. */
  async setSubstitute(input: ItineraryAbsenceSetSubstituteInput): Promise<ItineraryAbsenceResult> {
    const { patientId, serviceId, absenceId, substituteWorkerId, actorUid, now = new Date() } = input;
    return this.runInTransaction(async (client) => {
      const absence = await this.writer.findAbsence(client, patientId, serviceId, absenceId);
      if (absence === null) throw new AbsenceNotFoundError(patientId, serviceId, absenceId);
      if (absence.cancelled) throw new AbsenceCancelledError(absenceId);

      const row = await this.reader.readWith(client, patientId, serviceId);
      if (row === null) throw new AbsenceNotFoundError(patientId, serviceId, absenceId);

      const asOf = operationDateOf(row.country, now);
      if (absence.date < asOf) throw new AbsenceDateInPastError(absence.allocationId, absence.date);

      const substituteApplicationId =
        substituteWorkerId === null ? null : await this.substituteApplicationFor(client, patientId, serviceId, row, substituteWorkerId, now);

      try {
        const rowCount = await this.writer.updateSubstitute(client, absenceId, substituteWorkerId, substituteApplicationId, actorUid);
        if (rowCount === 0) throw new AbsenceCancelledError(absenceId);
      } catch (err) {
        if (err instanceof AbsenceCancelledError) throw err;
        const mapped = absenceErrorFromPg(err, absence.allocationId, absence.date);
        throw mapped ?? err;
      }

      return { absenceId, allocationId: absence.allocationId, date: absence.date, substituteWorkerId, status: 'OPEN' as const };
    });
  }

  async cancel(input: ItineraryAbsenceCancelInput): Promise<ItineraryAbsenceResult> {
    const { patientId, serviceId, absenceId, actorUid } = input;
    return this.runInTransaction(async (client) => {
      const absence = await this.writer.findAbsence(client, patientId, serviceId, absenceId);
      if (absence === null) throw new AbsenceNotFoundError(patientId, serviceId, absenceId);
      if (absence.cancelled) throw new AbsenceCancelledError(absenceId);

      // Achado C4 (veredito parcial-1): `rowCount` do UPDATE era ignorado — uma corrida de 2
      // cancelamentos concorrentes devolvia 200 CANCELLED nos dois. `cancelAbsence` tem
      // `cancelled_at IS NULL` no WHERE (`ItineraryAbsenceWriter.ts:13-14`): `rowCount === 0` é a
      // MESMA corrida que `setSubstitute` já trata (linha 258-259) — reusa o MESMO
      // `AbsenceCancelledError`, nunca uma 2ª classe de erro para o mesmo caso.
      const rowCount = await this.writer.cancelAbsence(client, absenceId, actorUid);
      if (rowCount === 0) throw new AbsenceCancelledError(absenceId);

      return { absenceId, allocationId: absence.allocationId, date: absence.date, substituteWorkerId: absence.substituteWorkerId, status: 'CANCELLED' as const };
    });
  }
}
