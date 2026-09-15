/**
 * ficha-a1-helper.ts — semeadura para o e2e da entrega A1 (refetch pós-save silencioso +
 * DiscardChangesConfirm no TherapeuticProjectDrawer). Paciente com `sex` inicial conhecido
 * (para provar a troca no card) e um serviço contratado ATIVO (o "Novo +" do projeto terapêutico
 * só habilita com `hasActiveService`, `ProjetoTerapeuticoCard.tsx`). Molde: patient-detail-c-helper.ts.
 */
import { insertTestPatient } from './db-test-helper';
import { runSQL, cleanupPatientDeep } from './patient-detail-a-helper';

export { runSQL, cleanupPatientDeep };

export interface FichaA1Seed {
  patientId: string;
  addressId: string;
  stamp: string;
}

/** Paciente ACTIVE, sexo FEMALE conhecido, 1 endereço, 1 serviço contratado ATIVO. */
export function seedFichaA1Patient(): FichaA1Seed {
  const stamp = Date.now().toString().slice(-6);
  const { patientId, addressId } = insertTestPatient({
    status: 'ACTIVE', firstName: 'FichaA1', lastName: `Refetch${stamp}`,
    withAddress: true,
  });
  if (!addressId) throw new Error('seedFichaA1Patient: insertTestPatient não devolveu addressId');
  // `sex` conhecido para provar a troca no card. `insurance_informed` fica de propósito NULL — o
  // GET faz `COALESCE(insurance_informed, health_insurance_name)` (`PatientDetailQueryHelper.ts`):
  // se a semeadura gravasse `insurance_informed` (o campo legado do ClickUp), o COALESCE nunca
  // deixaria o valor editado pelo painel (`health_insurance_name`, o que o drawer `pcv-name`
  // grava) aparecer no card — medido 15/09, editar "Nombre de la Cobertura" não mudava nada na
  // tela até tirar este UPDATE.
  runSQL(`UPDATE patients SET sex = 'FEMALE' WHERE id = '${patientId}'`);
  runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
          VALUES ('${patientId}', 'AT', true, 'AR', 'e2e-ficha-a1-setup', 'e2e-ficha-a1-setup')`);
  return { patientId, addressId, stamp };
}
