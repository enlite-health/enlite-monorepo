-- 327 — corrige o mapa `Tipo de Patología` (ClickUp) → CID-11 com os rótulos REAIS
--
-- 🔴 POR QUE ESTA MIGRATION EXISTE. A 326 semeou o mapa com DOIS rótulos que NÃO EXISTEM no
-- ClickUp: "Trastorno del Espectro Autista" e "Parálisis Cerebral". Foram inventados porque a
-- lista viva não estava acessível naquele momento (o `contracts/clickup-fields.md` citado na spec
-- não existe no repo, e o fixture só tem nomes de campo, sem as opções do dropdown).
-- Rótulo inventado é pior que rótulo ausente: ele nunca casa com nada — então o espelho parece
-- "configurado" e não mapeia paciente nenhum, sem ninguém perceber. Instrumento morto.
--
-- Os 10 rótulos abaixo foram LIDOS da API do ClickUp em 04/09/2026:
--   GET /api/v2/list/901304883903/field  →  campo "Tipo de Patología" (drop_down, 10 opções)
--
-- 🔑 CRITÉRIO DO MAPEAMENTO — mecânico, não clínico.
-- O campo do ClickUp é uma lista de AGRUPADORES; o CID-11 tem, para cada bloco, um código
-- "sin especificación" que significa exatamente "um transtorno deste grupo, sem dizer qual".
-- É a correspondência HONESTA: `Trastorno Depresivo` → `Trastornos depresivos, sin especificación`
-- é a mesma frase. Mapear um agrupador para um FILHO específico (ex.: "depresivo" → "depresivo
-- recurrente") seria inventar precisão clínica que o dado de origem não tem — um paciente marcado
-- como "Trastorno Depresivo" no ClickUp não é necessariamente recorrente.
--
-- ⚖️ DOIS RÓTULOS FICAM DE FORA, DE PROPÓSITO (LISTA para Ana/Marcel):
--   "Trastorno Psicológico" e "Trastorno Psiquiátrico"
-- Os dois são genéricos, e o único alvo defensável para ambos seria o mesmo código de capítulo
-- (`6E8Z`). Mapear duas opções DISTINTAS do dropdown para o MESMO código apaga uma distinção que
-- a operação escolheu fazer — e isso é decisão de produto, não de engenharia. Enquanto não houver
-- decisão, esses rótulos caem no caminho "não mapeado": não gravam nada e ficam registrados.
-- Proibido inventar código clínico para preencher lacuna.
--
-- Idempotente: `DELETE` dos inventados + `ON CONFLICT DO UPDATE`. Rodar 2× não muda o resultado.

BEGIN;

-- 1. Fora os dois rótulos fabricados pela 326.
DELETE FROM clickup_diagnosis_labels
 WHERE source = 'clickup'
   AND label IN ('Trastorno del Espectro Autista', 'Parálisis Cerebral');

-- 2. Os 8 que mapeiam mecanicamente (rótulo ≈ título do bloco no CID-11).
INSERT INTO clickup_diagnosis_labels (source, label, concept_uri, active) VALUES
  ('clickup', 'Psicosis',
   'http://id.who.int/icd/release/11/2026-01/mms/405565289/unspecified', true),
   -- 6A2Z Esquizofrenia u otros trastornos psicóticos primarios, sin especificación

  ('clickup', 'Trastorno Alimentario',
   'http://id.who.int/icd/release/11/2026-01/mms/1412387537/unspecified', true),
   -- 6B8Z Trastornos del comportamiento alimentario, sin especificación

  ('clickup', 'Trastorno Bipolaridad',
   'http://id.who.int/icd/release/11/2026-01/mms/613065957/unspecified', true),
   -- 6A6Z Trastornos bipolares u otros trastornos relacionados, sin especificación

  ('clickup', 'Trastorno de Ansiedad',
   'http://id.who.int/icd/release/11/2026-01/mms/1336943699/unspecified', true),
   -- 6B0Z Trastornos de ansiedad o relacionados con el miedo, sin especificación

  ('clickup', 'Trastorno de Discapacidad Intelectual',
   'http://id.who.int/icd/release/11/2026-01/mms/605267007', true),
   -- 6A00 Trastornos del desarrollo intelectual

  ('clickup', 'Trastorno Depresivo',
   'http://id.who.int/icd/release/11/2026-01/mms/1563440232/unspecified', true),
   -- 6A7Z Trastornos depresivos, sin especificación

  ('clickup', 'Trastorno Neurológico',
   'http://id.who.int/icd/release/11/2026-01/mms/1296093776/unspecified', true),
   -- 8E7Z Enfermedades del sistema nervioso, sin especificación

  ('clickup', 'Trastorno Opositor Desafiante',
   'http://id.who.int/icd/release/11/2026-01/mms/1487528823', true)
   -- 6C90 Trastorno desafiante y oposicionista
ON CONFLICT (source, label) DO UPDATE
  SET concept_uri = EXCLUDED.concept_uri,
      active      = EXCLUDED.active,
      updated_at  = NOW();

COMMIT;
