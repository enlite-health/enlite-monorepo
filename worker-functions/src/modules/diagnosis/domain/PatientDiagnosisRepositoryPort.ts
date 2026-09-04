/**
 * PatientDiagnosisRepositoryPort — Repository (GoF) + DIP (spec 016 F2, "Contrato de
 * arquitetura"). `application/` depende SÓ desta interface — nunca de
 * `PostgresPatientDiagnosisRepository` concreta. Nenhum tipo de `pg` aparece aqui.
 *
 * 🔑 ESCOPO DE ORIGEM por CONSTRUTOR, não por `if` (D263): a implementação concreta nasce
 * amarrada a UMA `DiagnosisSource` (`new PostgresPatientDiagnosisRepository(pool,
 * DiagnosisSource.CLICKUP)`) e toda query ganha `AND source = $escopo` — o escritor do ClickUp
 * fica FISICAMENTE incapaz de tocar uma linha PANEL. Este contrato não força a assinatura (a
 * interface não tem `source` em lugar nenhum: quem chama nem sabe que o escopo existe) —
 * a garantia vive na implementação, não na forma da porta.
 *
 * `withTransaction` existe porque o índice parcial único de "um principal por origem"
 * (migration 325) NÃO é DEFERRABLE — trocar de principal exige DUAS statements (rebaixar A,
 * promover B) na ordem certa, na MESMA transação; ver `SetPrimaryDiagnosis`.
 */
import type { PatientDiagnosis } from './PatientDiagnosis';

/**
 * C1 (QA-caça, correções F2) — 8 rodadas de `PATCH {isPrimary:true}` concorrente em dois
 * diagnósticos DIFERENTES do mesmo paciente mediram `{"200":9,"500":7}`: o `23505` do índice
 * parcial único (`uq_patient_diagnoses_primary_por_origem`) escapava como 500 genérico. O
 * `pg_advisory_xact_lock` em `PostgresPatientDiagnosisRepository.demotePrimary` SERIALIZA a
 * troca de principal por paciente e torna este erro, na prática, inatingível pela aplicação em
 * uso normal — fica mapeado aqui como defesa em profundidade (ex.: um `UPDATE` manual via psql
 * que ignore o lock consultivo). Mora no DOMÍNIO (não na infraestrutura) para que
 * `application/` possa capturá-lo sem importar `PostgresPatientDiagnosisRepository` — DIP: o
 * adaptador concreto joga o erro do vocabulário do domínio, nunca o contrário.
 */
export class PrimaryDiagnosisConflictError extends Error {
  constructor(patientId: string) {
    super(`Troca de diagnóstico principal do paciente ${patientId} colidiu com outra escrita concorrente`);
    this.name = 'PrimaryDiagnosisConflictError';
  }
}

/**
 * Sem `terminologySystem` de propósito: quem grava (`RecordPatientDiagnosis`) não sabe qual
 * vocabulário está por trás da porta — só o repositório concreto (infraestrutura, fora da régua
 * do grep desta fase) sabe qual é o único vocabulário aceito hoje pela migration.
 */
export interface NewPatientDiagnosisInput {
  readonly patientId: string;
  readonly conceptUri: string;
  readonly conceptCode: string;
  readonly conceptTitle: string;
  readonly conceptLanguage: 'es' | 'en';
  readonly conceptGroup: string;
  readonly catalogRelease: string;
  readonly isPrimary: boolean;
  readonly actorUid: string;
}

export interface PatientDiagnosisRepositoryPort {
  /** Existe o paciente `patientId`? Base do 404 de paciente inexistente (GET/POST). */
  patientExists(patientId: string): Promise<boolean>;

  create(input: NewPatientDiagnosisInput): Promise<PatientDiagnosis>;

  findById(id: string): Promise<PatientDiagnosis | null>;

  listForPatient(patientId: string): Promise<PatientDiagnosis[]>;

  /** Base do 409 "conceito já ativo nesta origem" — dedupe por CÓDIGO, nunca por URI (ver migration). */
  findActiveByConceptCode(patientId: string, conceptCode: string): Promise<PatientDiagnosis | null>;

  /** Roda `fn` numa única transação; `tx` é uma instância do MESMO escopo de origem. */
  withTransaction<T>(fn: (tx: PatientDiagnosisRepositoryPort) => Promise<T>): Promise<T>;

  /**
   * Rebaixa o principal ATUAL de `patientId` NESTE escopo de origem, se houver. No-op se não
   * houver nenhum. Sem parâmetro de origem: a origem É a do construtor — não dá para pedir a
   * este repositório para rebaixar o principal de outra origem, nem por engano.
   */
  demotePrimary(patientId: string): Promise<void>;

  /** Promove `id` a principal. Chamar só DEPOIS de `demotePrimary` na mesma transação. */
  promotePrimary(id: string, actorUid: string): Promise<PatientDiagnosis>;

  deactivate(id: string, actorUid: string): Promise<PatientDiagnosis>;
}
