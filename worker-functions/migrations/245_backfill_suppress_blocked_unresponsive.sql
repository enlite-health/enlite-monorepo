-- 245_backfill_suppress_blocked_unresponsive.sql
--
-- Backfill do incidente 2026-07-10 (parte "PASSADO"): alimenta messaging_opt_out
-- (que o guard do OutboxProcessor já enforce no envio) com quem JÁ demonstrou
-- bloqueio ou desinteresse, pelo critério agressivo decidido pelo dono:
--   reason 'undelivered_cap' : >=2 mensagens 'undelivered' (bloqueio/número morto)
--   reason 'no_response'     : >=2 entregues (delivered/read) E NUNCA engajou no
--                              funil (nenhuma wja fora de 'INVITED', sem applied_at,
--                              sem interview_response)
--
-- Reversível (setar opted_in_at) e rastreável por reason -> dá pra revisar coorte
-- depois. Idempotente (ON CONFLICT DO NOTHING). Self-contained: recalcula dos logs.
-- Prioriza 'undelivered_cap' quando o worker casa nos dois (sinal técnico mais forte).
-- O FUTURO é coberto pelo auto-bloqueio no TwilioWebhookController (mesma lista).

BEGIN;

-- 'no_response' é motivo novo -> estende o CHECK.
ALTER TABLE messaging_opt_out DROP CONSTRAINT IF EXISTS messaging_opt_out_reason_check;
ALTER TABLE messaging_opt_out ADD CONSTRAINT messaging_opt_out_reason_check
  CHECK (reason IN ('user_request', 'admin', 'undelivered_cap', 'no_response'));

WITH agg AS (
  SELECT worker_id,
         COUNT(*) FILTER (WHERE delivery_status = 'undelivered')          AS und,
         COUNT(*) FILTER (WHERE delivery_status IN ('delivered','read'))  AS deliv
  FROM whatsapp_bulk_dispatch_logs
  GROUP BY worker_id
),
engaged AS (
  SELECT DISTINCT worker_id FROM worker_job_applications
  WHERE application_funnel_stage <> 'INVITED'
     OR applied_at IS NOT NULL
     OR interview_response IS NOT NULL
),
alvo AS (
  SELECT a.worker_id,
         CASE WHEN a.und >= 2 THEN 'undelivered_cap' ELSE 'no_response' END AS reason
  FROM agg a
  LEFT JOIN engaged e ON e.worker_id = a.worker_id
  WHERE a.und >= 2
     OR (a.deliv >= 2 AND e.worker_id IS NULL)
),
alvo_phone AS (
  SELECT DISTINCT ON (t.worker_id) t.worker_id, l.phone, t.reason
  FROM alvo t
  JOIN whatsapp_bulk_dispatch_logs l
    ON l.worker_id = t.worker_id AND l.phone IS NOT NULL
  ORDER BY t.worker_id, l.dispatched_at DESC
)
INSERT INTO messaging_opt_out (worker_id, phone, reason, source)
SELECT worker_id, phone, reason, 'incident_backfill_2026_07'
FROM alvo_phone
ON CONFLICT (worker_id) DO NOTHING;

COMMIT;
