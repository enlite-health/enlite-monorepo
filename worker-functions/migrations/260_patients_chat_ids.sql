BEGIN;

-- ================================================================
-- Migration 260: patients.family_chat_id / patients.providers_chat_id
-- ================================================================
-- Contexto (call Planning Produto 05/08/2026, ClickUp 86ajy0859):
-- cada paciente tem exatamente DOIS grupos de WhatsApp no Periskope — um da
-- família e um dos prestadores. O `chat_id` desses grupos não existe no nosso
-- banco, então não dá para cruzar Postgres ↔ Periskope ↔ ClickUp sem planilha
-- manual. O Marcel mapeou 176 pacientes à mão para rodar a skill da Candela
-- uma vez; amanhã a base é outra.
--
-- DECISÕES:
--
--   (a) CAMPO FIXO, não lista aberta. Escolha explícita do Marcel na call:
--       "deixa fixo... é sempre um família e um prestador". Duas colunas em
--       `patients`, não uma tabela de vínculos.
--
--   (b) CHECK de formato `@g.us` — o Periskope distingue grupo (`@g.us`) de
--       conversa 1-1 (`@c.us`). Gravar um `@c.us` aqui é bug, não feature:
--       a auditoria da Candela conta INFORMES DE GRUPO. Mesma trava que já
--       existe em PeriskopeGroupNotifyService.sendToGroup.
--       Formatos reais observados na API de produção (774 grupos, 08/08/2026):
--         '<13 dígitos>-<10 dígitos>@g.us' (legado) e '<18 dígitos>@g.us'.
--       Por isso o padrão aceita dígitos com um hífen opcional.
--
--   (c) Índice ÚNICO PARCIAL em cada coluna (WHERE ... IS NOT NULL): o mesmo
--       grupo não pode ser vinculado a dois pacientes no MESMO papel. É isso
--       que protege a auditoria da Candela de contar o mesmo informe duas
--       vezes. Parcial porque a esmagadora maioria das linhas é NULL — índice
--       cheio seria desperdício e NULLs não colidem em UNIQUE de qualquer forma
--       (o parcial deixa a intenção explícita e o índice menor).
--
--   (d) CHECK de colunas distintas na MESMA linha: um grupo não pode ser ao
--       mesmo tempo o da família e o dos prestadores do mesmo paciente.
--
--       CEILING CONHECIDO: a colisão CRUZADA entre linhas diferentes
--       (family_chat_id do paciente A == providers_chat_id do paciente B) NÃO é
--       coberta por constraint — Postgres não tem índice único cross-column.
--       Ela é validada na camada de aplicação (PatientChatIdsService), que
--       devolve 409. Upgrade path se isso um dia doer: tabela de vínculos
--       `patient_chat_links(chat_id PK, patient_id, role)` com UNIQUE no
--       chat_id — o que também mataria a decisão (a) do Marcel.
--
--   (e) Aditiva e nullable: nenhum caminho de escrita atual precisa mudar, e
--       todo paciente existente continua válido (NULL passa em todo CHECK).
-- ================================================================

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS family_chat_id    VARCHAR(64),
  ADD COLUMN IF NOT EXISTS providers_chat_id VARCHAR(64);

COMMENT ON COLUMN patients.family_chat_id IS
  'chat_id do grupo de WhatsApp da FAMÍLIA no Periskope (sempre @g.us). Chave de join Postgres <-> Periskope para a auditoria de informes (Candela). Migration 260.';

COMMENT ON COLUMN patients.providers_chat_id IS
  'chat_id do grupo de WhatsApp dos PRESTADORES no Periskope (sempre @g.us). Chave de join Postgres <-> Periskope para a auditoria de informes (Candela). Migration 260.';

-- (b) formato: só grupo, nunca 1-1
ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_family_chat_id_is_group;
ALTER TABLE patients
  ADD CONSTRAINT patients_family_chat_id_is_group
  CHECK (family_chat_id IS NULL OR family_chat_id ~ '^[0-9]+(-[0-9]+)?@g\.us$');

ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_providers_chat_id_is_group;
ALTER TABLE patients
  ADD CONSTRAINT patients_providers_chat_id_is_group
  CHECK (providers_chat_id IS NULL OR providers_chat_id ~ '^[0-9]+(-[0-9]+)?@g\.us$');

-- (d) o mesmo grupo não pode ser família E prestadores do mesmo paciente
ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_chat_ids_distinct;
ALTER TABLE patients
  ADD CONSTRAINT patients_chat_ids_distinct
  CHECK (family_chat_id IS NULL OR providers_chat_id IS NULL OR family_chat_id <> providers_chat_id);

-- (c) um grupo pertence a no máximo um paciente, por papel
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_family_chat_id_unique
  ON patients (family_chat_id)
  WHERE family_chat_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_providers_chat_id_unique
  ON patients (providers_chat_id)
  WHERE providers_chat_id IS NOT NULL;

COMMIT;
