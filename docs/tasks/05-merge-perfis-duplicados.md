# Task: Merge de perfis de prestadores duplicados

**ClickUp:** https://app.clickup.com/t/86aj3yufw · **Status:** Open→Refinada · **Board:** APP Recrutamento (Technology)

> Ticket sem descrição (confirmado via API: `name="Fazer um Merge dos perfils duplicados"`, criado 2026-06-17, sem assignee, sem corpo). Refinamento abaixo reconstruído por engenharia reversa do código + snapshot de prod.

---

## 1. Contexto (snapshot, causa raiz: phone não normalizado)

Prod tem prestadores (workers) duplicados — a mesma pessoa cadastrada em mais de um registro `workers`.

**Snapshot conhecido (memória 2026-06-10):** ~146 grupos de duplicados por phone em prod; 102 com pessoas reais (205 registros). Não foi possível reconfirmar contra o banco nesta sessão (DBA não executado — refino estático). Os números acima devem ser revalidados via `v_potential_duplicate_workers` antes de qualquer execução (ver §4).

**Causa raiz — phone não normalizado na borda de criação:**

- `workers.phone` é gravado **cru** no path de auto-cadastro do worker:
  `worker-functions/src/modules/worker/infrastructure/WorkerRepository.ts:52` → `data.phone || null` entra no `INSERT` (linha 38) **sem** passar por `normalizePhoneAR`.
- Já existe um normalizador canônico AR (`549XXXXXXXXXX`): `worker-functions/src/shared/utils/phoneNormalization.ts` (`normalizePhoneAR` + `generatePhoneCandidates`).
- Esse normalizador É usado nos paths de **leitura/sync** (Talentum, claim, lookup):
  - `SyncTalentumWorkersUseCase.ts:100` grava `normalizePhoneAR(rawPhone)` — sync Talentum normaliza.
  - `ProcessTalentumPrescreening.ts:112,322` normaliza.
  - `StartClaimUseCase.ts:61,66` e `InitWorkerUseCase.ts:88-91` normalizam só para **buscar** candidatos.
- Resultado: a **escrita** no auto-cadastro é a única borda sem normalização → mesma pessoa vira `1151265663` (10 díg.) vs `5491151265663` (13 díg.) → o `UNIQUE` parcial existente em `workers(phone)` (mig 014, ver §6) **não colide** porque as strings diferem. A unicidade é puramente lexical, não semântica.

**Armadilha de prod (memória `prod_migration_drift_058`):** prod é migrado manualmente; mig 014 declara `CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_phone_unique` mas se 146 grupos existem por phone, ou (a) o índice nunca foi aplicado em prod, ou (b) os phones são lexicalmente distintos (caso acima) e portanto não violam o índice. **Confirmar qual antes de propor índice novo.**

---

## 2. Objetivo

Dois objetivos, ambos obrigatórios — curar sem prevenir só recria o passivo:

1. **Curar** os duplicados já existentes em prod: para cada grupo, eleger um sobrevivente (canônico), reparentar todas as FKs dependentes para ele, marcar os demais como mesclados (`merged_into_id`), sem perder dado.
2. **Prevenir** novos duplicados: normalizar `phone` na borda de escrita do auto-cadastro (`WorkerRepository.create`) para que o `UNIQUE` parcial passe a colidir de fato, fechando a torneira.

---

## 3. Escopo

### Dentro
- **Prevenção (entrega independente, vai já):** normalização de `phone` na escrita do auto-cadastro (`WorkerRepository.ts:52`, path `create`) via `normalizePhoneAR` **+** coluna gerada `phone_normalized` (defesa em profundidade — §9.6).
- **Marcador de conta de teste (limpeza de base — TRAVADO 2026-06-19, §9.7):** coluna aditiva `workers.is_test BOOLEAN NOT NULL DEFAULT false` (migration **221**), parte do mesmo esforço de limpeza de base da dedup. Marcador limpo de "conta de teste" que substitui a heurística-por-email frágil usada hoje pela #6/#7 (a heurística fica só como rede para históricos). O toggle admin-only no perfil (front + endpoint) é escopo da **#2** — aqui entra **só** a coluna/migration.
- Auditoria/extensão do `WorkerDeduplicationService` existente para reparentar **todas** as ~17 FKs (hoje cobre só 3 — ver §4.4). Reparent completo é obrigatório.
- Migration de backfill: normalizar `workers.phone` históricos (reusar lógica da mig 018, que só rodou pra Talentum-era).
- **Nota (opcional, §9.7):** o backfill da dedup pode aproveitar a passada pra marcar `is_test=true` em casos óbvios de teste já conhecidos (ex.: a conta E2E canônica `gabriel.g.stein@gmail.com` + aliases `+testN`, domínios sintéticos de import). Não é obrigatório — o marcador nasce `false` por default e a marcação principal é manual via checkbox admin (#2). Se feito, fazer por `UPDATE` explícito e auditável, nunca heurística cega que pegue conta real.
- Rotina de cura **híbrida** (§9.2): auto-merge determinístico SÓ para phone-idêntico-pós-normalização **+** CUIT igual; demais casos → relatório de exceções. Idempotente, com dry-run e auditoria persistida (`worker_merge_audit`, §9.4).
- **Relatório/documento de exceções** para casos não auto-mergeáveis (múltiplos logins, conflito de campo legal, fuzzy) — base para futuro export Excel pro responsável humano (§9.1.3, §9.2, §9.3).

### Fora
- Refazer o motor de matching de duplicatas (já existe view + LLM).
- Dedupe de **pacientes** (outro domínio).
- Hard-delete de registros mesclados (mantém-se `merged_into_id` para reversibilidade — ver §8).
- **UI de "desfazer merge" no v1** (decidido §9.5 — `merged_into_id` + `worker_merge_audit` bastam para reversão manual).
- **UI de revisão humana** dos casos de exceção no v1 — sai como relatório/documento; export Excel é follow-up.

---

## 4. Estado atual do código — EVIDÊNCIA

### 4.1 Schema `workers` e coluna phone
- Tabela: `worker-functions/migrations/001_create_workers_schema.sql` — `phone VARCHAR(20)`, `email UNIQUE`, `auth_uid UNIQUE`.
- **`merged_into_id UUID REFERENCES workers(id)`** já existe: `migrations/020_analytics_and_dedup.sql` (+ `data_sources TEXT[]`). Ou seja, o conceito de "merge para canônico" já está modelado no schema.
- `UNIQUE` parcial em phone: `migrations/014_enlite_ar_operational_schema.sql:48-50`
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_phone_unique ON workers(phone) WHERE phone IS NOT NULL AND phone != '';` — **lexical, não semântico** (ver §1).

### 4.2 Onde phone é GRAVADO (WRITES)
| Local | Normaliza? | Evidência |
|---|---|---|
| Auto-cadastro worker | **NÃO** ❌ | `WorkerRepository.ts:38,52` — `data.phone` cru no INSERT |
| Sync Talentum | SIM | `SyncTalentumWorkersUseCase.ts:100` |
| Prescreening Talentum | SIM | `ProcessTalentumPrescreening.ts:112,322` |
| `updateAuthUid` (reconexão) | passa phone do payload cru | `InitWorkerUseCase.ts:67` (`phoneToSet`), `WorkerRepository.ts:158` |

→ A borda quebrada é **`WorkerRepository.create`**.

### 4.3 Reconciliação por phone (InitWorkerUseCase)
- `worker-functions/src/modules/worker/application/InitWorkerUseCase.ts`
  - Ordem de reconexão: `findByAuthUid` (42) → `findByEmail` (55, reconecta authUid) → **`findByPhoneCandidates`** (89-91).
  - O match por phone usa `generatePhoneCandidates` (cobre as variantes lexicais) e, se o candidato é **importado** (`isImportedWorker`, prefixos `anacareimport_` etc.), dispara **claim via OTP WhatsApp anti-hijack** em vez de auto-link silencioso (`InitWorkerUseCase.ts:96-140`).
  - **Importante:** essa reconciliação só dispara para workers *importados*. Dois cadastros **self-service** (ambos authUid Firebase real) com phones lexicalmente diferentes **não** se reconciliam aqui → caem no `create` (144) e viram duplicata. Esse é exatamente o gap que a normalização na escrita fecha.
- Métodos do port: `worker-functions/src/modules/worker/ports/IWorkerRepository.ts:5-15` (`create`, `findByEmail`, `findByPhone`, `findByPhoneCandidates`, `updateAuthUid`).

### 4.4 FKs dependentes que um merge precisa reparentar
Tabelas com FK `worker_id → workers(id)` (grep `REFERENCES workers` em migrations). **ON DELETE** anotado porque define o que acontece se algum dia houver hard-delete:

| Tabela | Migration | ON DELETE | Reparentada hoje pelo `mergeWorkers`? |
|---|---|---|---|
| `worker_service_areas` | 001 | CASCADE | ❌ NÃO |
| `worker_availability` | 001/104 | CASCADE | ❌ NÃO |
| `worker_quiz_responses` | 001 | CASCADE | ❌ NÃO |
| `worker_documents` | 009 | CASCADE (`UNIQUE worker_id`) | ❌ NÃO |
| `worker_additional_documents` | 128 | CASCADE | ❌ NÃO |
| `worker_payment_info` | 010 | CASCADE (`UNIQUE worker_id`) | ❌ NÃO |
| `worker_job_applications` (WJA) | 011 | CASCADE | ✅ SIM (`WorkerDeduplicationService.ts:258-268`, ON CONFLICT DO NOTHING) |
| `encuadres` | (193 unique) | — | ✅ SIM (`:251-254`) |
| `blacklist` | 014 | SET NULL | ✅ SIM (`:271-281`) |
| `talentum_prescreenings` | 057 | SET NULL | ❌ NÃO |
| `worker_status_history` | 079 | CASCADE | ❌ NÃO |
| `worker_employment_history` | 027 | CASCADE | ❌ NÃO |
| `worker_placement_audits` | 043 | SET NULL | ❌ NÃO |
| `worker_reminder_state` | 176 | CASCADE | ❌ NÃO |
| `messaging_outbox` | 060 | — | ❌ NÃO |
| `whatsapp_bulk_dispatch_logs` | 062/066/085 | nullable | ❌ NÃO |
| `messaging_opt_out` | 199 | — | ❌ NÃO |
| `worker_pending_profile_changes` | 201 | — | ❌ NÃO |
| `worker_profile_changes_audit` | 202 | — | ❌ NÃO |

→ **GAP CRÍTICO:** o merge atual cobre só **3** tabelas (WJA, encuadres, blacklist). Marcar o duplicado com `merged_into_id` deixa **documentos, payment_info, prescreenings, histórico, áreas, disponibilidade** ainda apontando para o registro mesclado. Como o merge **não deleta** o duplicado (só seta `merged_into_id`), não há FK órfã hoje — mas os dados dessas tabelas ficam **invisíveis** (consultas filtram `WHERE merged_into_id IS NULL`), efetivamente perdidos para a operação. Reparent dessas tabelas faz parte do escopo.

### 4.5 Já existe rotina de dedupe/merge?
**SIM, parcial.** Não inventar do zero — auditar e estender:
- `worker-functions/src/infrastructure/services/WorkerDeduplicationService.ts` — pipeline completo: candidatos (view) → análise LLM (Groq/Llama, `WorkerDedupLLM.ts`) → `mergeWorkers` atômico em transação.
  - `runDeduplication({dryRun, confidence, limit})` e `runDeduplicationForWorkers(workerIds)`.
  - `chooseCanonical` (`:300-309`): prefere quem tem `first_name_encrypted` preenchido, depois `created_at ASC` (mais antigo).
  - `mergeWorkers` (`:204-296`): atualiza canônico com COALESCE, reparenta as 3 tabelas, seta `merged_into_id`.
- Views de candidatos: `v_potential_duplicate_workers` (mig 020, refinada 021 cross-source). Match por: CUIT, levenshtein(phone) 1-2, trigram(nome)+domínio email, email gerado vs real.
- Endpoints já existem: `GET /analytics/dedup/candidates` (requireStaff) e `POST /analytics/dedup/run` (requireAdmin) — `analyticsRoutes.ts:45-51`, `AnalyticsController.ts:172-191`.
- Testes: `worker-functions/src/infrastructure/services/__tests__/worker-deduplication.test.ts`.

**Dependência operacional:** o pipeline exige `GROQ_API_KEY` (`WorkerDeduplicationService.ts:89-90`). A view de candidatos por **levenshtein 1-2** não pega o caso `10díg vs 13díg` (distância > 2) — por isso a normalização de backfill (§6) é pré-requisito para a view enxergar esses pares por igualdade exata de phone.

---

## 5. Estratégia de merge proposta

Triangulada: a infra de merge **já existe**, o que falta é (a) fechar a torneira, (b) completar o reparent, (c) tornar a detecção robusta a phone.

### 5.1 Prevenção (fix-once, prioridade máxima)
1. Em `WorkerRepository.create`, normalizar `phone` via `normalizePhoneAR(data.phone)` antes do INSERT (`WorkerRepository.ts:52`). Idem para `whatsappPhone` se aplicável e para o `phoneToSet` de `updateAuthUid`.
2. Com phones canônicos, o `idx_workers_phone_unique` (mig 014) passa a colidir de fato → segundo cadastro com mesmo número é barrado na borda.

### 5.2 Escolha do sobrevivente (canônico) — TRAVADO §9.1
Substituir o critério atual de `chooseCanonical` (`WorkerDeduplicationService.ts:300-309`, hoje "nome preenchido > mais antigo", **errado**) pela ordem dura de §9.1:
1. **1º — perfil com login Firebase real** (`auth_uid` logável / não-importado). Exatamente um com login → ele é o canônico.
2. **Nenhum** do grupo tem login real → merge mantendo como base o perfil com **MAIS informações** (mais campos preenchidos / mais FKs dependentes não-vazias).
3. **Mais de um login real**, irresolvível, ou conflito → **NÃO auto-mergear**; mandar pro **relatório de exceções** (§9.1.3).

### 5.3 Reparent completo de FKs — TRAVADO §9.5/§4.4
Estender `mergeWorkers` para reparentar **TODAS as ~17 tabelas** da §4.4 (hoje só 3), respeitando os `UNIQUE`:
- Tabelas com `UNIQUE worker_id` (`worker_documents`, `worker_payment_info`): se canônico **não** tem registro → `UPDATE worker_id`; se **tem** → **manter o do canônico** e mandar o conflito pro **relatório de exceções** (campo legal NUNCA sobrescreve automaticamente — §9.3). Não descartar silenciosamente.
- Tabelas 1:N sem unique: `UPDATE ... SET worker_id = canonical WHERE worker_id = duplicate`.
- Manter o padrão transacional `BEGIN/COMMIT/ROLLBACK` já usado.

### 5.4 Conflito por campo — TRAVADO §9.3
- **`CUIT`/`cuit`, `document_number`, documentos, payment_info:** NUNCA sobrescrever auto. Divergência → relatório de exceções.
- **Nome / telefone:** valor **do sobrevivente** + `COALESCE` só para preencher vazios do sobrevivente. Nunca sobrescrever valor já presente.

### 5.5 Normalização de detecção
Backfill de phone (§6) **antes** de rodar a cura, para que pares "10 vs 13 dígitos" virem phone idêntico e sejam pegos por igualdade exata (não só levenshtein). Auto-merge exige **phone idêntico pós-normalização + CUIT igual** (§9.2); o resto vai pro relatório.

---

## 6. Schema / migrations

Aditivo, nunca dropar. Propostas (próximos prefixos livres após `215`; ver lista abaixo):

1. **`218_add_workers_phone_normalized.sql` (TRAVADO §9.6, vai já)** — adiciona coluna **gerada `phone_normalized`** em `workers` (defesa em profundidade, independente da escrita aplicar a normalização) + índice/constraint sobre ela para unicidade semântica. Faz dupla com o fix em `WorkerRepository.ts:52`. Aditivo, não dropa nada.
2. **`219_normalize_workers_phone_backfill.sql`** — reaplica a lógica da mig 018 (`normalizePhoneAR` em SQL: 10→`549`+, 11/12 com `54`→`549`+) para popular/normalizar registros pós-mig-018. **Cuidado:** normalizar `phone` cru pode criar colisão no `idx_workers_phone_unique` → a detecção usa **`phone_normalized`** (coluna gerada), sem reescrever `phone` cru até o merge resolver o par. A cura efetiva de pares colidentes roda **dentro** da rotina de merge (normaliza candidato → detecta colisão → mescla), não como `UPDATE` cego.
3. **`220_create_worker_merge_audit.sql` (§9.4)** — tabela aditiva `worker_merge_audit` (quem, quando, `duplicate_id`→`canonical_id`, campos afetados/COALESCE). Persistência da auditoria de cada merge.
4. **`221_add_workers_is_test.sql` (TRAVADO §9.7, vai junto com a limpeza de base)** — adiciona `workers.is_test BOOLEAN NOT NULL DEFAULT false`. Marcador limpo de conta de teste, parte da limpeza de base junto com a dedup. Aditivo, não dropa nada. **Apenas a coluna** — o checkbox admin-only no perfil e o endpoint de toggle são escopo da **#2** (`02-match-modal-perfil-prestador.md`); o consumo no predicado de elegibilidade (`AND is_test = false`) é escopo da **#6** (`06-integracao-hubspot.md`) e da **#7** (Ana Care).

**Faixa de prefixos reservada por este doc:** `218` (phone_normalized) · `219` (backfill phone) · `220` (worker_merge_audit) · `221` (is_test). `221` **não colide** com nada já reservado aqui — os prefixos anteriores (`218`/`219`/`220`) cobrem phone_normalized/backfill/audit; `is_test` fica no próximo livre, `221`. Confirmar o último prefixo realmente aplicado em `worker-functions/migrations/` antes de escrever (o repo já tem migrations até `215`).

**Confirmar antes de escrever a migration:** estado real do `idx_workers_phone_unique` em prod (existe? colide?) via DBA — memória de drift 058 alerta que prod diverge das migrations declaradas.

---

## 7. Critérios de aceite

- [ ] **Prevenção:** `WorkerRepository.create` normaliza phone via `normalizePhoneAR` (teste unit cobrindo `1151265663 → 5491151265663`) **E** coluna gerada `phone_normalized` existe com índice de unicidade (§9.6).
- [ ] **Sobrevivente (§9.1):** `chooseCanonical` segue a ordem dura — login Firebase real > (sem login) perfil com mais informações > (ambíguo/conflito) NÃO mescla, vai pro relatório. Teste cobrindo os 3 ramos.
- [ ] **Modo híbrido (§9.2):** auto-merge dispara SÓ com phone-idêntico-pós-normalização + CUIT igual; casos fuzzy/múltiplo-login NÃO são auto-mesclados, entram no relatório de exceções. Teste cobrindo um par auto e um par exceção.
- [ ] **Conflito por campo (§9.3):** CUIT/document_number/documentos/payment_info divergentes NUNCA sobrescritos auto → vão pro relatório; nome/telefone usam sobrevivente + COALESCE só em vazios. Teste cobrindo divergência de campo legal.
- [ ] **Relatório de exceções:** casos não auto-mergeáveis são persistidos/exportáveis (base do futuro Excel humano), com motivo (múltiplo login / conflito legal / fuzzy).
- [ ] Após backfill + cura: `SELECT count(*) FROM v_potential_duplicate_workers` por match `phone_similar`/igualdade = 0 (ou só pares justificadamente no relatório de exceções).
- [ ] **Reparent completo (§5.3):** `mergeWorkers` reparenta as ~17 tabelas da §4.4 (teste de integração com banco real verificando que nenhuma linha de tabela dependente aponta para um `worker_id` que tem `merged_into_id IS NOT NULL`).
- [ ] **Idempotência:** rodar a rotina 2× não cria efeito colateral nem re-mescla já-mesclados (`WHERE merged_into_id IS NULL` nos candidatos).
- [ ] **Auditoria (§9.4):** cada merge persiste em tabela aditiva `worker_merge_audit` (quem, quando, duplicate_id→canonical_id, campos afetados/COALESCE). Não basta log.
- [ ] **Reversibilidade (§9.5):** nenhum hard-delete; duplicado permanece com `merged_into_id`; sem UI de desfazer no v1.
- [ ] **Marcador de teste (§9.7):** migration `221` cria `workers.is_test BOOLEAN NOT NULL DEFAULT false` (aditiva). Coluna existe, default `false`, NOT NULL. Apenas a coluna nesta task — checkbox/endpoint ficam na #2; consumo no predicado fica na #6/#7.
- [ ] Visual/E2E conforme regra do projeto se houver UI.

---

## 8. Riscos & armadilhas

- **Perda de dado silenciosa (ALTA):** o merge atual deixa 14 tabelas órfãs-de-visibilidade (documentos, pagamento, prescreening, histórico) apontando para o registro mesclado. Sem o reparent da §5.3, mesclar = esconder dados reais do prestador. **Bloqueante.**
- **Conflito em tabelas `UNIQUE worker_id`** (`worker_documents`, `worker_payment_info`): reparent ingênuo viola a constraint. Precisa política explícita (qual documento/pagamento vence) — não descartar o perdedor sem auditoria.
- **`idx_workers_phone_unique` em prod (drift 058):** backfill cego de `phone` pode estourar o índice. Mitigar com coluna auxiliar / merge-no-loop (§6).
- **Anti-hijack:** o claim por OTP (`InitWorkerUseCase:96-140`) existe justamente para impedir link indevido de fichas importadas. Qualquer merge automático precisa **não** burlar essa proteção: merge é operação administrativa, não fluxo de login.
- **"Qual perfil é o real":** critério `chooseCanonical` atual pode eleger um perfil importado vazio sobre o self-service real. Revisar (§5.2).
- **Dependência GROQ_API_KEY + LLM:** a confirmação de duplicata depende de LLM externo (`WorkerDeduplicationService.ts:89`). Custo, rate-limit (sleep 150ms) e não-determinismo. Para pares com phone idêntico pós-normalização, considerar caminho determinístico sem LLM.
- **Reversibilidade:** garantida só enquanto não houver hard-delete. Manter `merged_into_id` como soft-merge é a salvaguarda.
- **Consentimento humano:** merge é destrutivo-efetivo. Hoje `POST /dedup/run` é admin-only mas roda em lote. Avaliar gate de revisão humana por par (§9).

---

## 9. Decisões TRAVADAS (2026-06-19, Gabriel)

Tudo abaixo está decidido. Não reabrir sem novo input do dono. Implementar exatamente como descrito.

1. **Critério de sobrevivente (ordem dura):**
   1. **1º critério — perfil com login Firebase real (`auth_uid` logável / não-importado).** Se exatamente um perfil do grupo loga de fato, ele é o sobrevivente.
   2. Se **NENHUM** perfil do grupo tem login Firebase real → **fazer merge das informações** mantendo como **base/original o perfil com MAIS informações** (mais campos preenchidos / mais FKs dependentes não-vazias).
   3. Se **mais de um** perfil tem login real, ou **não dá pra resolver** com confiança, ou há **dúvida/conflito** → **NÃO mergear automaticamente**. Registrar o caso num **documento/relatório de exceções** (base para futuramente exportar um Excel pro responsável humano resolver).
   - Implica revisar `chooseCanonical` (`WorkerDeduplicationService.ts:300-309`) — o critério atual ("nome preenchido > mais antigo") está **errado** e deve ser substituído por essa ordem.

2. **Modo: HÍBRIDO (decidido).**
   - **Auto-merge** SÓ quando **phone idêntico pós-normalização** (`normalizePhoneAR`) **E `CUIT` igual** — alta confiança, caminho determinístico, sem depender de LLM.
   - **Casos fuzzy** (phone só similar por levenshtein, nome por trigram, CUIT ausente/divergente, múltiplos logins) → **fila/relatório de revisão humana** (o tal Excel). Não auto-mesclar.

3. **Conflito por campo (decidido):**
   - **Documentos e campos legais (`CUIT`/`cuit`, `document_number`, registros de `worker_documents`, `worker_payment_info`) NUNCA são sobrescritos automaticamente.** Qualquer divergência nesses campos → o caso vai pro **relatório de exceções humano**, não se auto-resolve.
   - **Nome e telefone:** usar o valor **do sobrevivente** + **`COALESCE`** apenas para **preencher vazios** do sobrevivente com o do duplicado (nunca sobrescrever valor já presente no sobrevivente).

4. **Auditoria (decidido):** persistir tabela **aditiva `worker_merge_audit`** (quem executou, quando, de→para — `duplicate_id`→`canonical_id`, e campos afetados/COALESCE aplicados). `DeduplicationReport` em log não basta.

5. **Reversão (decidido):** `merged_into_id` + `worker_merge_audit` **bastam** para rastrear/reverter manualmente. **Sem UI de "desfazer merge" no v1.**

6. **Prevenção via schema (decidido — entrega independente, vai já):** normalizar `phone` na borda em **`WorkerRepository.ts:52`** (path `create`) com `normalizePhoneAR` **E** adicionar coluna **gerada `phone_normalized`** (defesa em profundidade — não depende da escrita aplicar a normalização). Ambos, não um ou outro.

7. **Marcador de conta de teste (decidido — limpeza de base):** existe lixo na base; criar um **marcador limpo** em vez de depender só da heurística-por-email. Coluna aditiva **`workers.is_test BOOLEAN NOT NULL DEFAULT false`** na migration **221** (próximo prefixo livre após `218`/`219`/`220` reservados acima — sem colisão). Escopo desta task = **só a coluna/migration** (parte da limpeza de base). O **checkbox admin-only** no perfil do prestador (front) e o **endpoint de toggle** ficam na **#2**; o **consumo no predicado de elegibilidade** (`AND is_test = false`) fica na **#6** (HubSpot) e na **#7** (Ana Care), mantendo a heurística de email só como rede para históricos. Backfill opcional de `is_test=true` em contas de teste óbvias é nota, não requisito (§3).

---

## 10. Estimativa & dependências

**Dependências:**
- DBA (leitura) para reconfirmar snapshot e estado do `idx_workers_phone_unique` em prod **antes** de migration.
- `GROQ_API_KEY` ativo (só para o ramo fuzzy/relatório; o auto-merge phone+CUIT é determinístico, sem LLM).
- ~~Decisões §9.1–9.3 do PO~~ — **TRAVADAS em 2026-06-19 (§9), nada a destravar.** Executável sem perguntas.

**Estimativa (grosseira, sujeita a §9):**
- Fix prevenção (`create` normaliza + teste): ~0.5 dia. **Independente — pode ir já**, fecha a torneira.
- Estender `mergeWorkers` p/ todas as FKs + testes de integração: ~1.5–2 dias.
- Migration de backfill/detecção segura: ~0.5–1 dia.
- Rotina de cura + auditoria + (eventual) gate humano: ~1–2 dias conforme §9.2.

**Total:** ~3.5–5.5 dias. Caminho crítico = decisões do PO sobre sobrevivente/revisão humana, não código.

---

### Evidência (índice rápido)
- Causa raiz write cru: `WorkerRepository.ts:38,52`
- Normalizador: `shared/utils/phoneNormalization.ts`
- Reconciliação phone: `InitWorkerUseCase.ts:88-142`
- Merge existente (3 tabelas): `WorkerDeduplicationService.ts:204-296`
- Views candidatos: migrations `020`, `021`
- `merged_into_id`: migration `020`
- Unique phone (lexical): migration `014:48-50`
- FKs dependentes: grep `REFERENCES workers` (tabela §4.4)
- Endpoints dedup: `analyticsRoutes.ts:45-51`
- Backfill phone precedente: migration `018`
- Marcador conta de teste: migration `221` (`workers.is_test`, §9.7) — coluna aqui; checkbox/endpoint na #2; predicado na #6/#7
