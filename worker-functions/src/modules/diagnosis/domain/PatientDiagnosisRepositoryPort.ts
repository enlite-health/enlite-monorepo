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
 * 🔧 F5-CORREÇÃO T5 (QA-caça, 05/09/2026) — o SEGUNDO índice único da migration 325
 * (`uq_patient_diagnoses_codigo_ativo_por_origem`, o dedupe por `(patient_id, source,
 * concept_code) WHERE active`) NÃO era mapeado: só o de PRINCIPAL era. Webhook que repete ou
 * duplo clique faziam os dois lados lerem "não há linha ativa" (o dedupe rodava FORA de
 * transação — TOCTOU) e os dois inserirem; o perdedor recebia o `23505` cru e virava
 * **HTTP 500** em vez do 409 `DIAGNOSIS_ALREADY_ACTIVE` que a mesma condição já tinha.
 *
 * Mora no DOMÍNIO pelo mesmo motivo de `PrimaryDiagnosisConflictError`: `application/` precisa
 * capturá-lo sem importar `PostgresPatientDiagnosisRepository` (DIP — o adaptador concreto joga
 * o erro do vocabulário do domínio, nunca o contrário).
 *
 * A trava de verdade é o `pg_advisory_xact_lock` de `lockForPatient` (ver a porta abaixo), que
 * serializa a gravação por paciente e faz o perdedor ENXERGAR a linha do vencedor e devolver
 * `already_active` normalmente. Este erro é defesa em profundidade — o caminho que sobra quando
 * alguém escreve por fora do lock.
 */
export class DuplicateActiveDiagnosisError extends Error {
  constructor(patientId: string) {
    super(`Conceito já ativo para o paciente ${patientId} nesta origem (escrita concorrente)`);
    this.name = 'DuplicateActiveDiagnosisError';
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
   * 🔧 T5 — trava consultiva POR PACIENTE, para a transação corrente. Chamar como PRIMEIRA
   * statement de qualquer transação que decida "existe ou não existe, então escrevo": sem ela o
   * `findActiveByConceptCode` → `create` é um TOCTOU clássico (dois webhooks, ou um duplo
   * clique, leem "não há" ao mesmo tempo e os dois inserem).
   *
   * O padrão (`pg_advisory_xact_lock`) já é o de 6 arquivos de `src/` — inclusive o
   * `demotePrimary` deste mesmo repositório, que passa a delegar aqui em vez de repetir a
   * statement. `_xact_`: solta sozinho no fim da transação, mesmo em erro.
   */
  lockForPatient(patientId: string): Promise<void>;

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
