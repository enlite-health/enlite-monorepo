/**
 * SET único da VOLTA de uma vaga DE_BAJA ao status que tinha antes (spec 084 P3): `status_before_baja`, ou 'SEARCHING' se não houver
 * registro. Fonte única: a reativação do serviço (`PatientContractedServiceRepository`) e o vínculo da vaga baixada a um serviço
 * (`LinkExistingVacancyRepository`) restauram pelo MESMO trecho. Retoma o Talentum (PENDING_RESUME) se a vaga tem projeto.
 */
export const RESTORE_FROM_BAJA_SET = `status = COALESCE(status_before_baja, 'SEARCHING'), status_before_baja = NULL,
                talentum_pause_state = CASE WHEN talentum_project_id IS NOT NULL THEN 'PENDING_RESUME' ELSE talentum_pause_state END`;
