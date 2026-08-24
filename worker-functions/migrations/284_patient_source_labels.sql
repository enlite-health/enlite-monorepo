-- ============================================================
-- Migration 284: patient_source_labels — o RÓTULO CRU da origem, múltiplo, teto 3
--
-- Task 2.2 da change `campos-admissao` (openspec/changes/campos-admissao).
-- Decisões que mandam aqui: D-A.2 (o cru é sempre persistido), D-B (o derivado fica,
-- o cru nasce AO LADO), D-C (múltiplo, teto 3, APLICADO NO BANCO).
--
-- ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────────────
-- F32: `clinicalSpecialtyMap` colapsa DE PROPÓSITO as 14 opções do ClickUp em 9 valores,
-- extraindo o eixo de especialidade e descartando o tier. `AT para Pacientes con TEA` e
-- `Cuidado Integral de Pacientes con TEA` viram o MESMO `ASD` — e a distinção, que é o
-- nível de serviço, SOME. Não é destino errado: é que o cru nunca foi persistido.
-- F33: das 17 opções da lista do Javier, 16 caem no `?? null` do mapa. A Fase 1 fez esse
-- fallback GRITAR; gritar sem guardar o cru só troca perda silenciosa por perda barulhenta.
--
-- ── POR QUE UMA TABELA, E NÃO UMA COLUNA ─────────────────────────────────────
-- A generalidade da antiga task 1.4 veio junto (decisão do Gabriel, 23/08): o cru é
-- persistido para TODO mapa blindado na 1.3, não só para segmento. Uma coluna por campo
-- seriam ~10 colunas e uma migration por campo novo; aqui o campo é DADO (`field_name`),
-- não schema. O derivado (`patients.clinical_specialty` etc.) continua exatamente onde está.
--
-- ── O TETO DE 3 É ESTRUTURAL, NÃO UMA REGRA DE APLICAÇÃO ─────────────────────
-- D-C: "regra que só existe na UI é probabilidade; no banco é controle".
-- O teto NÃO é um trigger que conta linhas: é a combinação de
--     PRIMARY KEY (patient_id, field_name, ordinal)  +  CHECK (ordinal BETWEEN 1 AND 3)
-- Só existem três posições por (paciente, campo), então NÃO HÁ SEQUÊNCIA DE COMANDOS que
-- deixe uma quarta linha lá dentro — nem por INSERT com ordinal 4 (viola o CHECK), nem por
-- INSERT numa posição ocupada (viola a PK), nem por UPDATE de ordinal (idem). Um trigger de
-- contagem teria de acertar todos os caminhos; isto não tem caminho para acertar.
--
-- Limite DECLARADO: o teto 3 vale para a TABELA, não por campo. Hoje isso é folgado para
-- tudo que passa por aqui (F35: `Tipo de Dispositivo` tem máximo observado 3; F34: cobertura
-- tem no máximo 2). Um campo futuro que precise de mais exige migration — de propósito:
-- é decisão de produto, e o design.md manda o número voltar ao Gabriel quando a operação
-- bater no teto de verdade.
--
-- ── A RECUSA É REGISTRADA, E NÃO NO LOG ──────────────────────────────────────
-- A spec exige que a recusa do 4º seja registrada "identificando o paciente e o valor
-- recusado". A C1 do parecer do `lex` PROÍBE exatamente isso em linha de log (o destino é o
-- bucket `_Default` global, sem restrição de acesso). As duas coisas se resolvem no lugar
-- certo: o registro durável vai para `patient_source_label_rejections`, DENTRO do banco, que
-- é onde o dado clínico já mora legitimamente e sob a mesma credencial; a linha de log leva
-- só nome do campo e CONTAGEM. Descartar em silêncio segue proibido (Risks do design.md).
-- ============================================================

-- 1. O cru, múltiplo, com o teto na estrutura
CREATE TABLE IF NOT EXISTS patient_source_labels (
  patient_id   UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  field_name   TEXT        NOT NULL,
  ordinal      SMALLINT    NOT NULL,
  raw_label    TEXT        NOT NULL,
  source       TEXT        NOT NULL DEFAULT 'clickup',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT patient_source_labels_pkey
    PRIMARY KEY (patient_id, field_name, ordinal),

  -- O TETO. Três posições, e só três.
  CONSTRAINT patient_source_labels_ceiling_3
    CHECK (ordinal BETWEEN 1 AND 3),

  -- Rótulo em branco não é rótulo: seria "perda" travestida de dado.
  -- `btrim` não remove NBSP — e é assim que tem de ser: 5 das 17 opções da lista do Javier
  -- terminam em NBSP (task 1.6), e o rótulo é gravado LITERAL, como veio da origem.
  CONSTRAINT patient_source_labels_raw_label_not_blank
    CHECK (btrim(raw_label) <> '')
);

-- O mesmo rótulo duas vezes no mesmo campo não é multiplicidade, é duplicata.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_source_labels_value
  ON patient_source_labels (patient_id, field_name, raw_label);

-- Contagem por campo (critério 2.6: pacientes com >= 1 segmento cru).
CREATE INDEX IF NOT EXISTS idx_patient_source_labels_field
  ON patient_source_labels (field_name);

COMMENT ON TABLE patient_source_labels IS
  'Rótulo LITERAL como veio da origem (ClickUp), por campo de catálogo, até 3 por paciente. '
  'Nasce ao lado do derivado (patients.clinical_specialty etc.), nunca no lugar dele — D-B. '
  'Existe para que rótulo desconhecido produza derivado nulo SEM perda: o cru fica para '
  'remapear depois. Change campos-admissao, task 2.2.';
COMMENT ON COLUMN patient_source_labels.field_name IS
  'Nome do campo na ORIGEM (ex.: "Segmentos Clínicos"). É metadado de schema, nunca valor de paciente.';
COMMENT ON COLUMN patient_source_labels.ordinal IS
  'Posição 1..3. O teto de 3 é este CHECK somado à PK: não existe quarta posição.';
COMMENT ON COLUMN patient_source_labels.raw_label IS
  'O rótulo LITERAL, sem trim e sem normalização — inclusive NBSP no fim, que a origem tem.';

-- 2. A recusa, registrada e durável (nunca descarte em silêncio)
--
-- ⚠️ UMA LINHA POR RECUSA DISTINTA, NÃO POR RE-SYNC (defeito 8 do QA-caça da 2.2).
-- A primeira versão desta tabela era append-only e o QA mediu o custo: 5 re-syncs da MESMA
-- lista de 4 rótulos deixavam 5 linhas idênticas, cada uma com o rótulo clínico CRU e o
-- `patient_id`, e cada uma disparando outro `console.warn`. É dado clínico crescendo sem
-- regra numa tabela que o parecer do `lex` da Fase 2 (task 2.9) ainda não olhou, e é o
-- "alarme afogado em ruído" que o critério 9.4 desta change existe para impedir.
-- O fecho é ESTRUTURAL, não uma convenção da aplicação (D-C: "regra que só existe na UI é
-- probabilidade; no banco é controle"): índice único em (paciente, campo, rótulo, motivo),
-- e a repetição vira `occurrences + 1` com `rejected_at` novo. Nada some — a mesma recusa
-- passa a ter frequência, que é o dado acionável ("este valor foi recusado 47 vezes"),
-- em vez de 47 linhas iguais.
--
-- A FK para `patients` mantém ON DELETE CASCADE como REDE, não como o mecanismo.
--
-- ⚠️ CORREÇÃO (24/08, C-B do parecer do `lex`). Uma versão anterior deste comentário afirmava
-- que este CASCADE era o cumprimento dos arts. 4º inc. 5 e 16 da Ley 25.326. Isso era FALSO no
-- caminho vivo: `grep -rn "DELETE FROM patients"` no código de aplicação devolve ZERO, e o
-- único caminho de exclusão é `UPDATE patients SET deleted_at = NOW()` (webhook `taskDeleted`).
-- O CASCADE nunca dispara — e não é um caminho por construir: é um caminho que foi DECIDIDO
-- que não existirá (ata `2026-07-22a#REQ-04`, "nunca apagar cadastro (soft delete)").
--
-- O cumprimento real é explícito, em `PatientSourceLabelRepository.purgeForPatient()`, chamado
-- pelo soft delete. O CASCADE fica para o caso de alguém apagar de fato uma linha de
-- `patients` fora da aplicação (correção manual, migração futura), e aí ele é útil — só não é
-- a resposta ao dever legal, que é o que este comentário dizia.
CREATE TABLE IF NOT EXISTS patient_source_label_rejections (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  field_name        TEXT        NOT NULL,
  raw_label         TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  ceiling           SMALLINT,
  received          SMALLINT,
  source            TEXT        NOT NULL DEFAULT 'clickup',
  occurrences       INTEGER     NOT NULL DEFAULT 1,
  first_rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rejected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ⚠️ Quando esta recusa GRITOU pela última vez (defeito 4 da 2ª rodada de QA).
  -- O dedupe do defeito 8 usava `occurrences = 1`: a recusa gritava UMA vez na vida do
  -- registro e nunca mais — nem depois de restart, nem um ano depois. Isso não é desduplicar,
  -- é desligar. Com esta coluna o silêncio vira JANELA: a repetição continua sem virar linha
  -- nova, mas o alarme RE-ACENDE enquanto o problema durar. A decisão mora aqui, e não na
  -- memória do processo, porque memória de processo zera no deploy — e aí volta o ruído.
  last_warned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT patient_source_label_rejections_reason
    CHECK (reason IN ('ceiling', 'blank', 'duplicate'))
);

-- Idempotente para uma base onde a 1ª versão desta migration já rodou (o docker local).
ALTER TABLE patient_source_label_rejections
  ADD COLUMN IF NOT EXISTS occurrences       INTEGER     NOT NULL DEFAULT 1;
ALTER TABLE patient_source_label_rejections
  ADD COLUMN IF NOT EXISTS first_rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE patient_source_label_rejections
  ADD COLUMN IF NOT EXISTS last_warned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Colapsa duplicatas que a versão append-only possa ter deixado, ANTES do índice único —
-- senão a criação do índice falha e a migration inteira para. Mantém a linha mais ANTIGA
-- (a que carrega o `first_rejected_at` verdadeiro) e soma as ocorrências nela.
WITH agrupado AS (
  SELECT patient_id, field_name, raw_label, reason,
         min(id::text)::uuid  AS manter,
         count(*)             AS quantas,
         min(first_rejected_at) AS primeira,
         max(rejected_at)     AS ultima
    FROM patient_source_label_rejections
   GROUP BY patient_id, field_name, raw_label, reason
  HAVING count(*) > 1
)
UPDATE patient_source_label_rejections r
   SET occurrences       = a.quantas,
       first_rejected_at = a.primeira,
       rejected_at       = a.ultima
  FROM agrupado a
 WHERE r.id = a.manter;

DELETE FROM patient_source_label_rejections r
 USING (
   SELECT patient_id, field_name, raw_label, reason, min(id::text)::uuid AS manter
     FROM patient_source_label_rejections
    GROUP BY patient_id, field_name, raw_label, reason
   HAVING count(*) > 1
 ) a
 WHERE r.patient_id = a.patient_id
   AND r.field_name = a.field_name
   AND r.raw_label  = a.raw_label
   AND r.reason     = a.reason
   AND r.id <> a.manter;

CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_source_label_rejections_value
  ON patient_source_label_rejections (patient_id, field_name, raw_label, reason);

CREATE INDEX IF NOT EXISTS idx_patient_source_label_rejections_lookup
  ON patient_source_label_rejections (patient_id, field_name, rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_source_label_rejections_reason
  ON patient_source_label_rejections (reason, rejected_at DESC);

COMMENT ON TABLE patient_source_label_rejections IS
  'Uma linha por recusa DISTINTA (paciente, campo, rótulo, motivo); a repetição incrementa '
  'occurrences em vez de criar linha nova. A spec exige que a recusa identifique o paciente '
  'e o valor; a C1 do parecer do lex proíbe isso em LOG. Este é o lugar onde as duas coisas '
  'convivem — dentro do banco, sob a mesma credencial do dado clínico. A linha de log leva '
  'só campo + contagem, e só quando a recusa é inédita. Change campos-admissao, task 2.2.';
COMMENT ON COLUMN patient_source_label_rejections.occurrences IS
  'Quantas vezes esta MESMA recusa já aconteceu. Substitui a linha nova por re-sync: a '
  'frequência é o dado acionável, e 47 linhas iguais só afogam o alarme (critério 9.4).';
COMMENT ON COLUMN patient_source_label_rejections.first_rejected_at IS
  'Quando esta recusa aconteceu pela PRIMEIRA vez. `rejected_at` é a mais recente.';
COMMENT ON COLUMN patient_source_label_rejections.last_warned_at IS
  'Quando esta recusa GRITOU pela última vez. O alarme volta a tocar quando a janela vence — '
  'silenciar para sempre depois do 1o aviso seria trocar "afogado em ruido" por "mudo".';
