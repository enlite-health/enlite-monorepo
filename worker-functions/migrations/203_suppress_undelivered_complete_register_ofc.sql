-- 203_suppress_undelivered_complete_register_ofc.sql
--
-- Limpeza pos-incidente de spam (template `complete_register_ofc`, flag Meta 63049).
-- Suprime em messaging_opt_out (reason='undelivered_cap') os workers da coorte do
-- lembrete que tiveram entrega ruim E NUNCA leram nenhuma mensagem do template:
--   - "nunca chegou"        : chegou=0 e >=1 undelivered                  (~43 workers)
--   - "recebeu mas ignorou" : chegou>=1, >=3 undelivered e read=0         (~158 workers)
-- Total esperado: 201.
--
-- Preserva deliberadamente os 388 workers que LERAM o lembrete (read>=1) -- sao
-- humanos alcancaveis, mesmo com cadastro incompleto. O stage do funil (Talentum)
-- NAO foi usado como criterio: 86% dele e heranca de batch de importacao, nao
-- engajamento real (so 63/589 tiveram movimento de funil fora de lote).
--
-- messaging_opt_out e GLOBAL por worker (corta todos os templates), por isso o
-- corte se restringe a quem nao demonstrou nenhum sinal de alcancabilidade.
--
-- Idempotente: ON CONFLICT (worker_id) DO NOTHING. Self-contained: recalcula o
-- criterio a partir dos logs, entao re-rodar em ambiente sem esses logs insere 0.

BEGIN;

INSERT INTO messaging_opt_out (worker_id, phone, reason, source)
SELECT DISTINCT ON (l.worker_id)
       l.worker_id,
       l.phone,
       'undelivered_cap',
       'undelivered_cleanup'
FROM whatsapp_bulk_dispatch_logs l
JOIN (
  SELECT worker_id
  FROM whatsapp_bulk_dispatch_logs
  WHERE template_slug = 'complete_register_ofc'
  GROUP BY worker_id
  HAVING COUNT(*) FILTER (WHERE delivery_status = 'read') = 0
     AND (
       (    COUNT(*) FILTER (WHERE delivery_status IN ('delivered','read')) = 0
        AND COUNT(*) FILTER (WHERE delivery_status = 'undelivered') >= 1)
       OR
       (    COUNT(*) FILTER (WHERE delivery_status IN ('delivered','read')) >= 1
        AND COUNT(*) FILTER (WHERE delivery_status = 'undelivered') >= 3)
     )
) alvo ON alvo.worker_id = l.worker_id
WHERE l.template_slug = 'complete_register_ofc'
  AND l.phone IS NOT NULL
ORDER BY l.worker_id, l.dispatched_at DESC
ON CONFLICT (worker_id) DO NOTHING;

COMMIT;
