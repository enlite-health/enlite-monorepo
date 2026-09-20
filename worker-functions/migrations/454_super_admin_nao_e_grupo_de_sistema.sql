-- 454 — Super Admin deixa de ser grupo de sistema (spec 021, Bloco 2b, decisão do Gabriel 20/09/2026)
--
-- POR QUÊ: a D124 (19/08, "Os 5 grupos de 17/06 são seed NOSSO derivado de role") já apontava que
-- o Super Admin era um dos "2 dos 5 [que] se autodeclaram placeholder aguardando sign-off que
-- nunca veio" — 41 células, idêntico ao Acesso Master, sem distinção real — e mandava
-- "assinar ou apagar" antes da virada. A 432 (D285/FR-701, 09/09) já tirou `is_system` de
-- Recrutador, Community Manager e Financeiro, mas manteve Acesso Master E Super Admin como os
-- dois únicos grupos de sistema — decisão explicitamente adiada, não fechada.
-- Decisão do Gabriel (20/09/2026), medida em prd hoje (`iam.permission_groups`, 5 grupos vivos):
-- **o ÚNICO grupo `is_system` deve ser o Acesso Master.** O Super Admin (e qualquer outro que
-- ainda esteja marcado) será arquivado por ele, pela tela, para refazer do zero — não por
-- migration. `iam.archive_group` (migration 279, `iam._is_system_context` /
-- `ERRCODE 23514 '[iam] grupo de sistema não pode ser arquivado'`) RECUSA grupo `is_system`; é
-- essa recusa, e só ela, que hoje impede o Gabriel de arquivar o Super Admin pela UI. Medido
-- agora: o Acesso Master tem 5 membros vivos com `permission_management:write` pelo PRÓPRIO
-- Acesso Master (não pelo Super Admin) — remover a flag do Super Admin não tira permissão de
-- ninguém.
--
-- O QUE FAZ: um único `UPDATE` em `iam.permission_groups`, restrito ao id fixo do Super Admin
-- (`a0000000-0000-0000-0000-000000000005`), só onde `is_system` ainda é `true` — idempotente
-- (rodar 2× não muda nada na 2ª) e silencioso se o grupo não existir (base nova, sem o seed 206:
-- o `WHERE` simplesmente não casa nenhuma linha; nenhuma exceção é levantada).
--
-- O QUE NÃO FAZ: não arquiva (`archived_at` continua NULL), não deleta, não muda filiação
-- (`iam.user_groups`), não muda célula concedida (`iam.group_permissions`), não muda país/tenant,
-- não toca em NENHUM outro grupo (Acesso Master incluso). A remoção efetiva do Super Admin é ato
-- exclusivo do Gabriel pela tela (`iam.archive_group`, agora desbloqueado por esta migration) —
-- é isso que a torna reversível e auditável em `iam.permission_group_changes`.
--
-- ROLLBACK: `UPDATE iam.permission_groups SET is_system = true WHERE id =
-- 'a0000000-0000-0000-0000-000000000005'` — reversível sem perda de dado (nenhuma linha morre,
-- só a flag volta).

BEGIN;

UPDATE iam.permission_groups
   SET is_system = false
 WHERE id = 'a0000000-0000-0000-0000-000000000005'
   AND is_system = true;

COMMIT;
