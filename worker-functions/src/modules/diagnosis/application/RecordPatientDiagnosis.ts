/**
 * RecordPatientDiagnosis — caso de uso (spec 016 F2, "Contrato de arquitetura"). NÃO sabe que
 * existe uma organização de saúde por trás da porta: recebe `conceptUri` OPACA, chama
 * `TerminologyPort.getByUri()` e copia o que voltou — nunca constrói URI, nunca faz parse de
 * código, nunca nomeia release literal, nunca nomeia o VOCABULÁRIO (isso é decisão só do
 * repositório concreto, fora da régua desta camada), nunca importa de `infrastructure/`. A
 * integridade do dado vem daqui: sem FK para o catálogo de referência (D261/D263), quem garante
 * que `concept_code`/`concept_title`/`concept_group`/`catalog_release` são reais é a PORTA ter
 * resolvido a URI — `concept_not_resolved` é a base do 422 no controller.
 */
import type { TerminologyPort, DiagnosisEntity } from '../../terminology/domain/TerminologyPort';
import type { PatientDiagnosis } from '../domain/PatientDiagnosis';
import {
  DuplicateActiveDiagnosisError,
  PrimaryDiagnosisConflictError,
  type PatientDiagnosisRepositoryPort,
} from '../domain/PatientDiagnosisRepositoryPort';

export interface RecordPatientDiagnosisInput {
  readonly patientId: string;
  readonly conceptUri: string;
  readonly isPrimary?: boolean;
  readonly actorUid: string;
}

export type RecordPatientDiagnosisResult =
  | { readonly outcome: 'created'; readonly diagnosis: PatientDiagnosis }
  | { readonly outcome: 'patient_not_found' }
  | { readonly outcome: 'concept_not_resolved' }
  // C3 (QA-caça): a URI resolve, mas não é uma entidade DIAGNOSTICÁVEL — capítulo (kind='chapter')
  // ou código de extensão (kind='extension'), nunca um fato clínico por si só. A BUSCA já exclui
  // os dois por padrão (IcdCatalogTerminology.search); a ESCRITA repete a regra aqui — sem FK
  // para o catálogo (D261/D263), esta validação NA ESCRITA é a integridade.
  | { readonly outcome: 'not_diagnosable' }
  // C1 (QA-caça): 23505 do índice de principal mapeado — nunca escapa como 500 nem no POST com
  // isPrimary:true (RecordPatientDiagnosis também demote+create na mesma transação).
  | { readonly outcome: 'primary_race' }
  // T5 (QA-caça F5): o MESMO conceito chegou duas vezes ao mesmo tempo e o índice de dedupe
  // (`uq_patient_diagnoses_codigo_ativo_por_origem`) barrou o perdedor. É a MESMA condição do
  // `already_active` — só que descoberta pelo banco, com a transação já abortada, então não há
  // linha em mãos para devolver. O controller traduz os dois para o MESMO 409/código: quem
  // chama não precisa distinguir "achei antes" de "o banco me barrou".
  | { readonly outcome: 'duplicate_race' }
  | { readonly outcome: 'already_active'; readonly diagnosis: PatientDiagnosis };

/**
 * Qual título grava, e em qual idioma — es primeiro, en como fallback (D258: o release corrente
 * tem buracos de tradução, medido na F0). O catálogo de referência garante por CHECK que pelo
 * menos um dos dois existe — este helper nunca precisa lidar com "nenhum dos dois".
 */
function resolveTitle(entity: DiagnosisEntity): { title: string; language: 'es' | 'en' } {
  if (entity.titleEs) return { title: entity.titleEs, language: 'es' };
  return { title: entity.titleEn as string, language: 'en' };
}

export class RecordPatientDiagnosis {
  constructor(
    private readonly terminology: TerminologyPort,
    private readonly repo: PatientDiagnosisRepositoryPort,
  ) {}

  async execute(input: RecordPatientDiagnosisInput): Promise<RecordPatientDiagnosisResult> {
    const patientExists = await this.repo.patientExists(input.patientId);
    if (!patientExists) return { outcome: 'patient_not_found' };

    // Propaga TerminologyUnavailableError em voz alta (US-4) — o controller mapeia para 503.
    const entity = await this.terminology.getByUri(input.conceptUri);
    if (!entity) return { outcome: 'concept_not_resolved' };

    // C3 — só `kind='stem'` vira diagnóstico (cluster pós-coordenado é stem — ver fixtures do
    // adaptador). `chapter` (o capítulo inteiro) e `extension` (código de extensão, ex.: "Plomo")
    // resolvem no catálogo mas não são um fato clínico isolado.
    if (entity.kind !== 'stem') return { outcome: 'not_diagnosable' };

    try {
      return await this.repo.withTransaction((tx) => this.writeUnderLock(tx, input, entity));
    } catch (err) {
      if (err instanceof PrimaryDiagnosisConflictError) return { outcome: 'primary_race' };
      // T5 — o 23505 do dedupe deixa de escapar como 500: é a mesma condição de `already_active`.
      if (err instanceof DuplicateActiveDiagnosisError) return { outcome: 'duplicate_race' };
      throw err;
    }
  }

  /**
   * 🔧 F5-CORREÇÕES T5 e T6 (QA-caça, 05/09/2026) — TUDO o que decide "existe ou não existe,
   * então escrevo" passou para DENTRO de uma transação, atrás do lock consultivo por paciente.
   *
   * T5 (TOCTOU): o dedupe (`findActiveByConceptCode`) rodava FORA de transação e o `create`
   * vinha depois. Webhook que repete, ou duplo clique: os dois lados liam "não há linha ativa",
   * os dois inseriam, e o perdedor tomava o `23505` do segundo índice único da 325 —
   * que ninguém mapeava — como **HTTP 500** em vez de 409. `lockForPatient` serializa a gravação
   * por paciente; o perdedor ENXERGA a linha do vencedor e devolve `already_active`.
   *
   * T6 (ClickUp e banco divergentes PARA SEMPRE): o `return` de `already_active` estava ANTES da
   * reconciliação do principal. `ClickUpDiagnosisMapper` pede SEMPRE `isPrimary: true` (o campo
   * "Tipo de Patología" é seleção única), então a sequência A→B→A ficava assim: (1) A vira
   * principal; (2) B rebaixa A e vira principal — mas A CONTINUA `active`; (3) volta para A →
   * `findActiveByConceptCode` acha A ativa e devolve `already_active` **sem escrever nada**.
   * Fim: o ClickUp diz A, o banco diz que o principal é B, e o log é `info`.
   * Agora `already_active` com `isPrimary: true` RECONCILIA (rebaixa o principal atual, promove
   * a linha que já existe) antes de devolver. O resultado continua sendo `already_active` — do
   * ponto de vista de quem chamou, o conceito de fato já estava ativo, e o 409 do painel não
   * muda; o que muda é o banco parar de divergir do que a origem afirma.
   */
  private async writeUnderLock(
    tx: PatientDiagnosisRepositoryPort,
    input: RecordPatientDiagnosisInput,
    entity: DiagnosisEntity,
  ): Promise<RecordPatientDiagnosisResult> {
    await tx.lockForPatient(input.patientId);

    const wantsPrimary = input.isPrimary ?? false;
    const conceptCode = entity.code.value;

    const existingActive = await tx.findActiveByConceptCode(input.patientId, conceptCode);
    if (existingActive) {
      if (!wantsPrimary || existingActive.isPrimary) {
        return { outcome: 'already_active', diagnosis: existingActive };
      }
      // T6 — mesma reconciliação de `SetPrimaryDiagnosis`, na MESMA transação e no MESMO lock.
      await tx.demotePrimary(input.patientId);
      const promoted = await tx.promotePrimary(existingActive.id, input.actorUid);
      return { outcome: 'already_active', diagnosis: promoted };
    }

    const { chapter } = await this.terminology.ancestorsOf(entity.uri);
    const { title, language } = resolveTitle(entity);

    // O índice parcial único (patient_id, source) WHERE is_primary AND active NÃO é DEFERRABLE
    // (D263) — se já existe um principal ativo nesta origem, o INSERT com is_primary=true
    // estouraria 23505. Rebaixa o atual antes de criar o novo já principal.
    if (wantsPrimary) {
      await tx.demotePrimary(input.patientId);
    }

    const diagnosis = await tx.create({
      patientId: input.patientId,
      conceptUri: entity.uri,
      conceptCode,
      conceptTitle: title,
      conceptLanguage: language,
      conceptGroup: chapter.code,
      catalogRelease: entity.release,
      isPrimary: wantsPrimary,
      actorUid: input.actorUid,
    });
    return { outcome: 'created', diagnosis };
  }
}
