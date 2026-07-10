-- 246_delete_invited_of_suppressed_workers.sql
--
-- Limpeza do board (incidente 2026-07-10): remove da coluna Invitados as
-- candidaturas de workers que estão na lista de supressão (opt-out / bloqueio /
-- sem-resposta) — eles nunca serão contatados (guard no OutboxProcessor), então
-- ficar em Invitados é só ruído. O MatchmakingService já não gera novas (fix
-- fe16ac9); esta migration limpa as ~1270 antigas.
--
-- Escopo restrito: SÓ estágio 'INVITED' (nunca avançaram). Candidaturas de
-- suprimidos que já postularam/avançaram NÃO são tocadas.
-- Verificado: nenhuma FK referencia worker_job_applications -> DELETE não cascateia.
-- DESTRUTIVO por decisão do dono (preferiu deletar a mover p/ Rechazados).
-- Idempotente: re-rodar deleta 0.

BEGIN;

DELETE FROM worker_job_applications wja
WHERE wja.application_funnel_stage = 'INVITED'
  AND EXISTS (
    SELECT 1 FROM messaging_opt_out moo
    WHERE moo.worker_id = wja.worker_id AND moo.opted_in_at IS NULL
  );

COMMIT;
