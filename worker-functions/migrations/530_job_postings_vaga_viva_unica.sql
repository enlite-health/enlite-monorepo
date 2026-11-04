-- 530 — no máximo UMA vaga não apagada por serviço contratado (spec 056 §7, R14). Mesmo predicado do 409
-- SERVICE_ALREADY_RECRUITING (ActivateRecruitmentUseCase). Falha se já houver duplicata (P0.4 conta antes). Idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_postings_vaga_viva_por_servico
  ON job_postings (contracted_service_id)
  WHERE contracted_service_id IS NOT NULL AND deleted_at IS NULL;
COMMENT ON INDEX uq_job_postings_vaga_viva_por_servico IS
  'Spec 056 §7: uma vaga não apagada por serviço (o 409 do foguete é a 1ª trava; esta é a do banco). A reserva da Equipe de Resposta Rápida é contada por serviço.';
