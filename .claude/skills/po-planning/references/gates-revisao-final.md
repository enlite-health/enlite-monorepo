# Gates de Revisão Final do PO (pós-QA)

Após o QA aprovar a implementação, o PO percorre **todos** os gates abaixo antes de marcar a feature como **DONE**.

Resultado é binário: **APROVADO** ou **REPROVADO**. Não existe "aprovado com ressalva" — se algum gate falha, devolve ao dev responsável.

---

## Como aplicar

1. Ler o diff completo da feature (`git diff main...HEAD` ou diff do PR).
2. Para cada gate, marcar ✅ PASS, ❌ FAIL ou ⚠️ N/A (com justificativa).
3. Decisão final segue a tabela:
   - Todos PASS ou N/A justificado → **APROVADO**
   - Qualquer FAIL → **REPROVADO** com pendências citando o número do gate

---

## Gates

### G1 — Critérios de aceite

**Check:** Cada critério de aceite do Plano de Execução foi atendido?

Procedimento: percorrer literalmente a lista de critérios de aceite de cada task do plano e validar contra o código/comportamento.

FAIL se: qualquer critério não atendido OU critério ausente no plano que deveria estar.

---

### G2 — Regras de negócio Enlite

**Check:** Nenhuma regra documentada (CLAUDE.md, RAG, FOLLOWUPS) foi violada?

Atenção especial às regras que mudam silenciosamente:

- Transição para `QUALIFIED` é **exclusiva** do webhook Talentum (memory: `feedback_qualified_only_talentum`)
- Enums em UPPERCASE EN canônico, com tradução na borda (memory: `feedback_enum_values_english_uppercase`)
- JSX nunca renderiza enum cru — sempre `t(...)` (memory: `feedback_enum_i18n_frontend`)
- `worker_id`/`job_posting_id` NUNCA null em prescreenings (memory: `project_prescreening_invariants`)
- Sobrescrita de paciente exige consentimento humano (memory: `feedback_patient_overwrite_consent`)
- Pacientes/vagas órfãs: vaga aceita `patient_id` nullable (memory: `project_patient_vacancy_cardinality`)
- Hora canônica = 23:59, nunca 24:00 (memory: `feedback_time_canonical_2359`)

FAIL se: qualquer regra de negócio violada.

---

### G3 — Clean Architecture

**Check:** As camadas foram respeitadas?

- Controllers/pages sem lógica de negócio
- Domain sem dependência de infrastructure
- Use cases não conhecem framework (Express, React)
- Validação via Zod nas bordas

FAIL se: controller faz query direta, domain importa de infrastructure, use case usa `req`/`res`, etc.

---

### G4 — Limite de 400 linhas

**Check:** Nenhum arquivo de implementação ultrapassou 400 linhas?

Procedimento: `wc -l` nos arquivos modificados/criados.

FAIL se: arquivo > 400 linhas sem split. Memory: `feedback_line_limit_when_touching_file` exige split incluído no mesmo escopo se o dev tocou arquivo grande.

---

### G5 — Qualidade de código

**Check:**

- Zero `any` em código novo (memory: `feedback_no_any`)
- Zero TODO/FIXME novos sem ticket associado
- Zero `console.log` em produção
- Nomes em inglês para código, PT-BR só para conteúdo de UI/i18n
- Modularização: utils não escrevem direto no DB (memory: `feedback_modularize_to_extreme`)

FAIL se: qualquer violação.

---

### G6 — Testes

**Check:**

- Unit tests cobrindo lógica nova
- E2E quando o fluxo é cross-camada
- Frontend: todo teste E2E tem `toHaveScreenshot()` (memory: `feedback_visual_tests_required`)
- Backend: integration tests NÃO mockam DB (memory: usar DB real, ver CLAUDE.md raiz)
- Todos os testes do projeto passam (não só os novos) — memory: `feedback_all_tests_pass_before_commit`

FAIL se: cobertura ausente OU algum teste pré-existente quebrado OU screenshot ausente em frontend.

---

### G7 — Migrations e schema

**Check (apenas se houve mudança de schema):**

- Migration aditiva (não dropa coluna/tabela sem deprecação)
- Numeração sequencial correta
- Rodada localmente e testada
- Plano de produção documentado (qual script, qual hora, qual rollback)

FAIL se: migration destrutiva sem deprecação ou plano de prod ausente.

---

### G8 — Cleanup

**Check:** Arquivos órfãos, wrappers vazios, código morto removidos no mesmo commit/PR?

Memory: `feedback_cleanup_obsolete_files` — não deixar lixo.

FAIL se: arquivos vazios, exports não usados, comentários `// removed` ou `// TODO: clean`.

---

### G9 — Sync com ClickUp / sistemas externos

**Check (apenas se a feature toca paciente, vaga ou worker):**

- Mapper de status ClickUp ↔ banco está coerente (memory: `project_status_clickup_vs_enlite`)
- Sobrescrita de dados externos respeita consentimento (memory: `feedback_patient_overwrite_consent`)
- Webhook idempotente quando aplicável

FAIL se: sync silenciosamente sobrescreve dados ou mistura status.

---

### G10 — RBAC e PII

**Check:**

- Campos sensíveis não foram hardcoded como mascarados em components — RBAC futuro decide (memory: `project_rbac_pii_visibility`)
- Logs não vazam PII (memory: `project_case_number_pii_identifier`)
- `case_number` usado como identificador humano em vez de nome do paciente em UI/logs

FAIL se: PII em log ou mascaramento hardcoded.

---

## Formato de saída do PO

### Caso APROVADO

```
## Revisão Final do PO — APROVADO

| Gate | Status | Nota |
|---|---|---|
| G1 Critérios de aceite | ✅ | Todos os 7 critérios das 3 tasks atendidos |
| G2 Regras de negócio | ✅ | — |
| ... | | |

**Decisão:** APROVADO. Feature pronta para merge.
```

### Caso REPROVADO

```
## Revisão Final do PO — REPROVADO

| Gate | Status | Nota |
|---|---|---|
| G1 Critérios de aceite | ❌ | Critério "endpoint retorna 409 quando case_number duplicado" não implementado |
| G6 Testes | ❌ | Frontend não tem screenshot assertion no PatientForm.test.tsx |
| ... | | |

**Pendências:**
1. (G1) Implementar resposta 409 em `PatientController.create` quando case_number já existe
2. (G6) Adicionar `await expect(page).toHaveScreenshot('patient-form.png')` em `patient-form.e2e.ts`

**Devolver para:** backend-dev (item 1), frontend-dev (item 2)

**Decisão:** REPROVADO. Re-submeter após pendências.
```
