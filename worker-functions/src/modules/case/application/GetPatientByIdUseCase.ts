import { PatientQueryRepository } from '../infrastructure/PatientQueryRepository';
import type { PatientDetailRow } from '../infrastructure/PatientQueryRepository';
import { ALL_PATIENT_CONTAINERS_READABLE, type PatientContainerReads } from './patientContainerAccess';

export interface GetPatientByIdResult {
  found: true;
  patient: PatientDetailRow;
}

export interface GetPatientByIdNotFound {
  found: false;
}

export type GetPatientByIdOutput = GetPatientByIdResult | GetPatientByIdNotFound;

/**
 * GetPatientByIdUseCase — retrieves full patient detail by UUID.
 *
 * Delegates ALL data access to PatientQueryRepository.
 * Contains zero business logic — only orchestration.
 *
 * Used by: AdminPatientsController.getPatientById
 */
export class GetPatientByIdUseCase {
  private readonly repo: PatientQueryRepository;

  constructor(repo?: PatientQueryRepository) {
    this.repo = repo ?? new PatientQueryRepository();
  }

  /**
   * `requestNow` é capturado AQUI, uma vez por abertura de ficha (spec 058 §H): dele sai o `asOf` (dia de operação do país do paciente)
   * que pagador, preço, imposto e divergência dos serviços usam — a ficha inteira responde "hoje" pelo mesmo relógio.
   */
  async execute(
    id: string,
    reads: PatientContainerReads = ALL_PATIENT_CONTAINERS_READABLE,
    requestNow: Date = new Date(),
  ): Promise<GetPatientByIdOutput> {
    const patient = await this.repo.findDetailById(id, reads, requestNow);

    if (patient === null) {
      return { found: false };
    }

    return { found: true, patient };
  }
}
