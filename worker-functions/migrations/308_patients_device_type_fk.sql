-- 308 — `patients.device_type` vira FK para `device_types`
--
-- Decisão do Gabriel, 25/08: *"patients.device_type agora vai ser um FK, igual qualquer outro
-- lugar que use esse valor."*
--
-- ── O problema desta migration, e por que ela não é um ALTER de uma linha ────
-- A coluna existe desde a 037 e o comentário dela declara valores em ESPANHOL
-- (`Institucional | Domiciliario | Escolar`). A F10 mediu **0 de 349** preenchidos em 23/08 —
-- mas medição é FOTO, não trava, e eu não consegui reconferir produção antes de escrever isto
-- (o secret `enlite-ar-db-password-readonly` não existe no projeto `enlite-prd`; declarado como
-- NÃO VERIFICADO).
--
-- Se houver qualquer valor lá, um `ADD CONSTRAINT ... FOREIGN KEY` cru falha no meio do deploy
-- com uma mensagem que não diz de onde veio o problema. E a saída fácil — `UPDATE ... SET
-- device_type = NULL` para caber na regra — é **apagar dado de paciente para a migration passar**,
-- exatamente o que esta change inteira existe para impedir (D167/D185).
--
-- ⇒ Três passos, nesta ordem, e cada um faz uma coisa só:
--   1. TRADUZIR o que dá para traduzir: espanhol → código em inglês, usando o `source_label` do
--      catálogo que a 307 criou. Não é adivinhação — é a mesma tabela que o mapper usa.
--   2. FALHAR ALTO no que não dá: valor fora do catálogo aborta a migration com a CONTAGEM na
--      mensagem. Ninguém apaga nada; alguém olha.
--   3. Só então a FK.

-- ── 1. traduzir o que dá, pelo ConceptMap ──────────────────────────────────
-- ⚠️ O join é com `device_type_aliases`, não com uma coluna do catálogo. A PK (source, label)
-- garante que um rótulo case com EXATAMENTE um código — sem ela, `UPDATE ... FROM` com dois
-- matches escolheria um **arbitrariamente e em silêncio**, o que não é erro em Postgres.
UPDATE patients p
   SET device_type = a.code
  FROM device_type_aliases a
 WHERE p.device_type IS NOT NULL
   AND p.device_type = a.label;

-- ── 2. o que não mapeia vai para QUARENTENA, não para o lixo e não para o abort ──
--
-- ⚠️ A 1ª versão desta migration dava `RAISE EXCEPTION` aqui. Parecia a escolha segura — falhar
-- alto em vez de apagar dado. Não era: `Dockerfile:31` roda
-- `node scripts/run-migrations-docker.js && npm start`, e o runner faz `process.exit(1)` no
-- primeiro erro. Ou seja, não é "a migration falhou": é **o serviço não sobe, em loop**, até
-- alguém corrigir dado em produção às pressas. E eu não consegui reconferir produção antes
-- (o secret `enlite-ar-db-password-readonly` não existe em `enlite-prd`) — então eu estaria
-- apostando o boot do serviço numa medição de 23/08 que declarei NÃO VERIFICADA.
--
-- E a comparação de string é frágil de propósitos alheios: `Internación` com acento, NFC vs
-- NFD, NBSP no fim, capitalização. Qualquer um faz o valor escapar do passo 1 — e derrubar o
-- deploy por causa de uma forma Unicode seria absurdo.
--
-- ⇒ O valor não mapeável vai para `patient_source_labels`, que existe EXATAMENTE para isto
-- (guardar o rótulo literal da origem quando o canônico não resolve), e o escalar fica NULL.
-- **Nada se perde**: o dado sai de uma coluna que ninguém lê e vai para a tabela de
-- reversibilidade, auditável, com `source` dizendo de onde veio. O deploy passa.
INSERT INTO patient_source_labels (patient_id, field_name, ordinal, raw_label, source)
SELECT p.id, 'Tipo de Dispositivo', 1, p.device_type, 'migration-308-quarentena'
  FROM patients p
 WHERE p.device_type IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM device_types d WHERE d.code = p.device_type)
ON CONFLICT DO NOTHING;

-- Só depois de guardado é que o escalar é limpo. A ordem importa: se o INSERT acima falhar,
-- a transação inteira volta e o UPDATE abaixo não acontece — o dado não fica sem casa.
UPDATE patients p
   SET device_type = NULL
 WHERE p.device_type IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM device_types d WHERE d.code = p.device_type);

-- ── 3. a FK, agora que a coluna só tem código válido ou NULL ────────────────
ALTER TABLE patients
  DROP CONSTRAINT IF EXISTS patients_device_type_fkey;

-- `ON UPDATE CASCADE` pela mesma razão da 307: chave natural sem cascade trava o rename.
ALTER TABLE patients
  ADD CONSTRAINT patients_device_type_fkey
  FOREIGN KEY (device_type) REFERENCES device_types(code) ON UPDATE CASCADE;

-- Índice parcial: a coluna é majoritariamente NULL (F10 mediu 0 de 349), então o índice custa
-- quase nada e serve à checagem de RI quando `device_types` mudar. É o padrão que a 037 já usa
-- para `document_number`, `clinical_segments`, `service_type` e `dependency_level`.
CREATE INDEX IF NOT EXISTS idx_patients_device_type
  ON patients (device_type) WHERE device_type IS NOT NULL;

COMMENT ON COLUMN patients.device_type IS
  'ENUM canônico em INGLÊS, FK para device_types(code). Escalar de compatibilidade: guarda UM '
  'tipo; o conjunto múltiplo vive em `patient_device_types`. A tradução para a tela é do '
  'frontend, nunca desta coluna. ⚠️ O comentário anterior declarava valores em espanhol '
  '(Institucional | Domiciliario | Escolar) — convenção corrigida em 25/08 pela decisão do '
  'Gabriel de que todo enum do sistema é em inglês.';
