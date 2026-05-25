# Audit de Integridade WJA — DB × API × DOM

Ferramenta de auditoria de integridade do funil Kanban em **3 camadas independentes**.
Útil pra validar consistência de prod após migrations, deploys, ou suspeitas de bug.

Executado pela primeira vez em **2026-05-25** após F2-F8 + deploy prd, com resultado:
**12.259/12.259 workers OK em 344 vagas. Zero discrepâncias.**

## Pré-requisitos

- `gcloud` autenticado em `enlite-prd` com permissão pra Secret Manager + Cloud SQL
- `cloud-sql-proxy` instalado (Homebrew: `brew install cloud-sql-proxy`)
- `node` (usa `pg` do worker-functions/node_modules)
- Para `audit-render-prod.js`: credenciais admin Firebase (env vars)

## Scripts

### 1. `audit-stage-history.js` — Integridade do banco

Valida que cada WJA tem stage consistente com a última transição em `worker_job_application_stage_history`.

```bash
cd worker-functions

# Subir Cloud SQL Proxy (deixa rodando)
cloud-sql-proxy --port 5438 enlite-prd:southamerica-west1:enlite-ar-db &

# Audit dos N workers mais recentemente atualizados (filtra source legacy)
node scripts/audit/audit-stage-history.js 100

# Audit COMPLETO (inclui planilla_operativa + import)
node scripts/audit/audit-stage-history.js 12259 --include-legacy
```

**Saída:** JSON com correlação por worker:
- `OK` — history bate com estado DB
- `NO_HISTORY` — sem stage_history (esperado pra workers pré-2026-05-20 quando o trigger 169 foi criado)
- `STAGE_MISMATCH` — DB tem stage diferente do último history.new_value (bug!)
- `TEMPORAL_ANOMALY` — wja.updated_at < última history.created_at (clock skew ou bug)
- `NO_ENCUADRE` — WJA sem encuadre companion (trigger 189 falhou)

### 2. `audit-visual-prod.js` — API Kanban × DB

Valida que o endpoint `GET /api/admin/vacancies/:id/funnel` (que alimenta o frontend Kanban) retorna cada worker na coluna correta. Sem browser, apenas HTTP REST.

```bash
# Lê o último resultado do audit-stage-history.js automaticamente
FIREBASE_EMAIL='admin@example.com' FIREBASE_PASSWORD='...' \
  node scripts/audit/audit-visual-prod.js
```

**Saída:** stats + JSON detalhado:
- `OK` — card aparece na coluna esperada
- `WRONG_COLUMN` — card na coluna diferente (bug logic de bucket)
- `NOT_FOUND` — card sumiu (bug de query/filter)
- `API_ERROR` — endpoint retornou erro

### 3. `audit-render-prod.js` — DOM real via Playwright

Valida que o componente React renderiza cada card no DOM da coluna correta, em browser real (Chromium headless).
Usa 6 vagas representativas (definidas no script).

```bash
FIREBASE_EMAIL='admin@example.com' FIREBASE_PASSWORD='...' \
  node scripts/audit/audit-render-prod.js
```

**Saída:** screenshots de cada vaga + JSON com:
- `OK` — `data-testid="kanban-card-{wjaId}"` está dentro de `data-testid="kanban-column-{expected}"`
- `WRONG_COLUMN_DOM` — DOM mostra na coluna errada
- `CARD_NOT_IN_DOM` — card sumiu do render

## Limitações conhecidas

1. **Workers pré-2026-05-20 não têm stage_history** — trigger 169 não existia. Não é bug, é histórico.
2. **`changed_by`/`change_source` ficam vazios** — trigger usa `current_setting('app.current_uid')` mas o backend nunca seta. Rastreabilidade limitada (TD futura).
3. **Cloud Logging tem instrumentação parcial** — alguns components (MatchmakingService batch) não logam `workerId`. Não afeta integridade, só observability.
4. **`audit-render-prod.js` testa 6 vagas representativas** — não as 344. Pra cobertura completa de render, escalar quantidade de vagas no array `REPROVIDENT_VACANCIES`.

## Histórico de auditorias

| Data | Versão | Workers | Resultado |
|---|---|---|---|
| 2026-05-25 | inicial | 100 | 100/100 DB + 100/100 API + 104/104 DOM |
| 2026-05-25 | escalou pra 500 | 500 | 500/500 DB + 500/500 API |
| 2026-05-25 | escalou pra 12k | 12.259 | 12259/12259 DB + 12259/12259 API |

## TDs gerados durante essa auditoria

- **TD-050**: docs WJA descrevem `reason/metadata` mas schema real é `changed_by/change_source` (registrado em FOLLOWUPS.md)
