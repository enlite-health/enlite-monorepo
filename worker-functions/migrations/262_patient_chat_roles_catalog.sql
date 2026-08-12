BEGIN;

-- ================================================================
-- Migration 262: CATÁLOGO de papéis de chat do paciente (configurável no app)
-- ================================================================
-- Contexto (ClickUp 86ajy1jhz, decisão do Gabriel em 08/08/2026):
--
-- A 261 tirou os papéis das COLUNAS e pôs em linhas, mas o catálogo (quais
-- papéis existem, e qual deles é exclusivo) ficou em CÓDIGO. Em um único dia o
-- papel saiu de 2 (call de 05/08: "sempre um família e um prestador") para 3
-- (áudio: plano de saúde), com um quarto citado solto ("de gestão"). E a
-- planilha do Marcel trouxe 27 pagadores distintos. Catálogo em código =
-- migration + deploy toda vez que a operação muda de ideia — e ela está mudando
-- toda semana. Então o catálogo vira DADO, com tela de administração.
--
-- DECISÕES:
--
--   (a) `code` é a PK e casa com o MESMO CHECK de forma da 261
--       (`^[A-Z][A-Z0-9_]*$`). Enum do repo é INGLÊS MAIÚSCULO, e agora a regra
--       vale também para o papel que um admin criar pela tela.
--
--   (b) Rótulo em es E pt-BR, os dois obrigatórios. Papel sem rótulo apareceria
--       na tela como código cru para quem opera. O painel é usado em es-AR
--       (Argentina) e pt-BR (Brasil) — nenhum dos dois é "opcional".
--
--   (c) `is_exclusive` é a ÚNICA FONTE DE VERDADE da unicidade. A coluna
--       `patient_chat_ids.is_exclusive` continua existindo — ela é a cópia que
--       alimenta o índice único parcial — mas passa a ser DERIVADA daqui na
--       escrita. Trocar a política de um papel atualiza as duas coisas na mesma
--       transação (ver PatientChatRolesService.update).
--
--   (d) HEALTH_PLAN nasce **NÃO EXCLUSIVO**. A planilha do Marcel tem 27
--       pagadores para 236 pacientes: se existe um grupo por pagador, ele serve
--       dezenas de pacientes, e uma trava global recusaria do segundo em diante.
--       ⚠️ RESSALVA HONESTA: a planilha prova que existem 27 pagadores, NÃO que
--       exista um grupo de WhatsApp por pagador — ela não tem chat_id de
--       pagador. Confirmar com o Marcel. O default seguro aqui é o não
--       exclusivo: se for exclusivo, virar depois é um clique na tela (e o
--       serviço recusa a virada se já houver conflito, com a contagem).
--
--   (e) `match_keywords` — as palavras que identificam o papel no NOME do grupo
--       ("flia", "familia" × "equipo", "prestadores"). Medido contra o gabarito
--       do Marcel: o grupo da família ficava em 1º lugar em só 52,4% dos casos
--       porque os dois grupos do mesmo paciente têm nome quase igual e
--       competiam. Como o papel agora existe, dá para desempatar por essas
--       palavras. Elas vivem AQUI e não em código pelo mesmo motivo do resto:
--       papel novo traz as palavras dele junto, sem deploy.
--
--   (f) `is_active` em vez de DELETE quando o papel está em uso. Desativar tira
--       da tela e do que se pode gravar, mas o histórico continua legível — a
--       auditoria da Candela olha para trás.
-- ================================================================

CREATE TABLE IF NOT EXISTS patient_chat_roles (
  code           VARCHAR(32)  PRIMARY KEY,
  label_es       VARCHAR(120) NOT NULL,
  label_pt_br    VARCHAR(120) NOT NULL,
  is_exclusive   BOOLEAN      NOT NULL DEFAULT TRUE,
  display_order  INTEGER      NOT NULL DEFAULT 0,
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  match_keywords TEXT[]       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- (a) mesma FORMA de enum exigida pela 261 em patient_chat_ids.role
  CONSTRAINT patient_chat_roles_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  -- (b) rótulo vazio é o mesmo que rótulo ausente
  CONSTRAINT patient_chat_roles_labels_not_blank
    CHECK (btrim(label_es) <> '' AND btrim(label_pt_br) <> '')
);

COMMENT ON TABLE patient_chat_roles IS
  'Catálogo de papéis de grupo de WhatsApp do paciente (FAMILY, PROVIDERS, HEALTH_PLAN, ...). Administrado pela tela /admin/patient-chat-roles, só por admin. Fonte de verdade da exclusividade — patient_chat_ids.is_exclusive é cópia derivada daqui. Migration 262.';
COMMENT ON COLUMN patient_chat_roles.is_exclusive IS
  'TRUE = um grupo deste papel pertence a NO MÁXIMO um paciente (trava da auditoria da Candela). FALSE = compartilhável entre pacientes (caso do grupo por pagador). Virar FALSE->TRUE é recusado se já houver grupo repetido, com a contagem.';
COMMENT ON COLUMN patient_chat_roles.match_keywords IS
  'Palavras que identificam este papel no NOME do grupo do Periskope (normalizadas: minúsculas, sem acento). Usadas só para DESEMPATAR o ranqueamento de candidatos — nunca para escolher sozinho.';

CREATE INDEX IF NOT EXISTS idx_patient_chat_roles_active_order
  ON patient_chat_roles (is_active, display_order);

-- ── Semente ───────────────────────────────────────────────────────────────
-- Idempotente: re-rodar não sobrescreve o que um admin já ajustou na tela.
INSERT INTO patient_chat_roles (code, label_es, label_pt_br, is_exclusive, display_order, match_keywords)
VALUES
  ('FAMILY',      'Grupo de la familia',              'Grupo da família',       TRUE,  1,
   ARRAY['flia', 'familia', 'family', 'fam', 'familiares']),
  ('PROVIDERS',   'Grupo de los prestadores',         'Grupo dos prestadores',  TRUE,  2,
   ARRAY['equipo', 'equipe', 'prestadores', 'prestador', 'acompanantes', 'ats']),
  -- (d) não exclusivo: 27 pagadores para 236 pacientes
  ('HEALTH_PLAN', 'Grupo de la obra social / prepaga', 'Grupo do plano de saúde', FALSE, 3,
   ARRAY['obra', 'social', 'prepaga', 'osde', 'swiss', 'galeno', 'plan'])
ON CONFLICT (code) DO NOTHING;

-- ── Alinha a cópia derivada com o catálogo ────────────────────────────────
-- `patient_chat_ids.is_exclusive` foi escrito pela 261 a partir do catálogo em
-- código, onde HEALTH_PLAN era exclusivo. Agora a fonte é esta tabela, e as
-- linhas já gravadas têm de concordar com ela — senão o índice único parcial
-- segue trancando um papel que a política diz ser compartilhável.
-- Idempotente por construção (só toca o que está diferente).
UPDATE patient_chat_ids ci
   SET is_exclusive = r.is_exclusive,
       updated_at   = NOW()
  FROM patient_chat_roles r
 WHERE r.code = ci.role
   AND ci.is_exclusive IS DISTINCT FROM r.is_exclusive;

COMMIT;
