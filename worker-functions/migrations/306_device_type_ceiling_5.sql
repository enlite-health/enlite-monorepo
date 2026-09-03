-- 306 — teto por CAMPO em `patient_source_labels`: `Tipo de Dispositivo` vai a 5
--
-- ── Por que o teto único de 3 não serve para este campo ─────────────────────
-- A migration 304 pôs `CHECK (ordinal BETWEEN 1 AND 3)` — uma constante única para todos os
-- campos. O 3 veio da D166/D-C, e a justificativa escrita foi: *"o teto de 3 bate com o
-- comportamento real da operação em `Tipo de Dispositivo`, cujo máximo observado é 3 (F35)"*.
--
-- ⚠️ Isso é circular, e o `lex` nomeou (C-E′ do parecer da Fase 4): o número foi emprestado de
-- uma MEDIÇÃO de dispositivos para limitar SEGMENTOS, e a Fase 4 o traria de volta como REGRA
-- sobre a própria fonte. Máximo observado não é limite — é amostra. Calibrar o teto no máximo
-- observado GARANTE que o primeiro caso novo trunca, e há 2 pacientes sentados na borda.
--
-- ── Por que 5, e por que isso extingue o problema em vez de administrá-lo ────
-- O catálogo vivo tem EXATAMENTE 5 opções, medidas em 25/08 contra `/list/.../field`:
-- Domiciliario · Escolar · Institucional · Internación · Traslado.
-- Com teto = cardinalidade do catálogo, truncar vira **estruturalmente impossível**: não existe
-- 6º valor a marcar. Sem truncamento, o dever de retificação do art. 4º inc. 5 da Ley 25.326
-- nunca nasce — e ele importa porque `Internación` e `Institucional` revelam regime de cuidado,
-- então truncar aqui seria truncar dado CLÍNICO, não uma etiqueta operacional.
--
-- A alternativa era cumprir a C-E (canal de alerta que se prove lido). Medido: `grep -E
-- "google_monitoring|google_logging_metric|notification_channel"` em `infra/terraform` devolve
-- **zero arquivos**. Não existe alerta em ambiente nenhum; o único canal é `console.warn`.
-- Construir observabilidade para administrar um truncamento evitável é caro e é a ordem errada.
--
-- **Autorização:** Gabriel, 25/08 — *"se você encontrar 5 tipos, sim, pode ter"*. Condicional
-- satisfeita e medida acima. O teto dos demais campos **continua 3**.
--
-- ── Por que o nome do campo entra na constraint, e por que isso é seguro ────
-- `field_name` é a NOSSA chave, não a do ClickUp. Se o campo for renomeado na origem, o
-- preflight da 1.11 PARA o sync inteiro (`kind=ERROR`, nada escrito) — então não nascem linhas
-- com nome novo por baixo desta regra. A constraint envelhece junto com o resto, de forma
-- barulhenta, não silenciosa.
--
-- Rollback: restaurar o CHECK de 304 (abaixo, comentado). ⚠️ Só é seguro se nenhum paciente
-- tiver 4+ dispositivos — senão o `ALTER` falha, que é o comportamento correto: o banco recusa
-- apagar dado para caber numa regra mais estreita.
--   ALTER TABLE patient_source_labels DROP CONSTRAINT patient_source_labels_ceiling_por_campo;
--   ALTER TABLE patient_source_labels ADD CONSTRAINT patient_source_labels_ceiling_3
--     CHECK (ordinal BETWEEN 1 AND 3);

ALTER TABLE patient_source_labels
  DROP CONSTRAINT IF EXISTS patient_source_labels_ceiling_3;

ALTER TABLE patient_source_labels
  ADD CONSTRAINT patient_source_labels_ceiling_por_campo
  CHECK (
    ordinal >= 1
    AND ordinal <= CASE WHEN field_name = 'Tipo de Dispositivo' THEN 5 ELSE 3 END
  );

COMMENT ON CONSTRAINT patient_source_labels_ceiling_por_campo ON patient_source_labels IS
  'Teto POR CAMPO. Padrão 3 (D166/D-C, sobre segmento clínico); `Tipo de Dispositivo` = 5, '
  'igual à cardinalidade do catálogo, o que torna o truncamento impossível em vez de '
  'administrado (C-E′ do parecer lex de 24-25/08). Autorizado pelo Gabriel em 25/08, '
  'condicionado a o catálogo ter 5 opções — medido: tem.';
