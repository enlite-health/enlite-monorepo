-- ============================================================
-- Migration 181: Add job_posting_id to whatsapp_bulk_dispatch_logs
--
-- POR QUE EXISTE
-- --------------
-- Antes desta migration, whatsapp_bulk_dispatch_logs era uma tabela
-- de auditoria worker-scoped: respondia "quem recebeu mensagem X em Z"
-- mas NÃO respondia "essa mensagem foi disparada em contexto de qual
-- vaga". A informação só existia em messaging_outbox (migration 173),
-- e mesmo lá apenas para envios que passam pelo outbox — dispatches
-- síncronos (MessagingController.sendVacancyMatch) não tinham nenhum
-- registro persistente do vínculo dispatch ↔ vaga.
--
-- Adicionar job_posting_id em whatsapp_bulk_dispatch_logs equipara o log
-- de auditoria com a fila (messaging_outbox.job_posting_id), e destrava
-- três consultas que antes exigiam heurística frágil ou eram impossíveis:
--
--   1. Funil da vaga (bug original): aba "Invitados" mostrava status
--      WhatsApp da última mensagem que o worker recebeu em QUALQUER
--      vaga — vazava status entre vagas. Agora o LATERAL JOIN em
--      FunnelTableRepository filtra (worker_id, job_posting_id).
--
--   2. Auditoria por vaga: "todas as mensagens disparadas pros
--      candidatos da vaga X / status de entrega de cada uma" vira
--      query direta sem JOIN frágil via twilio_sid.
--
--   3. Métricas operacionais por vaga: taxa de entrega/leitura/falha
--      por vaga, tempo médio até resposta etc.
--
-- ALTERNATIVAS CONSIDERADAS (e rejeitadas)
-- ----------------------------------------
-- (a) JOIN heurístico messaging_outbox.twilio_sid ↔ wbdl.twilio_sid:
--     só cobre dispatches via outbox; sendVacancyMatch fica de fora.
-- (b) Filtro por template_slug + janela temporal (dispatched_at >=
--     wja.created_at): hardcode de slugs e cenário de re-invite quebra.
--
-- POLÍTICA DE PREENCHIMENTO
-- -------------------------
-- Dispatches vacancy-scoped preenchem a coluna:
--   - OutboxProcessor (propaga de messaging_outbox.job_posting_id)
--   - MessagingController.sendVacancyMatch (do body do request)
--
-- Dispatches NÃO vacancy-scoped ficam NULL — esperado:
--   - MessagingController.sendDirect (envio direto a um número)
--   - BulkDispatchIncompleteWorkersUseCase ("complete seu cadastro")
--   - BulkDispatchTalentumIncompleteUseCase (reminder Talentum)
--
-- BACKFILL
-- --------
-- Logs com twilio_sid são reassociados via messaging_outbox.twilio_sid.
-- Cobertura: dispatches source='outbox'. Dispatches source='individual'
-- anteriores ao fix ficam NULL — não há rastro pra recuperar; limitação
-- conhecida, não pendência.
-- ============================================================

ALTER TABLE whatsapp_bulk_dispatch_logs
  ADD COLUMN IF NOT EXISTS job_posting_id UUID NULL
    REFERENCES job_postings(id) ON DELETE SET NULL;

COMMENT ON COLUMN whatsapp_bulk_dispatch_logs.job_posting_id IS
  'Vaga associada ao dispatch. Preenchido por OutboxProcessor (propaga de messaging_outbox) e MessagingController.sendVacancyMatch. NULL para envios não vacancy-scoped (sendDirect, bulk reminders). Sem essa coluna, o funil da vaga (FunnelTableRepository) vazava status entre vagas, e auditoria/métricas por vaga eram impossíveis sem JOIN frágil via twilio_sid. Detalhes na migration 181.';

-- Índice parcial: o consumidor (FunnelTableRepository) sempre filtra por
-- worker_id + job_posting_id NOT NULL, ordenando por dispatched_at DESC.
CREATE INDEX IF NOT EXISTS idx_wbdl_worker_job_dispatched
  ON whatsapp_bulk_dispatch_logs(worker_id, job_posting_id, dispatched_at DESC)
  WHERE job_posting_id IS NOT NULL;

-- Backfill: recupera job_posting_id histórico via messaging_outbox.twilio_sid.
-- Cobre logs source='outbox' (que sempre passam pelo outbox).
UPDATE whatsapp_bulk_dispatch_logs wbdl
SET job_posting_id = mo.job_posting_id
FROM messaging_outbox mo
WHERE wbdl.twilio_sid IS NOT NULL
  AND wbdl.twilio_sid = mo.twilio_sid
  AND wbdl.job_posting_id IS NULL
  AND mo.job_posting_id IS NOT NULL;
