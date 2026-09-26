-- Migration 475: whatsapp_bulk_dispatch_logs.phone deixa de aceitar telefone em claro
--
-- Motivo (change openspec/changes/mensageria-pii-e-retencao): whatsapp_bulk_dispatch_logs.phone
-- guardava E.164 puro — 7.059 linhas em produção, sem necessidade: o dono do produto confirmou
-- que worker_id sozinho é suficiente para acompanhar esses casos (nome/telefone nunca foram
-- consultados por essa coluna). Operação na Argentina, Ley 25.326.
--
-- Decisão: (i) parar de gravar, coluna vira NULL daqui pra frente. NÃO apaga as 7.059 linhas
-- históricas (escrita destrutiva em produção fica fora deste PR — exige autorização nomeada) e
-- NÃO dropa a coluna (manter para não quebrar leitura histórica). Telefone segue derivável por
-- JOIN em workers.phone via worker_id quando houver necessidade legítima.
--
-- CHECK (phone IS NULL) em vez de só tirar o NOT NULL: torna a decisão de "não grava mais
-- telefone em claro" um invariante de banco, não uma convenção de aplicação — qualquer código
-- (deste PR em diante) que tentar voltar a gravar um valor aqui quebra no INSERT, não em code
-- review.
--
-- NOT VALID (achado do gate revisao-pr, 25/09/2026): sem isso, o ADD CONSTRAINT varre as 7.059
-- linhas já existentes com phone preenchido e FALHA — "check constraint ... is violated by some
-- row" — derrubando a migration e, com ela, o boot do serviço em prd (migration é o 1º passo do
-- deploy). NOT VALID pula a validação do que já existe e passa a valer para todo INSERT/UPDATE
-- novo a partir de agora, que é exatamente o invariante que esta migration quer.
--
-- ⚠️ NUNCA rodar `ALTER TABLE whatsapp_bulk_dispatch_logs VALIDATE CONSTRAINT chk_wbdl_phone_null`
-- enquanto as 7.059 linhas históricas com phone preenchido ainda existirem — isso reintroduz
-- EXATAMENTE a mesma falha de boot que o NOT VALID evita aqui. Essas linhas somem sozinhas pela
-- retenção de 365 dias (archive_old_messages(), migration 087) assim que o Cloud Scheduler
-- `messaging_retention` (openspec/changes/mensageria-pii-e-retencao) for aprovado e aplicado —
-- só depois disso VALIDATE CONSTRAINT passa a ser seguro (e nem então é necessário: a constraint
-- já vale para tudo que é novo desde já).

ALTER TABLE whatsapp_bulk_dispatch_logs
  ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE whatsapp_bulk_dispatch_logs
  ADD CONSTRAINT chk_wbdl_phone_null CHECK (phone IS NULL) NOT VALID;

COMMENT ON COLUMN whatsapp_bulk_dispatch_logs.phone IS
  'DEPRECATED — sempre NULL a partir da migration 475 (CHECK ... NOT VALID garante para todo
   INSERT/UPDATE novo). Linhas anteriores a esta migration podem ter E.164 em claro (7.059 linhas
   medidas em 25/09/2026, alcançadas pela retenção de 365 dias de archive_old_messages()) — por
   isso a constraint é NOT VALID: validar contra o histórico derrubaria o boot. NUNCA rodar
   VALIDATE CONSTRAINT enquanto essas linhas existirem. Telefone atual é derivável por JOIN em
   workers.phone via worker_id.';
