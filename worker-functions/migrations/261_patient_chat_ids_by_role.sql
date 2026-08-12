BEGIN;

-- ================================================================
-- Migration 261: chat IDs do paciente POR PAPEL (expand da 260)
-- ================================================================
-- Contexto (ClickUp 86ajy1jhz): a 260 subiu com DUAS colunas fixas em
-- `patients` (`family_chat_id` / `providers_chat_id`), porque na call de 05/08 o
-- Marcel foi categórico: "deixa fixo, sempre vai ser um família e um prestador".
-- Horas depois do deploy ele mandou áudio dizendo o contrário:
--
--   "Cada paciente tem PELO MENOS dois chat IDs... e se temos mais o chat ID do
--    plano de saúde, que é um terceiro, ou de gestão."
--
-- "Pelo menos" mata a forma fixa. A base está ZERADA (0 pacientes vinculados,
-- verificado em produção em 08/08/2026), então este é o momento mais barato
-- possível de trocar a forma.
--
-- ⚠️ ESTA É A METADE "EXPAND" DO EXPAND/CONTRACT.
-- As colunas `patients.family_chat_id` / `patients.providers_chat_id` CONTINUAM
-- existindo e NÃO são derrubadas aqui. `GET /patients/:id` seleciona essas
-- colunas para TODO paciente — derrubá-las com a revisão anterior ainda servindo
-- é 500 em produção. A migration de CONTRACT está escrita e documentada em
-- `migrations/pending/` (fora do alcance do runner), para rodar DEPOIS do deploy
-- desta confirmado.
--
-- DECISÕES:
--
--   (a) TABELA DE VÍNCULOS, uma linha por (paciente, papel). Somar um papel novo
--       (ex.: "de gestão", que o Marcel citou solto) passa a ser INSERT de
--       dados, nunca ALTER TABLE.
--
--   (b) `role` é VARCHAR com CHECK DE FORMATO, deliberadamente NÃO é um tipo
--       ENUM do Postgres. ENUM exigiria `ALTER TYPE ... ADD VALUE` — ou seja,
--       migration — para cada papel novo, que é exatamente o que esta mudança
--       existe para eliminar. O CHECK trava a FORMA (maiúsculo, sem espaço,
--       estilo de enum do repo); o CATÁLOGO de papéis conhecidos vive no código
--       (`domain/PatientChatRole.ts`), que é onde ele precisa mesmo estar,
--       porque um papel novo também precisa de rótulo em es e pt-BR.
--
--   (c) UNICIDADE É PROPRIEDADE DO PAPEL, não do banco inteiro.
--       Pergunta aberta ao Marcel, ainda sem resposta: o grupo do PLANO DE SAÚDE
--       é um por paciente, ou um por plano, compartilhado entre pacientes? Se
--       for compartilhado, uma trava global recusaria o segundo paciente.
--       Por isso a linha carrega `is_exclusive`, escrito pela aplicação a partir
--       do catálogo de papéis, e o índice único é PARCIAL sobre ele:
--         - FAMILY e PROVIDERS   -> exclusivos (necessidade comprovada: é a
--           trava que impede a auditoria da Candela de contar a mesma conversa
--           duas vezes, e é o que devolveu 409 em produção);
--         - HEALTH_PLAN          -> hoje exclusivo; virar compartilhado é UMA
--           linha em `PatientChatRole.ts` + um UPDATE de dados nesta coluna.
--           Nenhum ALTER TABLE.
--       CEILING (ponytail): `is_exclusive` é denormalização do catálogo. Trocar
--       a exclusividade de um papel exige `UPDATE patient_chat_ids SET
--       is_exclusive = <novo> WHERE role = '<PAPEL>'` junto com o deploy. É
--       migration de DADOS, não de schema — e o preço de ter a trava DURA no
--       banco em vez de só na aplicação. A alternativa (tabela-catálogo +
--       trigger) custa mais máquina do que a decisão vale hoje.
--
--   (d) CHECK de formato `@g.us` — só grupo, nunca conversa 1-1 (`@c.us`).
--       Idêntico ao da 260 e ao de PeriskopeGroupNotifyService.sendToGroup.
--       Formatos reais observados na API de produção (774 grupos, 08/08/2026):
--         '<13 dígitos>-<10 dígitos>@g.us' (legado) e '<18 dígitos>@g.us'.
--
--   (e) UNIQUE (patient_id, chat_id) — o mesmo grupo não pode ocupar dois papéis
--       do MESMO paciente. Generaliza o CHECK `patients_chat_ids_distinct` da
--       260, que só sabia comparar duas colunas.
--
--   (f) ON DELETE CASCADE: o vínculo é do paciente; paciente purgado (fixture de
--       e2e-prod) não deixa linha órfã segurando um grupo.
-- ================================================================

CREATE TABLE IF NOT EXISTS patient_chat_ids (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  role         VARCHAR(32) NOT NULL,
  chat_id      VARCHAR(64) NOT NULL,
  is_exclusive BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- (b) forma de enum do repo: MAIÚSCULO, sem espaço. O catálogo é do código.
  CONSTRAINT patient_chat_ids_role_shape
    CHECK (role ~ '^[A-Z][A-Z0-9_]*$'),

  -- (d) só GRUPO. Conversa 1-1 (@c.us) é bug, não feature.
  CONSTRAINT patient_chat_ids_is_group
    CHECK (chat_id ~ '^[0-9]+(-[0-9]+)?@g\.us$'),

  -- um paciente tem no máximo UM grupo por papel
  CONSTRAINT patient_chat_ids_one_per_role UNIQUE (patient_id, role),

  -- (e) e o mesmo grupo não ocupa dois papéis do mesmo paciente
  CONSTRAINT patient_chat_ids_one_role_per_chat UNIQUE (patient_id, chat_id)
);

COMMENT ON TABLE patient_chat_ids IS
  'Grupos de WhatsApp (Periskope) do paciente, um por PAPEL. Chave de join Postgres <-> Periskope <-> ClickUp para a auditoria de informes (Candela). Migration 261, substitui as colunas fixas da 260.';
COMMENT ON COLUMN patient_chat_ids.role IS
  'Papel do grupo, estilo enum (FAMILY | PROVIDERS | HEALTH_PLAN | ...). NÃO é tipo ENUM de propósito: papel novo não pode exigir migration. Catálogo em src/modules/case/domain/PatientChatRole.ts.';
COMMENT ON COLUMN patient_chat_ids.is_exclusive IS
  'TRUE = este grupo não pode pertencer a mais nenhum paciente (trava da auditoria da Candela). Escrito pela aplicação a partir do catálogo de papéis. HEALTH_PLAN pode virar FALSE quando o Marcel responder se o grupo do plano é compartilhado entre pacientes.';

-- (c) a trava da Candela, agora escopada pela exclusividade DO PAPEL
CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_chat_ids_exclusive_chat
  ON patient_chat_ids (chat_id)
  WHERE is_exclusive;

-- leitura por paciente (ficha) e reversa por chat (auditoria)
CREATE INDEX IF NOT EXISTS idx_patient_chat_ids_patient_id ON patient_chat_ids (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_chat_ids_chat_id    ON patient_chat_ids (chat_id);

-- ================================================================
-- MIGRATION DE DADOS — idempotente
-- ================================================================
-- A base de produção está ZERADA (0 pacientes vinculados em 08/08/2026), então
-- aqui não há nada a copiar. O bloco existe mesmo assim porque o ambiente de
-- outra pessoa (local, stg, uma cópia de banco) pode NÃO estar zerado, e um
-- expand que perde dado silenciosamente é pior que um erro.
--
-- `ON CONFLICT DO NOTHING` sem alvo: cobre qualquer uma das constraints acima e
-- deixa a migration re-executável sem efeito colateral.
--
-- Soft-deleted fica de fora de propósito: `findLinkedElsewhere` sempre ignorou
-- paciente apagado, mas o índice único da 260 NÃO ignorava — um grupo preso a um
-- paciente apagado ficava eternamente bloqueado sem aparecer em lugar nenhum.
-- Não copiar essas linhas corrige a incoerência em vez de importá-la.

INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive)
SELECT id, 'FAMILY', family_chat_id, TRUE
  FROM patients
 WHERE family_chat_id IS NOT NULL
   AND deleted_at IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive)
SELECT id, 'PROVIDERS', providers_chat_id, TRUE
  FROM patients
 WHERE providers_chat_id IS NOT NULL
   AND deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Marca as colunas antigas como mortas para quem abrir o schema no meio do
-- caminho. Elas continuam existindo até o CONTRACT (migrations/pending/).
COMMENT ON COLUMN patients.family_chat_id IS
  'DEPRECADA (migration 261). Substituída por patient_chat_ids (role=FAMILY). Sem uso no código; será derrubada pela migration de contract em migrations/pending/.';
COMMENT ON COLUMN patients.providers_chat_id IS
  'DEPRECADA (migration 261). Substituída por patient_chat_ids (role=PROVIDERS). Sem uso no código; será derrubada pela migration de contract em migrations/pending/.';

COMMIT;
