/**
 * PatientStatusDerivation — a alocação no itinerário deriva o estado do paciente (cadeia Fase 15,
 * quadro A; DX-15.9, DX-15.12).
 *
 * A função pura decide (`derivarEstadoPaciente`); esta classe só lê, conta e move — sempre no
 * `client` da transação do escritor (alocar, encerrar, montar), como a ÚLTIMA escrita dela:
 *   - o sujeito (status travado, país, montado) sai de `PatientStatusDerivationReader`;
 *   - os serviços saem da MESMA leitura do Kanban (`readForPatientWith` — a vaga viva do quadro;
 *     serviço sem vacante viva não conta);
 *   - `cobertas`/`contratadas` são a conta da Fase 7 (`buildServiceCoverages`) na data de operação
 *     do país; a ausência datada não entra na conta;
 *   - move por `movePatientStatus` com `changeSource: 'system'` e o client recebido (nenhum
 *     BEGIN/COMMIT próprio — comitaria a alocação no meio).
 * A recusa da completude (`PatientStatusNotReadyError`) não desfaz a alocação: o estado fica e a
 * recusa vai para `logger.warn` sem PII (molde `VacancyLaunchHook`). Qualquer outro erro propaga.
 * A derivação é incondicional: sem feature flag (D476).
 */
import * as functions from 'firebase-functions';
import type { PoolClient } from 'pg';
import { derivarEstadoPaciente, type ServicoParaDerivar } from '../domain/derivarEstadoPaciente';
import { PatientStatusDerivationReader, type DerivationSubject } from '../infrastructure/PatientStatusDerivationReader';
import { PatientKanbanServicesReader, type KanbanServicesRows } from '../infrastructure/PatientKanbanServicesReader';
import { buildServiceCoverages, operationDateOf } from './itineraryCoverage';
import { movePatientStatus, PatientStatusNotReadyError } from './PatientStatusWriter';

export type DerivationOutcome = 'not_subject' | 'unchanged' | 'moved' | 'not_ready';

export interface PatientStatusDerivationPort {
  run(client: PoolClient, patientId: string, now: Date): Promise<DerivationOutcome>;
}

export interface DerivationSubjectReaderPort {
  readSubjectWith(client: PoolClient, patientId: string): Promise<DerivationSubject | null>;
}

export interface DerivationServicesReaderPort {
  readForPatientWith(client: PoolClient, patientId: string): Promise<KanbanServicesRows | null>;
}

export interface PatientStatusDerivationDeps {
  subjectReader?: DerivationSubjectReaderPort;
  servicesReader?: DerivationServicesReaderPort;
  moveStatus?: typeof movePatientStatus;
}

export class PatientStatusDerivation implements PatientStatusDerivationPort {
  private readonly subjectReader: DerivationSubjectReaderPort;
  private readonly servicesReader: DerivationServicesReaderPort;
  private readonly moveStatus: typeof movePatientStatus;

  constructor(deps: PatientStatusDerivationDeps = {}) {
    this.subjectReader = deps.subjectReader ?? new PatientStatusDerivationReader();
    this.servicesReader = deps.servicesReader ?? new PatientKanbanServicesReader();
    this.moveStatus = deps.moveStatus ?? movePatientStatus;
  }

  async run(client: PoolClient, patientId: string, now: Date): Promise<DerivationOutcome> {
    const subject = await this.subjectReader.readSubjectWith(client, patientId);
    if (!subject) return 'not_subject';

    const rows = (await this.servicesReader.readForPatientWith(client, patientId)) ?? { services: [], slots: [] };
    const asOf = operationDateOf(subject.country, now);
    // 1 item por serviço, na MESMA ordem de `rows.services` (molde `ListKanbanServicesUseCase`).
    const servicos: ServicoParaDerivar[] = buildServiceCoverages(rows, asOf).map((coverage, index) => ({
      temVacanteViva: rows.services[index].liveVacancyId !== null,
      cobertas: coverage.cobertas,
      contratadas: coverage.contratadas.weekly,
    }));

    const alvo = derivarEstadoPaciente({ status: subject.status, montado: subject.montado, servicos });
    if (alvo === null || alvo === subject.status) return 'unchanged';

    try {
      await this.moveStatus(patientId, alvo, { changeSource: 'system' }, client);
      return 'moved';
    } catch (err) {
      if (err instanceof PatientStatusNotReadyError) {
        functions.logger.warn('patient_status.derivation_not_ready', {
          patientId,
          from: subject.status,
          to: alvo,
          code: err.code,
          missing: err.missing,
        });
        return 'not_ready';
      }
      throw err;
    }
  }
}
