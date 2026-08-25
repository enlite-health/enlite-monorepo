-- 289 — remove o teto de `Tipo de Dispositivo` no CRU, e o motivo é uma contradição minha
--
-- ── O que aconteceu, em ordem, no mesmo dia ────────────────────────────────
-- A migration **286** deu teto 5 a `Tipo de Dispositivo` em `patient_source_labels`, com esta
-- justificativa escrita: *"Com teto = cardinalidade do catálogo, truncar vira estruturalmente
-- impossível: não existe 6º valor a marcar."*
--
-- A migration **287**, minutos depois, tornou o catálogo uma TABELA editável sem deploy —
-- que é o requisito explícito do Gabriel (*"ter um controle futuramente para adicionar ou
-- remover Tipos de dispositivo"*). **No instante em que a operação criar o 6º tipo pelo painel,
-- a premissa da 286 é falsa e o cru trunca em silêncio** — na tabela cuja razão de existir é
-- impedir perda silenciosa (F32/F33).
--
-- Pior: o `5` ficou chumbado em DOIS lugares — o `CHECK` da 286 e
-- `PatientSourceLabelRepository.PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO` — e nenhum dos dois lê
-- o catálogo. Eu até escrevi um teste comparando os dois, mas ele garante que **concordem entre
-- si**, não que concordem com a realidade. Régua que compara duas cópias da mesma suposição não
-- mede nada. (Achado pela revisão arquitetural de 25/08.)
--
-- ── A decisão: o cru NÃO tem teto para este campo ──────────────────────────
-- Teto no cru é contradição em termos. O cru existe para **reversibilidade** — guardar o que a
-- origem disse, para que um rename no ClickUp não vire perda. Recusar o 4º valor porque "são
-- muitos" joga fora exatamente o que a tabela foi feita para preservar.
--
-- O limite real vive onde deve: `patient_device_types.device_type` tem **FK para
-- `device_types(code)`**, então um paciente não pode ter tipo que não existe, e não pode ter
-- mais tipos do que tipos existem. Limite por ESTRUTURA, derivado do catálogo, que se ajusta
-- sozinho quando o catálogo muda. É o que a 286 tentou obter com um número e não conseguiu.
--
-- Os demais campos **continuam com teto 3** (D166/D-C, sobre segmento clínico) — aquele número
-- é decisão de produto sobre quantos segmentos um paciente pode ter, não um espelho de catálogo.
--
-- Rollback: restaurar o CHECK da 286. ⚠️ Falha se algum paciente já tiver 6+ dispositivos no
-- cru — e falhar é o certo: o banco recusa apagar dado para caber numa regra mais estreita.

ALTER TABLE patient_source_labels
  DROP CONSTRAINT IF EXISTS patient_source_labels_ceiling_por_campo;

ALTER TABLE patient_source_labels
  ADD CONSTRAINT patient_source_labels_ceiling_por_campo
  CHECK (
    ordinal >= 1
    AND (field_name = 'Tipo de Dispositivo' OR ordinal <= 3)
  );

COMMENT ON CONSTRAINT patient_source_labels_ceiling_por_campo ON patient_source_labels IS
  'Teto 3 por (paciente, campo) — D166/D-C, sobre segmento clínico. `Tipo de Dispositivo` fica '
  'SEM teto: o limite dele é a FK de `patient_device_types` para o catálogo, que se ajusta '
  'sozinha quando o catálogo muda. Teto fixo espelhando catálogo editável vira mentira no '
  'primeiro tipo novo (migration 289).';
