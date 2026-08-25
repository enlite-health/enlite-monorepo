-- 290 — `patients.device_type` vira DERIVADO de `patient_device_types`, e para de ser co-escrito
--
-- ── O defeito que esta migration existe para fechar (F64) ───────────────────
-- Medido em 25/08/2026, em três passos:
--
--   1. `ClickUpPatientMapper` **nunca produz** `deviceType`. `grep -rn "Dispositivo" src/` sem
--      testes: 6 ocorrências, nenhuma no mapper. O único produtor de `deviceType:` é
--      `PatientService.ts:282`, que repassa `input.deviceType` — sempre `undefined` no sync.
--   2. `PatientClinicalRepository` escreve **assim mesmo**: `device_type = $6` com
--      `input.deviceType ?? null`, incondicional. Sem o `CASE WHEN ... THEN ... ELSE ... END`
--      que a MESMA função usa para `clinical_specialty` desde a task 1.11.
--      ⇒ **todo webhook de paciente grava `NULL` em `device_type`.**
--   3. Hoje é inofensivo por acidente: `count(*) FILTER (WHERE device_type IS NOT NULL)` em
--      produção = **0** de 408 pacientes. Apagar zero não custa nada.
--
-- 🔴 A consequência: no instante em que o backfill da 4.2 preencher os 253, **o primeiro webhook
-- de cada paciente zera o campo de novo** — sem erro, com `success:true` no webhook (F43). O
-- critério 4.6 (`≥ 253`) passaria na medição do dia e falharia na semana seguinte.
--
-- ── Por que trigger SOZINHO não bastava, e o repositório tinha de mudar junto ──
-- O trigger recalcula no INSERT/DELETE de `patient_device_types`. O repositório escreve `NULL`
-- no próximo sync, **depois** do trigger. Os dois brigam e **o repositório ganha, por ser o
-- último a escrever**. Por isso o commit que traz esta migration também tira `device_type` do
-- `UPDATE` do `PatientClinicalRepository`: escalar derivado e escalar co-escrito são desenhos
-- incompatíveis, e manter os dois é o *dual-write problem* que a casa já tem medido em
-- `persistInsuranceVerified` (roda DEPOIS do COMMIT, transação própria, `catch` que só loga
-- ⇒ escalar preenchido + tabela vazia, com `success:true`).
--
-- Decisão do Gabriel (25/08), escolhendo entre derivado puro e escrita condicional:
-- **derivado puro** — uma fonte só, drift impossível por construção.
--
-- ── A regra de desempate, e por que ela é explícita ────────────────────────
-- O escalar guarda UM tipo; a tabela guarda o conjunto. Qual dos N vira o escalar precisa ser
-- determinístico, senão dois recálculos da mesma linha dão respostas diferentes e ninguém
-- percebe. `ORDER BY d.sort_order, d.code` — `sort_order` é a ordem de produto (quem cria o
-- tipo no painel escolhe a posição, sem DEFAULT, ver migration 287) e `code` é o desempate
-- final, que existe porque `sort_order` é UNIQUE hoje mas a régua não pode depender disso.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_sync_patient_device_type_escalar ON patient_device_types;
--   DROP FUNCTION IF EXISTS fn_sync_patient_device_type_escalar();
-- ⚠️ O rollback NÃO restaura a escrita pelo repositório — isso é revert de código. Depois de
-- reverter só a migration, o escalar simplesmente para de ser atualizado (congela no último
-- valor derivado). Congelar é ruim, mas é **visível** pelo verificador de divergência
-- (`scripts/verificar-4.2-divergencia.ts`); apagar em silêncio não era.

CREATE OR REPLACE FUNCTION fn_sync_patient_device_type_escalar()
RETURNS TRIGGER AS $$
DECLARE
  alvo UUID;
BEGIN
  -- `TG_OP` decide de onde vem o paciente: no DELETE a linha nova não existe.
  alvo := COALESCE(NEW.patient_id, OLD.patient_id);

  UPDATE patients p
     SET device_type = (
           SELECT pdt.device_type
             FROM patient_device_types pdt
             JOIN device_types d ON d.code = pdt.device_type
            WHERE pdt.patient_id = alvo
            ORDER BY d.sort_order, d.code
            LIMIT 1
         ),
         updated_at = NOW()
   WHERE p.id = alvo
     -- ⚠️ Só escreve se o valor MUDA. Sem isto, todo INSERT do conjunto (o padrão de escrita é
     -- DELETE+INSERT de N linhas) faria N updates na mesma linha de `patients`, cada um
     -- mexendo em `updated_at` — e `updated_at` é lido por quem decide o que re-sincronizar.
     -- `IS DISTINCT FROM` e não `<>` porque NULL entra dos dois lados.
     AND p.device_type IS DISTINCT FROM (
           SELECT pdt.device_type
             FROM patient_device_types pdt
             JOIN device_types d ON d.code = pdt.device_type
            WHERE pdt.patient_id = alvo
            ORDER BY d.sort_order, d.code
            LIMIT 1
         );

  RETURN NULL;  -- AFTER trigger: o valor de retorno é ignorado.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_patient_device_type_escalar ON patient_device_types;

-- ⚠️ `FOR EACH ROW`, não `FOR EACH STATEMENT`: o `DELETE FROM ... WHERE patient_id = $1` do
-- `replaceForPatient` é UM statement que apaga N linhas, e um trigger por statement não teria
-- como saber QUAL paciente foi tocado (não há OLD em statement-level sem transition table).
-- O custo é N recálculos por conjunto; com no máximo 5 tipos por paciente (cardinalidade do
-- catálogo) isso é irrelevante, e o guard `IS DISTINCT FROM` acima faz N-1 deles não escreverem.
CREATE TRIGGER trg_sync_patient_device_type_escalar
  AFTER INSERT OR DELETE ON patient_device_types
  FOR EACH ROW
  EXECUTE FUNCTION fn_sync_patient_device_type_escalar();

COMMENT ON FUNCTION fn_sync_patient_device_type_escalar() IS
  'Recalcula patients.device_type a partir de patient_device_types (migration 290). O escalar é '
  'DERIVADO: nenhum caminho de aplicação escreve nele. Desempate: sort_order do catálogo, depois '
  'code. Ver F64 — antes desta migration o repositório gravava NULL a cada webhook, porque o '
  'mapper nunca produzia o campo e a escrita era incondicional.';
