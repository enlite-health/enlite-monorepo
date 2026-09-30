-- ROLLBACK_493_contracted_service_rejections_reason_catalog.sql — par de rollback da migration 493
-- (marca de rejeição do encuadre apontando para o catálogo de motivos, change itinerario-trocas-motivos-e-figma, Fase 2).
--
-- Mora em `migrations/pending/` (sem número): o runner só lê `migrations/` sem recursão. Só roda quando
-- alguém aponta o caminho explicitamente:
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_493_contracted_service_rejections_reason_catalog.sql
--
-- Trava de dado: recriar o CHECK de 4 códigos falharia (ou mascararia) se já existir marca com código
-- criado pelo admin no catálogo — recusa.

DO $$
DECLARE
  v_fora INT;
BEGIN
  IF to_regclass('public.contracted_service_rejections') IS NOT NULL THEN
    SELECT count(*) INTO v_fora
      FROM contracted_service_rejections
     WHERE reject_reason_category NOT IN
       ('PERFIL_INADEQUADO_AO_SERVICO', 'INDISPONIBILIDADE_DE_HORARIO', 'DESISTENCIA_DO_PRESTADOR', 'OTHER');
    IF v_fora > 0 THEN
      RAISE EXCEPTION 'há % marca(s) com código de motivo fora dos 4 antigos — o rollback as invalidaria (OK do Gabriel antes)', v_fora;
    END IF;
  END IF;
END $$;

ALTER TABLE contracted_service_rejections DROP CONSTRAINT IF EXISTS csr_reject_reason_fk;
ALTER TABLE contracted_service_rejections DROP CONSTRAINT IF EXISTS csr_reject_reason_check;
ALTER TABLE contracted_service_rejections
  ADD CONSTRAINT csr_reject_reason_check CHECK (
    reject_reason_category IN ('PERFIL_INADEQUADO_AO_SERVICO', 'INDISPONIBILIDADE_DE_HORARIO', 'DESISTENCIA_DO_PRESTADOR', 'OTHER')
  );
