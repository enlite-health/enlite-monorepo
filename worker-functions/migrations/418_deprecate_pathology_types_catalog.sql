-- 418 — "Tipo de patología" NÃO é catálogo: deriva do CID-11 (spec 017, correção do Gabriel 08/09/2026).
--
-- A 415 criou `pathology_types` como catálogo mantido à mão (D299.2, parecer do CTO). O Gabriel
-- derrubou: "vem do CID-11, não tem motivo para adicionarmos um menu que adiciona isso" — é o que
-- D163/D164 já diziam (Tipo de Patología não se constrói; código E agrupador vêm do CID-11) e a
-- `2026-08-26a#DEC-09` (segmento = máscara para o Ana Care, não campo escolhido).
--
-- O que muda: `patient_therapeutic_projects.pathology_types` continua NOT NULL, lista ≥ 1 e
-- imutável — mas o servidor passa a preenchê-la com os CAPÍTULOS CID-11 distintos dos `diagnoses`
-- (`{id: código do capítulo, label: título}`), resolvidos pela TerminologyPort no INSERT. Capítulo,
-- e não bloco, é a suspensão declarada da D164 (D261; ABERTO-12 no Marcel), a mesma régua de
-- `patient_diagnoses.concept_group`. Versões já gravadas ficam como estão (imutáveis).
--
-- Migração ADITIVA (regra do repo): a tabela `pathology_types` NÃO é dropada — fica deprecada e
-- desativada. Medido na stage antes desta migration (lex C3, 08/09): 8 linhas, todas `seed:415`, e
-- ZERO versão de projeto apontando para elas; em prod a tabela não existe. O DROP entra na fila. As células `catalog_pathology_types:*` sumiram do código; o sync do
-- catálogo de permissões (`iam.deprecate_missing_permission_cells`) as marca no boot.

-- 1. Tabela: deprecada e opções desativadas (soft delete, como o próprio catálogo manda). Sem DROP.
--    A trava contra escrita é o CÓDIGO (nenhuma rota/repositório a referencia): a aplicação conecta
--    como dono da tabela, e REVOKE em dono é no-op — não fingimos uma trava de banco aqui.
UPDATE pathology_types SET active = FALSE, deactivated_at = COALESCE(deactivated_at, NOW()) WHERE active;

COMMENT ON TABLE pathology_types IS
  'DEPRECADA (418, 08/09/2026): "Tipo de patología" deriva dos CID-11 da versão, não de catálogo '
  '(D163/D164, DEC-09, D303). Linhas desativadas. Fica pela regra aditiva do repo (nunca DROP sem '
  'deprecação) — medido na stage em 08/09 (lex C3): 8 linhas, todas do seed, e ZERO versão apontando '
  'para elas; prod nunca teve a tabela. Nenhuma rota lê ou escreve aqui. DROP fica para migration '
  'futura, na fila.';

-- 2. A coluna da versão muda de SIGNIFICADO, não de tipo.
COMMENT ON COLUMN patient_therapeutic_projects.pathology_types IS
  'JSONB [{id, label}] DERIVADO dos diagnoses no INSERT: capítulos CID-11 distintos (id = código do '
  'capítulo, ex. "06"; label = título em espanhol), ordenados por id — TerminologyPort.ancestorsOf. '
  'Não vem do cliente. Antes da 418 era snapshot do catálogo pathology_types (ids uuid). Sensível-saúde '
  '(capítulo 06 sozinho revela saúde mental): sai da API só com patient_clinical:read.';

COMMENT ON TABLE patient_therapeutic_projects IS
  'Projeto terapêutico do paciente, uma linha por VERSÃO major.minor, imutável (spec 017, D299). '
  'Novo = major+1.0; Editar = minor+1 (edited_from_version_id). UPDATE só para anular (lex C5). '
  'Satélite de patients: country por trigger, RLS follow_patient, CASCADE no purge. Dado tocado: '
  'sensível-saúde (clinical_context, general_objective, diagnoses, pathology_types — este derivado do '
  'CID-11 desde a 418). Sem coluna segura: REVOGADA por inteiro do enlite_mcp_ro (lex C1). '
  'Base legal: Ley 25.326 art. 8 (OP-18).';
