-- 479 — o lançamento da vaga (envio à Talentum) tira o paciente do funil de admissão —
-- invariante 7, D434, cadeia Fase 6. As 3 linhas só são usáveis com changeSource = 'vacancy_launch':
-- PatientStatusWriter recusa (422) o mesmo par vindo do Kanban/PUT /status (isLaunchOnlyTransition).
-- Antes desta migration, a saída do funil para SEARCHING era um UPDATE cru no foguete
-- (ActivateRecruitmentUseCase), fora do catálogo.
-- Rollback: migrations/pending/ROLLBACK_479_patient_status_transitions_launch_to_searching.sql.

INSERT INTO patient_status_transitions (from_status, to_status) VALUES
  ('SOLICITANTE',       'SEARCHING'),
  ('ADMISSION',         'SEARCHING'),
  ('PENDING_ADMISSION', 'SEARCHING')
ON CONFLICT (from_status, to_status) DO NOTHING;
