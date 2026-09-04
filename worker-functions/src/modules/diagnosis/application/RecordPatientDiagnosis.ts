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
import { PrimaryDiagnosisConflictError, type PatientDiagnosisRepositoryPort } from '../domain/PatientDiagnosisRepositoryPort';

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

    const conceptCode = entity.code.value;
    const existingActive = await this.repo.findActiveByConceptCode(input.patientId, conceptCode);
    if (existingActive) return { outcome: 'already_active', diagnosis: existingActive };

    const { chapter } = await this.terminology.ancestorsOf(entity.uri, entity.release);
    const { title, language } = resolveTitle(entity);

    const newDiagnosis = {
      patientId: input.patientId,
      conceptUri: entity.uri,
      conceptCode,
      conceptTitle: title,
      conceptLanguage: language,
      conceptGroup: chapter.code,
      catalogRelease: entity.release,
      isPrimary: input.isPrimary ?? false,
      actorUid: input.actorUid,
    };

    // O índice parcial único (patient_id, source) WHERE is_primary AND active NÃO é DEFERRABLE
    // (D263) — se já existe um principal ativo nesta origem, o INSERT com is_primary=true
    // estouraria 23505. Mesma reconciliação de SetPrimaryDiagnosis: rebaixa o atual, cria o novo
    // já principal, na MESMA transação (e no MESMO lock consultivo por paciente — C1).
    try {
      const diagnosis = input.isPrimary
        ? await this.repo.withTransaction(async (tx) => {
            await tx.demotePrimary(input.patientId);
            return tx.create(newDiagnosis);
          })
        : await this.repo.create(newDiagnosis);

      return { outcome: 'created', diagnosis };
    } catch (err) {
      if (err instanceof PrimaryDiagnosisConflictError) return { outcome: 'primary_race' };
      throw err;
    }
  }
}
