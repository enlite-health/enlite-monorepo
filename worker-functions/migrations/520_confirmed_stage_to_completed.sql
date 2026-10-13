-- 520 — Sai o estágio "Confirmado" (spec 052, Fase 4): SÓ O DADO. As candidaturas em CONFIRMED vão para COMPLETED e os convites
-- de reserva presos na fila são cancelados. NÃO fecha o CHECK do estágio e NÃO mexe nas tabelas de precedência
-- nem de mensagens por etapa: o fechamento do valor no banco é a migration 521, num segundo PR (regra das duas metades).
--
-- SEM BEGIN/COMMIT: o runner abre a transação por arquivo e grava `schema_migrations` (scripts/run-migrations-docker.js).
--
-- POR QUE ASSIM
--   * Destino cru COMPLETED para todas as linhas, qualquer que tenha sido a etapa anterior (decisão do dono, 13/10/2026): é de onde
--     o evento de enquadre convoca.
--   * Bypass do trigger de worker registrado (mig 229): é consolidação de dado existente, não postulação nova. Sem ele, uma linha
--     de origem `manual` com worker INCOMPLETE_REGISTER abortaria a migration inteira.
--   * Ator `system:migration-520`: o trigger de histórico (mig 169) grava sozinho a linha CONFIRMED → COMPLETED com ele;
--     `reason_category` fica nulo (nenhum dos 14 valores descreve migration).
--   * Não toca em `interview_*` (data, link e resposta ficam como registro do que foi combinado), em `encuadres` nem em
--     `domain_events`. SQL não passa pelo emissor: nenhum evento e nenhum WhatsApp saem.
--   * Convites `qualified_worker_request` ainda `pending` viram `failed` com o motivo no campo `error`. `failed` é o valor que o
--     OutboxProcessor nunca relê (só lê `pending`); com o fluxo de reserva desligado, esses horários não existem mais.
--
-- IDEMPOTENTE: a segunda execução encontra 0 linhas nos dois UPDATEs e não cria histórico.
-- ROLLBACK: migrations/pending/ROLLBACK_520_confirmed_stage_to_completed.sql (só tem sentido junto com a volta do código antigo;
-- os convites cancelados NÃO voltam).

SELECT set_config('app.bypass_registered_guard', 'on', true);
SELECT set_config('app.current_uid', 'system:migration-520', true);

UPDATE worker_job_applications
SET application_funnel_stage = 'COMPLETED'
WHERE application_funnel_stage = 'CONFIRMED';

UPDATE messaging_outbox
SET status = 'failed',
    error = 'cancelled by migration 520: estagio Confirmado removido (spec 052); convite de reserva nao pode mais ser enviado',
    processed_at = NOW()
WHERE template_slug = 'qualified_worker_request'
  AND status = 'pending';

DO $$
DECLARE
  sobrou_estagio INTEGER;
  sobrou_convite INTEGER;
BEGIN
  SELECT COUNT(*) INTO sobrou_estagio FROM worker_job_applications WHERE application_funnel_stage = 'CONFIRMED';
  SELECT COUNT(*) INTO sobrou_convite FROM messaging_outbox WHERE template_slug = 'qualified_worker_request' AND status = 'pending';
  IF sobrou_estagio > 0 OR sobrou_convite > 0 THEN
    RAISE EXCEPTION '520 falhou: % candidatura(s) ainda em CONFIRMED e % convite(s) ainda pending', sobrou_estagio, sobrou_convite;
  END IF;
END $$;
