/**
 * GetServiceTeamUseCase — quadro C (Servicio Contratado), Fase 10, DX-10.6 (1).
 *
 * `reader.read` → `null` → `ServiceTeamNotFoundError` (o controller mapeia para 404); senão
 * `asOf = operationDateOf(row.country, now)` (data LOCAL do PAÍS, nunca o relógio do processo) →
 * `deriveServiceTeam` (chamada UMA vez — critério "não faça") → nome de exibição por
 * `projectWorkerFields` (`@modules/identity/permissions`, a MESMA projeção do quadro B), UMA vez
 * por prestador DISTINTO das 3 listas (a disjunção por construção de `deriveServiceTeam` garante
 * que o mesmo `workerId` nunca aparece em duas).
 *
 * `name` redigido (`NOME_REDIGIDO`) ou ausente sai `displayName: null` — o front mostra o rótulo
 * i18n de "sem nome"; a regra de redação é a de `projectWorkerFields`, não reimplementada aqui.
 * `cells === null` (engine OFF) é o que a projeção já faz por dentro (D113 — nunca `?? []`, nunca
 * um `if` extra aqui).
 *
 * `vacancyId` no retorno de cada `Member`: a vaga da CANDIDATURA em Selecionado/Em Atendimento
 * (vem de `deriveServiceTeam`); em Rejeitado, `deriveServiceTeam` não carrega vaga (a marca não é
 * por candidatura) — aqui vira a vaga VIVA do serviço.
 *
 * Nada clínico, nenhum telefone/e-mail/documento no retorno: `projectWorkerFields` recebe
 * `phone: null` e só o `name` projetado é lido de volta.
 */
import { ServiceTeamReader, type ServiceTeamRows } from '../infrastructure/ServiceTeamReader';
import { deriveServiceTeam } from '../domain/deriveServiceTeam';
import { operationDateOf } from './itineraryCoverage';
import { projectWorkerFields, NOME_REDIGIDO, type Decryptor } from '@modules/identity/permissions';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

/** Serviço inexistente, de outro paciente, ou fora da RLS. O controller mapeia para 404. */
export class ServiceTeamNotFoundError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
  ) {
    super(`Service team not found: ${serviceId} (patientId=${patientId})`);
    this.name = 'ServiceTeamNotFoundError';
  }
}

export interface ServiceTeamMember {
  workerId: string;
  displayName: string | null;
  vacancyId: string | null;
  reasonCategory?: string;
}

export interface GetServiceTeamResult {
  serviceId: string;
  vacancyId: string | null;
  selected: ServiceTeamMember[];
  inService: ServiceTeamMember[];
  rejected: ServiceTeamMember[];
}

export interface GetServiceTeamInput {
  patientId: string;
  serviceId: string;
  /** `null` = engine de permissão não decidiu nesta request (D113). */
  cells: string[] | null;
  now?: Date;
}

export interface ServiceTeamReaderPort {
  read(patientId: string, serviceId: string): Promise<ServiceTeamRows | null>;
}

interface WorkerNameSource {
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

export class GetServiceTeamUseCase {
  constructor(
    private readonly reader: ServiceTeamReaderPort = new ServiceTeamReader(),
    private readonly kms: Decryptor = new KMSEncryptionService(),
  ) {}

  async execute(input: GetServiceTeamInput): Promise<GetServiceTeamResult> {
    const { patientId, serviceId, cells, now = new Date() } = input;

    const row = await this.reader.read(patientId, serviceId);
    if (row === null) throw new ServiceTeamNotFoundError(patientId, serviceId);

    const asOf = operationDateOf(row.country, now);
    const team = deriveServiceTeam({
      serviceId: row.serviceId,
      liveVacancyId: row.liveVacancyId,
      asOf,
      candidacies: row.candidacies,
      assignments: row.assignments,
      marks: row.marks,
    });

    const displayNameByWorkerId = await this.projectDisplayNames(row, cells);

    return {
      serviceId: row.serviceId,
      vacancyId: row.liveVacancyId,
      selected: team.selected.map((entry) => ({
        workerId: entry.workerId,
        displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
        vacancyId: entry.vacancyId,
      })),
      inService: team.inService.map((entry) => ({
        workerId: entry.workerId,
        displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
        vacancyId: entry.vacancyId,
      })),
      rejected: team.rejected.map((entry) => ({
        workerId: entry.workerId,
        displayName: displayNameByWorkerId.get(entry.workerId) ?? null,
        vacancyId: row.liveVacancyId,
        reasonCategory: entry.reasonCategory,
      })),
    };
  }

  /** UMA projeção por `workerId` distinto das 3 listas — nunca 2× o mesmo prestador. */
  private async projectDisplayNames(
    row: ServiceTeamRows,
    cells: string[] | null,
  ): Promise<Map<string, string | null>> {
    const sourceByWorkerId = new Map<string, WorkerNameSource>();
    for (const list of [row.candidacies, row.assignments, row.marks]) {
      for (const entry of list) {
        if (sourceByWorkerId.has(entry.workerId)) continue;
        sourceByWorkerId.set(entry.workerId, {
          firstNameEncrypted: entry.firstNameEncrypted,
          lastNameEncrypted: entry.lastNameEncrypted,
        });
      }
    }

    const displayNameByWorkerId = new Map<string, string | null>();
    for (const [workerId, source] of sourceByWorkerId) {
      const projected = await projectWorkerFields(
        cells,
        { firstNameEncrypted: source.firstNameEncrypted, lastNameEncrypted: source.lastNameEncrypted, phone: null },
        this.kms,
      );
      const displayName = projected.name && projected.name !== NOME_REDIGIDO ? projected.name : null;
      displayNameByWorkerId.set(workerId, displayName);
    }
    return displayNameByWorkerId;
  }
}
