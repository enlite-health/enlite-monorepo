/**
 * SetPrimaryDiagnosis — caso de uso (spec 016 F2, D263). RECONCILIA: rebaixa o principal atual
 * (se houver) e promove o alvo, na MESMA transação — o índice parcial único
 * `uq_patient_diagnoses_primary_por_origem` (migration 325) NÃO é DEFERRABLE, então tem que ser
 * duas statements, na ORDEM certa (rebaixar antes de promover), nunca uma única confiada ao
 * banco. Ver também `PrimaryDiagnosisPolicy` (domain/) — aquela decide qual origem VENCE na
 * TELA quando duas origens têm principal; esta decide qual linha é principal DENTRO de uma
 * origem (a mesma que o repositório está escopado a escrever).
 */
import type { PatientDiagnosis } from '../domain/PatientDiagnosis';
import { PrimaryDiagnosisConflictError, type PatientDiagnosisRepositoryPort } from '../domain/PatientDiagnosisRepositoryPort';

export type SetPrimaryDiagnosisResult =
  | { readonly outcome: 'ok'; readonly diagnosis: PatientDiagnosis }
  | { readonly outcome: 'not_found' }
  // C1 (QA-caça): 'primary_race' é o 23505 do índice parcial mapeado — nunca escapa como 500.
  // Na prática inatingível com o lock consultivo no lugar (defesa em profundidade); ver
  // PrimaryDiagnosisConflictError.
  | { readonly outcome: 'conflict'; readonly reason: 'inactive' | 'primary_race' };

export class SetPrimaryDiagnosis {
  constructor(private readonly repo: PatientDiagnosisRepositoryPort) {}

  async execute(patientId: string, diagnosisId: string, actorUid: string): Promise<SetPrimaryDiagnosisResult> {
    const target = await this.repo.findById(diagnosisId);
    if (!target || !target.belongsToPatient(patientId)) return { outcome: 'not_found' };

    // Mesma invariante de `assertCanBecomePrimary` (PatientDiagnosis) — checada aqui direto no
    // booleano porque a entidade já está em mãos; ver domain/__tests__/PatientDiagnosis.test.ts
    // para a prova de que a entidade RECUSA a mesma coisa quando reconstruída via CHECK.
    if (!target.active) return { outcome: 'conflict', reason: 'inactive' };

    // Idempotente: já é o principal — nada para reconciliar.
    if (target.isPrimary) return { outcome: 'ok', diagnosis: target };

    try {
      const promoted = await this.repo.withTransaction(async (tx) => {
        await tx.demotePrimary(patientId);
        return tx.promotePrimary(diagnosisId, actorUid);
      });
      return { outcome: 'ok', diagnosis: promoted };
    } catch (err) {
      if (err instanceof PrimaryDiagnosisConflictError) return { outcome: 'conflict', reason: 'primary_race' };
      throw err;
    }
  }
}
