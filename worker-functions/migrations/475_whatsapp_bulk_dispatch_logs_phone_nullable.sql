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

ALTER TABLE whatsapp_bulk_dispatch_logs
  ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE whatsapp_bulk_dispatch_logs
  ADD CONSTRAINT chk_wbdl_phone_null CHECK (phone IS NULL);

COMMENT ON COLUMN whatsapp_bulk_dispatch_logs.phone IS
  'DEPRECATED — sempre NULL a partir da migration 475 (CHECK garante). Linhas anteriores a esta
   migration podem ter E.164 em claro (7.059 linhas medidas em 25/09/2026, alcançadas pela
   retenção de 365 dias de archive_old_messages()). Telefone atual é derivável por JOIN em
   workers.phone via worker_id.';
