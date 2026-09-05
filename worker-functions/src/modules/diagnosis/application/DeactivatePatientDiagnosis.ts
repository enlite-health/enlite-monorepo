/**
 * DeactivatePatientDiagnosis — caso de uso (spec 016 F2). Baixa é `active=false` + `ended_at`,
 * NUNCA DELETE físico — sem rota DELETE (mesmo molde 307/319). Uma 2ª baixa sobre um diagnóstico
 * já inativo é `conflict`, não um no-op silencioso — mesmo raciocínio de `pd_active_ended_coerente`.
 */
import type { PatientDiagnosis } from '../domain/PatientDiagnosis';
import type { PatientDiagnosisRepositoryPort } from '../domain/PatientDiagnosisRepositoryPort';

export type DeactivatePatientDiagnosisResult =
  | { readonly outcome: 'ok'; readonly diagnosis: PatientDiagnosis }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'conflict'; readonly reason: 'already_inactive' };

export class DeactivatePatientDiagnosis {
  constructor(private readonly repo: PatientDiagnosisRepositoryPort) {}

  async execute(patientId: string, diagnosisId: string, actorUid: string): Promise<DeactivatePatientDiagnosisResult> {
    const target = await this.repo.findById(diagnosisId);
    if (!target || !target.belongsToPatient(patientId)) return { outcome: 'not_found' };

    // Mesma invariante de `assertCanDeactivate` (PatientDiagnosis) — checada aqui direto no
    // booleano porque a entidade já está em mãos; evita uma 2ª baixa silenciosa.
    if (!target.active) return { outcome: 'conflict', reason: 'already_inactive' };

    const deactivated = await this.repo.deactivate(diagnosisId, actorUid);
    return { outcome: 'ok', diagnosis: deactivated };
  }
}
