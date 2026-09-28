-- ROLLBACK_482_patient_itinerary_assembly_and_overlap.sql — par de rollback da migration 482
-- (o montado, a folga e a trava de sobreposição do itinerário; DX-11.2, DX-11.3).
--
-- QUANDO USAR: regressão detectada depois do deploy da 482 — decisão de reverter a
-- trava de sobreposição e o log do montado antes de um fix mais específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js`
-- lista `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem
-- numérica — um `483_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida
-- do runner (e2e, boot do Cloud Run, ou `run-migration-prod.sh` batendo em
-- `migrations/` inteira), desfazendo a 482 sem ninguém ter pedido. `migrations/pending/`
-- é o único lugar que o runner ignora (ver `migrations/pending/README.md`) — o arquivo
-- fica escrito, revisado e versionado, mas só roda quando alguém aponta o caminho
-- explicitamente.
--
-- Trava de dado: se já existe QUALQUER linha no montado, o rollback apagaria o log —
-- recusa.
--
-- ORDEM: rodar este ANTES do `ROLLBACK_480_patient_itinerary.sql` — os dois triggers
-- novos (`trg_patient_itinerary_assignment_no_overlap`,
-- `trg_patient_itinerary_slot_key_immutable`) moram nas tabelas que a 480 cria; a 480
-- não pode ser desfeita primeiro.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_482_patient_itinerary_assembly_and_overlap.sql

DO $$
BEGIN
  IF to_regclass('patient_itinerary_assembly') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_itinerary_assembly) > 0 THEN
      RAISE EXCEPTION 'há itinerário marcado como montado — o rollback apagaria o log (OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_patient_itinerary_assignment_no_overlap ON patient_itinerary_assignment;
DROP TRIGGER IF EXISTS trg_patient_itinerary_slot_key_immutable ON patient_itinerary_slot;
DROP FUNCTION IF EXISTS fn_patient_itinerary_assignment_no_overlap();
DROP FUNCTION IF EXISTS fn_patient_itinerary_slot_key_immutable();
DROP FUNCTION IF EXISTS itinerary_min_gap_minutes();
DROP TABLE IF EXISTS patient_itinerary_assembly;
DROP FUNCTION IF EXISTS fn_patient_itinerary_assembly_country_from_patient();
