-- Migration 187: Remove default and force NOT NULL on application_funnel_stage.
--
-- Motivação: o default 'INITIATED' (setado em migration 097 como decisão técnica,
-- não semântica) permitia INSERTs silenciosos com stage errado. Cada origem deve
-- decidir conscientemente o stage; INSERT sem stage agora falha com erro claro.
--
-- INITIATED tem semântica estrita: worker entrou no WhatsApp Talentum (via webhook
-- subtype=INITIATED) ou drag manual no Kanban. Todos outros caminhos devem usar
-- INVITED (cadastrado, sem evidência de WhatsApp).

ALTER TABLE worker_job_applications
  ALTER COLUMN application_funnel_stage DROP DEFAULT;

-- Antes de SET NOT NULL, garantir que não há rows com NULL hoje (improvável dado
-- que sempre teve default, mas precaução):
UPDATE worker_job_applications
  SET application_funnel_stage = 'INVITED'
  WHERE application_funnel_stage IS NULL;

ALTER TABLE worker_job_applications
  ALTER COLUMN application_funnel_stage SET NOT NULL;

DO $$ BEGIN
  RAISE NOTICE 'Migration 187 done: application_funnel_stage no default, NOT NULL.';
END $$;
