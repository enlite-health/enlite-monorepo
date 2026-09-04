/**
 * PatientDiagnosisService — Facade (GoF, spec 016 F2, "Contrato de arquitetura"). PORTA DE
 * ENTRADA ÚNICA da feature: controller e webhook (F4, ClickUp) chamam ESTA classe, nunca os
 * casos de uso individualmente — evita "tela e webhook chamando 4 objetos em ordem certa na fé"
 * (tabela GoF da spec). Não tem lógica própria: cada método delega a UM caso de uso.
 */
import type { TerminologyPort } from '../../terminology/domain/TerminologyPort';
import type { PatientDiagnosis } from '../domain/PatientDiagnosis';
import type { PatientDiagnosisRepositoryPort } from '../domain/PatientDiagnosisRepositoryPort';
import { RecordPatientDiagnosis } from './RecordPatientDiagnosis';
import type { RecordPatientDiagnosisInput, RecordPatientDiagnosisResult } from './RecordPatientDiagnosis';
import { SetPrimaryDiagnosis } from './SetPrimaryDiagnosis';
import type { SetPrimaryDiagnosisResult } from './SetPrimaryDiagnosis';
import { DeactivatePatientDiagnosis } from './DeactivatePatientDiagnosis';
import type { DeactivatePatientDiagnosisResult } from './DeactivatePatientDiagnosis';

export type ListForPatientResult =
  | { readonly found: true; readonly diagnoses: readonly PatientDiagnosis[] }
  | { readonly found: false };

export class PatientDiagnosisService {
  private readonly record: RecordPatientDiagnosis;
  private readonly setPrimaryUseCase: SetPrimaryDiagnosis;
  private readonly deactivateUseCase: DeactivatePatientDiagnosis;

  constructor(
    terminology: TerminologyPort,
    private readonly repo: PatientDiagnosisRepositoryPort,
  ) {
    this.record = new RecordPatientDiagnosis(terminology, repo);
    this.setPrimaryUseCase = new SetPrimaryDiagnosis(repo);
    this.deactivateUseCase = new DeactivatePatientDiagnosis(repo);
  }

  async recordDiagnosis(input: RecordPatientDiagnosisInput): Promise<RecordPatientDiagnosisResult> {
    return this.record.execute(input);
  }

  async setPrimary(patientId: string, diagnosisId: string, actorUid: string): Promise<SetPrimaryDiagnosisResult> {
    return this.setPrimaryUseCase.execute(patientId, diagnosisId, actorUid);
  }

  async deactivate(patientId: string, diagnosisId: string, actorUid: string): Promise<DeactivatePatientDiagnosisResult> {
    return this.deactivateUseCase.execute(patientId, diagnosisId, actorUid);
  }

  async listForPatient(patientId: string): Promise<ListForPatientResult> {
    const exists = await this.repo.patientExists(patientId);
    if (!exists) return { found: false };
    const diagnoses = await this.repo.listForPatient(patientId);
    return { found: true, diagnoses };
  }
}
