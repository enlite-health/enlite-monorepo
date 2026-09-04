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
import type { PatientDiagnosisRepositoryPort } from '../domain/PatientDiagnosisRepositoryPort';

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
    // já principal, na MESMA transação.
    const diagnosis = input.isPrimary
      ? await this.repo.withTransaction(async (tx) => {
          await tx.demotePrimary(input.patientId);
          return tx.create(newDiagnosis);
        })
      : await this.repo.create(newDiagnosis);

    return { outcome: 'created', diagnosis };
  }
}
