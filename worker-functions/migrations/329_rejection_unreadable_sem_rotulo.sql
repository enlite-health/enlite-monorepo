-- 329 — a recusa por ILEGÍVEL: registra a OCORRÊNCIA sem registrar o VALOR (spec 016, F5-I3b)
--
-- ── O DEFEITO QUE ISTO FECHA ────────────────────────────────────────────────────────────────
-- Quando uma OPÇÃO de "Tipo de Patología" deixa de resolver no ClickUp (orderindex renomeado,
-- reordenado ou apagado), o sync já PARA e já grita
-- (`clickup_patient_sync.diagnosis_unreadable`, nível de erro — entregue na I3). O que faltava
-- é o registro DURÁVEL: a regra do projeto é que "o que não mapeia fica em LISTA" (D260), e a
-- LISTA — `patient_source_label_rejections` (migration 304, ampliada pela 326) — ficava VAZIA
-- justamente para a classe inteira dos orderindex ilegíveis. Log tem retenção; a LISTA é o que
-- a operação lê para saber o que remapear.
--
-- ── POR QUE ISTO PRECISOU DE MIGRATION (a fronteira onde o conserto travou) ──────────────────
-- `ClickUpDiagnosisRejectionRepository.recordUnmapped(patientId, rawLabel)` grava o rótulo
-- CRU. No caso ilegível **NÃO EXISTE rótulo**: o catálogo não traduziu nada. O único "valor"
-- disponível é o próprio orderindex — que é dado clínico em FORMA CODIFICADA (é o ponteiro
-- para a patologia do paciente), e a regra dura da casa é que texto clínico não sai do
-- perímetro. Gravá-lo seria vazamento; fabricar um sentinela ('(ilegível)', '-', o uuid da
-- opção) seria INVENTAR dado numa tabela clínica — o oposto do D260 — e ainda colidiria com um
-- rótulo real que tivesse essa grafia.
--
-- ⇒ A saída é registrar a OCORRÊNCIA e não o VALOR: `reason='unreadable'` com `raw_label` NULO.
--   O que a linha guarda: paciente, campo, motivo, quando (e `occurrences`, que é a frequência
--   — o dado acionável do 304). Nunca o orderindex, nunca o rótulo.
--
-- ── POR QUE O `NOT NULL` SAI E UM CHECK MAIS FORTE ENTRA ────────────────────────────────────
-- Trocar `NOT NULL` por "nulo permitido em qualquer motivo" seria AFROUXAR: abriria a porta
-- para uma recusa de 'ceiling'/'blank'/'duplicate'/'unmapped' nascer sem o rótulo que ela
-- existe para preservar. O CHECK abaixo é uma EQUIVALÊNCIA, não uma permissão:
--
--     (reason = 'unreadable') = (raw_label IS NULL)
--
-- Ele diz as DUAS coisas ao mesmo tempo, no banco (D-C: "regra que só existe na aplicação é
-- probabilidade; no banco é controle"):
--   • todo motivo que NÃO é 'unreadable' continua obrigado a ter rótulo (o NOT NULL de antes,
--     preservado onde ele significava alguma coisa);
--   • 'unreadable' é FISICAMENTE INCAPAZ de carregar rótulo — não existe sequência de comandos
--     que enfie o orderindex nessa linha. A garantia de privacidade deixa de depender de o
--     código lembrar de passar NULL.
--
-- ── O DEDUPE PRECISA DE ÍNDICE PRÓPRIO (senão o conserto reabre o defeito 8 da 304) ──────────
-- `uq_patient_source_label_rejections_value (patient_id, field_name, raw_label, reason)` é
-- índice único btree, e em btree NULO é DISTINTO de nulo: com `raw_label IS NULL` ele não
-- dedupe nada, o `ON CONFLICT` nunca dispara e cada re-sync deixaria uma linha nova — os "47
-- registros iguais que afogam o alarme" que a 304 existe para impedir. Por isso o índice
-- PARCIAL abaixo, que é a chave natural do caso sem rótulo. Ele CONVIVE com o índice antigo
-- (que segue mandando em toda linha COM rótulo); nada é derrubado nem recriado.
-- `NULLS NOT DISTINCT` no índice antigo faria o mesmo serviço em PG15+, mas mudaria a semântica
-- do índice que já governa 4 motivos vivos — mais alcance do que este defeito pede.
--
-- Idempotente e re-rodável: `DROP CONSTRAINT IF EXISTS` antes de cada `ADD`, `DROP NOT NULL`
-- (que é no-op quando já caiu) e `CREATE UNIQUE INDEX IF NOT EXISTS`. Nenhum dado é escrito,
-- lido ou apagado aqui.
--
-- ⚠️ NÃO edita a 326: ela já rodou nas bases locais e o runner rastreia por NOME de arquivo —
-- editá-la não a faria rodar de novo, e o ambiente ficaria com o CHECK antigo em silêncio.
--
-- Rollback:
--   DROP INDEX IF EXISTS uq_patient_source_label_rejections_sem_rotulo;
--   DELETE FROM patient_source_label_rejections WHERE reason = 'unreadable';
--   ALTER TABLE patient_source_label_rejections
--     DROP CONSTRAINT IF EXISTS patient_source_label_rejections_raw_label_por_motivo;
--   ALTER TABLE patient_source_label_rejections ALTER COLUMN raw_label SET NOT NULL;
--   ALTER TABLE patient_source_label_rejections
--     DROP CONSTRAINT IF EXISTS patient_source_label_rejections_reason;
--   ALTER TABLE patient_source_label_rejections ADD CONSTRAINT patient_source_label_rejections_reason
--     CHECK (reason IN ('ceiling', 'blank', 'duplicate', 'unmapped'));

-- 1. O rótulo passa a poder faltar — mas SÓ no motivo que não tem rótulo nenhum (CHECK abaixo).
ALTER TABLE patient_source_label_rejections
  ALTER COLUMN raw_label DROP NOT NULL;

-- 2. O motivo novo entra na lista permitida (aditivo: os 4 anteriores seguem válidos).
ALTER TABLE patient_source_label_rejections
  DROP CONSTRAINT IF EXISTS patient_source_label_rejections_reason;
ALTER TABLE patient_source_label_rejections
  ADD CONSTRAINT patient_source_label_rejections_reason
    CHECK (reason IN ('ceiling', 'blank', 'duplicate', 'unmapped', 'unreadable'));

-- 3. A equivalência: 'unreadable' ⇔ sem rótulo. Nos dois sentidos, e é o ponto do arquivo.
ALTER TABLE patient_source_label_rejections
  DROP CONSTRAINT IF EXISTS patient_source_label_rejections_raw_label_por_motivo;
ALTER TABLE patient_source_label_rejections
  ADD CONSTRAINT patient_source_label_rejections_raw_label_por_motivo
    CHECK ((reason = 'unreadable') = (raw_label IS NULL));

-- 4. A chave natural do caso sem rótulo, para o `ON CONFLICT` seguir somando `occurrences`.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_source_label_rejections_sem_rotulo
  ON patient_source_label_rejections (patient_id, field_name, reason)
  WHERE raw_label IS NULL;

COMMENT ON COLUMN patient_source_label_rejections.raw_label IS
  'O rótulo LITERAL recusado. NULO em UM único caso, e o CHECK '
  '`patient_source_label_rejections_raw_label_por_motivo` garante que é só nesse: '
  'reason=''unreadable'', quando a origem mandou um valor que o catálogo não traduz mais e '
  'portanto NÃO EXISTE rótulo. Ali o único "valor" seria o orderindex — dado clínico em forma '
  'codificada, que não sai do perímetro (migration 329). A linha registra a OCORRÊNCIA, nunca '
  'o VALOR.';
COMMENT ON COLUMN patient_source_label_rejections.reason IS
  'ceiling | blank | duplicate (migration 304) | unmapped (326: rótulo legível sem destino '
  'conhecido) | unreadable (329: a origem mandou valor e o catálogo não o traduz — não há '
  'rótulo para guardar, e o orderindex é dado clínico). Só ''unreadable'' admite raw_label NULO.';
