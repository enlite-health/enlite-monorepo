-- 428 — remove funil→ACTIVE de `patient_status_transitions` (spec 018, PR-6, ADR-5).
--
-- A 315 semeou 3 linhas que deixavam `PUT /patients/:id/status` mover SOLICITANTE/ADMISSION/
-- PENDING_ADMISSION direto para ACTIVE — era o caminho do botão "Activar paciente" e do drop na
-- coluna "Activo" do Kanban. A partir deste PR essa transição não existe mais: ativar é
-- `POST /patients/:id/contracted-services/:sid/activate-recruitment` (por SERVIÇO, sem tocar em
-- `patients.status` além de SEARCHING) seguido, depois, de `PUT /status` SEARCHING→ACTIVE (3º
-- momento, checklist `SCHEDULE_REQUIRED_STATUSES`).
--
-- Sem esta migration o catálogo continuaria aceitando o pulo direto funil→ACTIVE mesmo com a rota
-- e o front fechados neste PR — outro caller (script, seed, migração de dado futura) ainda
-- conseguiria fazer `PUT /status` aceitar o que a UI já não oferece.
--
-- Catálogo sem dado pessoal (confirmado no plano do PR-6: não está na lista de PRs que exigem
-- parecer do `lex`) — só remove 3 linhas de uma tabela de regras.
--
-- Rollback: reinserir as 3 linhas —
--   INSERT INTO patient_status_transitions (from_status, to_status) VALUES
--     ('SOLICITANTE',       'ACTIVE'),
--     ('ADMISSION',         'ACTIVE'),
--     ('PENDING_ADMISSION', 'ACTIVE')
--   ON CONFLICT (from_status, to_status) DO NOTHING;

DELETE FROM patient_status_transitions
 WHERE (from_status, to_status) IN (
   ('SOLICITANTE',       'ACTIVE'),
   ('ADMISSION',         'ACTIVE'),
   ('PENDING_ADMISSION', 'ACTIVE')
 );
