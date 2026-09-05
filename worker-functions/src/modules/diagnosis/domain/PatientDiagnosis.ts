/**
 * PatientDiagnosis — Entity (spec 016 F2, D263). Invariantes da LINHA de `patient_diagnoses`,
 * espelhando os CHECKs da migration 325 (defesa em profundidade: o mesmo erro fica tipado e
 * legível AQUI, antes de virar 23514 cru do Postgres). Reusa `IcdCode` (módulo `terminology`) —
 * "reuse, não duplique" (Contrato de arquitetura).
 */
import type { IcdCode } from '../../terminology/domain/IcdCode';
import type { DiagnosisSource } from './DiagnosisSource';

/**
 * Vocabulário da linha, opaco no domínio (regra dura da spec: caso de uso/domínio nunca nomeia
 * o vocabulário literal — só a migration e o repositório sabem qual é o único aceito hoje).
 */
export type TerminologySystem = string;
export type ConceptLanguage = 'es' | 'en';
export type Country = 'AR' | 'BR';

export class InvalidPatientDiagnosisStateError extends Error {
  constructor(reason: string) {
    super(`Estado inválido de PatientDiagnosis: ${reason}`);
    this.name = 'InvalidPatientDiagnosisStateError';
  }
}

/** Lançado ao tentar promover a principal ou desativar de novo um diagnóstico já inativo. */
export class DiagnosisNotActiveError extends Error {
  constructor(id: string) {
    super(`Diagnóstico ${id} não está ativo`);
    this.name = 'DiagnosisNotActiveError';
  }
}

export interface PatientDiagnosisProps {
  readonly id: string;
  readonly patientId: string;
  readonly terminologySystem: TerminologySystem;
  readonly conceptUri: string;
  readonly conceptCode: IcdCode;
  readonly conceptTitle: string;
  readonly conceptLanguage: ConceptLanguage;
  readonly conceptGroup: string;
  readonly catalogRelease: string;
  readonly source: DiagnosisSource;
  readonly isPrimary: boolean;
  readonly active: boolean;
  readonly endedAt: Date | null;
  readonly country: Country;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class PatientDiagnosis {
  private constructor(private readonly props: PatientDiagnosisProps) {}

  /**
   * Reconstrói a partir de dados já persistidos (ou prestes a ser persistidos) — valida as
   * MESMAS duas invariantes que a migration 325 impõe por CHECK, para que o erro apareça tipado
   * antes de qualquer INSERT/UPDATE, não só como 23514 cru.
   */
  static reconstruct(props: PatientDiagnosisProps): PatientDiagnosis {
    const activeEndedCoherent = (props.active && props.endedAt === null) || (!props.active && props.endedAt !== null);
    if (!activeEndedCoherent) {
      throw new InvalidPatientDiagnosisStateError(
        'active e endedAt incoerentes (mesma regra de pd_active_ended_coerente)',
      );
    }
    if (props.isPrimary && !props.active) {
      throw new InvalidPatientDiagnosisStateError(
        'isPrimary=true com active=false (mesma regra de pd_primary_so_se_ativo)',
      );
    }
    return new PatientDiagnosis(props);
  }

  get id(): string {
    return this.props.id;
  }
  get patientId(): string {
    return this.props.patientId;
  }
  get terminologySystem(): TerminologySystem {
    return this.props.terminologySystem;
  }
  get conceptUri(): string {
    return this.props.conceptUri;
  }
  get conceptCode(): IcdCode {
    return this.props.conceptCode;
  }
  get conceptTitle(): string {
    return this.props.conceptTitle;
  }
  get conceptLanguage(): ConceptLanguage {
    return this.props.conceptLanguage;
  }
  get conceptGroup(): string {
    return this.props.conceptGroup;
  }
  get catalogRelease(): string {
    return this.props.catalogRelease;
  }
  get source(): DiagnosisSource {
    return this.props.source;
  }
  get isPrimary(): boolean {
    return this.props.isPrimary;
  }
  get active(): boolean {
    return this.props.active;
  }
  get endedAt(): Date | null {
    return this.props.endedAt;
  }
  get country(): Country {
    return this.props.country;
  }
  get createdBy(): string {
    return this.props.createdBy;
  }
  get updatedBy(): string {
    return this.props.updatedBy;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /** Base do 404 cross-patient (`:id`/`:did` de rotas diferentes) nos casos de uso. */
  belongsToPatient(patientId: string): boolean {
    return this.props.patientId === patientId;
  }

  /** Índice parcial não é DEFERRABLE (D263) — o caso de uso confere ANTES de tentar promover. */
  assertCanBecomePrimary(): void {
    if (!this.active) throw new DiagnosisNotActiveError(this.id);
  }

  /** Evita uma 2ª baixa silenciosa (idempotência explícita, não implícita) — mesmo raciocínio de `pd_active_ended_coerente`. */
  assertCanDeactivate(): void {
    if (!this.active) throw new DiagnosisNotActiveError(this.id);
  }
}
