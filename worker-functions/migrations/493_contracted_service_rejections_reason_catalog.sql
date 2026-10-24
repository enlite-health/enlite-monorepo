-- Migration 493: a marca de rejeição do encuadre passa a apontar para o catálogo de motivos
-- (change itinerario-trocas-motivos-e-figma, Fase 2, design D2).
--
-- `contracted_service_rejections.reject_reason_category` continua TEXT NOT NULL (load-bearing, 481) e
-- troca o CHECK de 4 códigos fixos (`csr_reject_reason_check`) por FK para `service_exit_reasons(code)`
-- (492). Toda marca existente satisfaz a FK: o CHECK antigo só admitia os 4 códigos que a 492 carrega
-- como linhas do catálogo. O CHECK do motivo de REVERTER (`csr_revert_reason_check`) FICA — reverter
-- responde "por que volta", outra pergunta. Desativar um item do catálogo não apaga nada: a FK só
-- confere existência; a checagem de "ativo" é do caso de uso.
--
-- Idempotente (2×): DROP CONSTRAINT IF EXISTS antes de cada ADD. Sem BEGIN/COMMIT próprio.
-- Rollback: `migrations/pending/ROLLBACK_493_contracted_service_rejections_reason_catalog.sql`
-- (recusa se houver marca com código fora dos 4 antigos).

ALTER TABLE contracted_service_rejections DROP CONSTRAINT IF EXISTS csr_reject_reason_check;
ALTER TABLE contracted_service_rejections DROP CONSTRAINT IF EXISTS csr_reject_reason_fk;
ALTER TABLE contracted_service_rejections
  ADD CONSTRAINT csr_reject_reason_fk
  FOREIGN KEY (reject_reason_category) REFERENCES service_exit_reasons(code);
