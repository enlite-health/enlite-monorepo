# Runbook — Backfill do funil Kanban (Talentum)

> **Quando rodar:** uma única vez, após o fix do bug #8 (ProcessTalentumPrescreening — já corrigido na Fase 5).
> **Quem pode rodar:** engenheiro com acesso a `gcloud` no projeto `enlite-prd` + credencial do secret `enlite-ar-db-password`.
> **Tempo estimado:** 10 minutos.
> **Reversível?** Parcialmente — UPDATE direto cria histórico via trigger; ver §5 (rollback).

Contexto completo em [`../POSTMORTEM_KANBAN_FUNNEL_BUGS.md`](../POSTMORTEM_KANBAN_FUNNEL_BUGS.md).

---

## 1. Escopo do backfill

| Bloco | Volume | Origem | Estratégia |
|---|---|---|---|
| ~~A. WJAs em `INITIATED` (origem sync)~~ | ~~1.332~~ | Bug #3 — reclassificado | **CANCELADO** — estado correto |
| **B. Encuadres com `resultado=NULL` indevido** | 2 | Bug #8 — ordering UPDATE-before-INSERT (já corrigido em código) | `UPDATE encuadres SET resultado` direto |

### Por que o Bloco A foi cancelado

A investigação aprofundada do bug #3 (documentada no postmortem §5) revelou que o modelo de domínio correto é:

- **Webhook `PRESCREENING_RESPONSE` é a única fonte canônica per-encuadre** de `application_funnel_stage`
- O `profile.status` global do `TalentumDashboardProfile` **não tem semântica per-(worker, vaga)** — é agregação per-worker e usá-lo como fonte do funil contamina o dado clínico
- O `SyncTalentumWorkersUseCase` foi simplificado (TD-035): **nunca seta `application_funnel_stage`**. Só garante WJA + encuadre existem (vínculo worker↔vaga)

Os 1.332 workers em `INITIATED` estão **no estado correto**: são candidatos cadastrados via dashboard que **nunca tiveram webhook canônico per-encuadre** (provavelmente nunca entraram no WhatsApp daquela vaga específica ou abandonaram antes). Marcá-los como `QUALIFIED` baseado em status global da Talentum seria projetar uma triagem que nunca aconteceu naquele encuadre.

Para sinalizar pra operação que esses cards são "candidato cadastrado mas sem retorno" — e não bugs do sistema — ver **TD-040** em `docs/FOLLOWUPS.md` (UI feedback).

---

## 2. Pré-condições

Antes de executar o Bloco B:

- [ ] Fix do bug #8 mergeado em `main` e deployado em `enlite-prd` (já corrigido na Fase 5)
- [ ] Suite E2E do funil verde: `cd worker-functions && npm run test:e2e -- --testPathPattern="talentum"`
- [ ] `gcloud auth login` no projeto `enlite-prd`
- [ ] `cloud-sql-proxy` instalado
- [ ] Acesso ao secret `enlite-ar-db-password` no Secret Manager

---

## 3. Conexão segura ao prod (read-only inicialmente)

```bash
# 1. Confirmar instância Cloud SQL ativa (região é southamerica-west1, NÃO east1)
gcloud sql instances list --project=enlite-prd --format='value(name,connectionName)'
# Esperado: enlite-ar-db | enlite-prd:southamerica-west1:enlite-ar-db

# 2. Pegar senha do Secret Manager
PROD_DB_PASS=$(gcloud secrets versions access latest --secret=enlite-ar-db-password --project=enlite-prd)

# 3. Abrir túnel via Cloud SQL Proxy (porta local 5435 para não conflitar com local)
cloud-sql-proxy enlite-prd:southamerica-west1:enlite-ar-db --port=5435 &
PROXY_PID=$!
sleep 5  # Aguardar handshake

# 4. Conectar com psql — usuário é enlite_app (não enlite_admin)
PGPASSWORD="$PROD_DB_PASS" psql -h 127.0.0.1 -p 5435 -U enlite_app -d enlite_ar

# Ao terminar:
kill $PROXY_PID
```

**Atenção operacional descoberta durante o backfill de 2026-05-22:**
- Região: `southamerica-west1` (não `east1`).
- Usuário DB: `enlite_app` (não `enlite_admin`).
- Apenas 2 usuários BUILT_IN existem na instância: `enlite_app` e `postgres`.

A partir daqui, todas as queries SQL deste runbook devem ser rodadas nessa sessão `psql`.

---

## 4. Bloco B — Fix dos 2 encuadres com `resultado=NULL`

### 4.1 Identificar os casos

```sql
-- B.1: os 2 casos confirmados em 2026-05-22 (caso 342 e 713)
SELECT
  e.id AS encuadre_id,
  e.worker_id,
  e.job_posting_id,
  jp.case_number,
  e.resultado,
  wja.application_funnel_stage,
  tp.status AS talentum_status
FROM encuadres e
JOIN job_postings jp ON jp.id = e.job_posting_id
JOIN worker_job_applications wja
  ON wja.worker_id = e.worker_id AND wja.job_posting_id = e.job_posting_id
JOIN talentum_prescreenings tp
  ON tp.worker_id = e.worker_id AND tp.job_posting_id = e.job_posting_id
WHERE e.resultado IS NULL
  AND tp.status = 'ANALYZED'
  AND wja.application_funnel_stage IN ('NOT_QUALIFIED', 'INITIATED');
```

Os 2 casos da investigação de 2026-05-22 tinham `application_funnel_stage='INITIATED'` por causa do bug #4 (regressão out-of-order, corrigido na Fase 5). Com o fix do bug #4 já em produção, novos webhooks `ANALYZED+NOT_QUALIFIED` para esses workers vão promover a WJA para `NOT_QUALIFIED` via precedência. Se ainda estiverem em `INITIATED` no momento do backfill, isso confirma que nenhum webhook chegou desde então — então é seguro forçar `RECHAZADO` no encuadre baseado no estado terminal do prescreening Talentum.

### 4.2 Dry-run do UPDATE

**CHECK constraints relevantes em `encuadres`:**

- `resultado` ∈ `{SELECCIONADO, RECHAZADO, AT_NO_ACEPTA, REPROGRAMAR, REEMPLAZO, BLACKLIST, PENDIENTE}` — usar `RECHAZADO`
- `rejection_reason_category` ∈ `{DISTANCE, SCHEDULE_INCOMPATIBLE, INSUFFICIENT_EXPERIENCE, SALARY_EXPECTATION, WORKER_DECLINED, OVERQUALIFIED, DEPENDENCY_MISMATCH, TALENTUM_NOT_QUALIFIED, OTHER}` — usar `TALENTUM_NOT_QUALIFIED`
- `rejection_reason` ∈ `{NULL, other, incompatible_schedule, distance}` (VARCHAR 30) — **NÃO** usar pra texto livre; deixar `NULL`. Motivo do backfill fica em commit/changelog/audit, não em `rejection_reason`.

```sql
-- B.2: UPDATE
BEGIN;
UPDATE encuadres SET
  resultado = 'RECHAZADO',
  rejection_reason_category = 'TALENTUM_NOT_QUALIFIED',
  updated_at = NOW()
WHERE id IN (
  SELECT e.id FROM encuadres e
  JOIN talentum_prescreenings tp
    ON tp.worker_id = e.worker_id AND tp.job_posting_id = e.job_posting_id
  JOIN worker_job_applications wja
    ON wja.worker_id = e.worker_id AND wja.job_posting_id = e.job_posting_id
  WHERE e.resultado IS NULL
    AND tp.status = 'ANALYZED'
    AND wja.application_funnel_stage = 'NOT_QUALIFIED'
)
RETURNING LEFT(id::text, 8) AS encuadre_short, resultado, rejection_reason_category;

-- Inspecionar resultado. Se OK:
COMMIT;
-- Se algo estranho:
ROLLBACK;
```

**Critério de sucesso:** UPDATE deve afetar **2 rows** (no diagnóstico de 2026-05-22 eram casos 616 e 681). Se afetar significativamente mais, **ROLLBACK** e investigar — pode ter aparecido novo caso de regressão do bug #8 (não deveria após o fix da Fase 5).

**Backfill executado em 2026-05-22:**
- 2 encuadres atualizados: `a6a6573c` (caso 616, SEARCHING_REPLACEMENT) e `a6c7829d` (caso 681, ACTIVE)
- Validação 4.3 pós-update retornou 0 pendentes
- Snapshot pré-update preservado em `/tmp/backfill_bug8_pre.csv` (rollback safety net)

### 4.3 Validação

```sql
-- B.3: confirmar que não sobrou encuadre órfão com tp.status=ANALYZED + resultado=NULL
SELECT COUNT(*) FROM encuadres e
JOIN talentum_prescreenings tp
  ON tp.worker_id = e.worker_id AND tp.job_posting_id = e.job_posting_id
WHERE e.resultado IS NULL
  AND tp.status = 'ANALYZED';
-- esperado: 0
```

---

## 5. Rollback do Bloco B

Salvar antes a linha original:

```sql
-- ANTES de B.2, salvar estado original em CSV
\COPY (
  SELECT id, resultado, rejection_reason_category, rejection_reason, updated_at
  FROM encuadres e
  JOIN talentum_prescreenings tp
    ON tp.worker_id = e.worker_id AND tp.job_posting_id = e.job_posting_id
  WHERE e.resultado IS NULL
    AND tp.status = 'ANALYZED'
) TO 'backfill_block_b_pre.csv' WITH CSV HEADER;
```

Rollback:

```sql
-- Restaurar a partir do CSV (criar tabela temporária primeiro)
CREATE TEMP TABLE tmp_encuadres_rollback (
  id uuid,
  resultado text,
  rejection_reason_category text,
  rejection_reason text,
  updated_at timestamptz
);
\COPY tmp_encuadres_rollback FROM 'backfill_block_b_pre.csv' WITH CSV HEADER;

UPDATE encuadres e SET
  resultado = r.resultado,
  rejection_reason_category = r.rejection_reason_category,
  rejection_reason = r.rejection_reason,
  updated_at = r.updated_at
FROM tmp_encuadres_rollback r WHERE e.id = r.id;
```

---

## 6. Pós-execução — comunicação e fechamento

- [ ] Postar resultado no canal `#enlite-eng` (números antes/depois)
- [ ] Atualizar `docs/POSTMORTEM_KANBAN_FUNNEL_BUGS.md` §7 com snapshot atualizado
- [ ] Marcar TD-035 como completo no `docs/FOLLOWUPS.md`
- [ ] Confirmar com a operação que Kanban e lista mostram números consistentes
- [ ] Re-rodar suite E2E pra garantir que produção continua saudável

---

## 7. Anexo — queries de monitoramento contínuo

Após o backfill, manter essas queries num dashboard pra detectar regressão dos bugs corrigidos:

```sql
-- (1) Detecta encuadres com prescreening ANALYZED mas resultado=NULL — bug #8 regressão
SELECT COUNT(*) FROM encuadres e
JOIN talentum_prescreenings tp
  ON tp.worker_id = e.worker_id AND tp.job_posting_id = e.job_posting_id
WHERE e.resultado IS NULL
  AND tp.status = 'ANALYZED';
-- esperado: 0 contínuo

-- (2) Detecta regressão de stage out-of-order — bug #4 regressão
-- WJAs onde stage_history tem evento posterior com precedência menor
SELECT COUNT(*) FROM worker_job_application_stage_history h1
JOIN worker_job_application_stage_history h2
  ON h2.worker_job_application_id = h1.worker_job_application_id
  AND h2.changed_at > h1.changed_at
WHERE
  (h1.to_stage IN ('QUALIFIED','NOT_QUALIFIED') AND h2.to_stage IN ('INITIATED','IN_PROGRESS','COMPLETED'))
  OR (h1.to_stage = 'COMPLETED' AND h2.to_stage IN ('INITIATED','IN_PROGRESS'))
  AND h2.changed_at > NOW() - INTERVAL '1 day';
-- esperado: 0 contínuo (CASE de precedência em funnel_stage_precedence deve barrar)

-- (3) Visibilidade operacional — workers em INITIATED há >7 dias com source talentum sem prescreening
-- (estado legítimo segundo modelo de domínio; query existe para alimentar TD-040 UI feedback)
SELECT
  jp.case_number,
  COUNT(*) AS workers_aguardando
FROM worker_job_applications wja
JOIN job_postings jp ON jp.id = wja.job_posting_id
WHERE wja.application_funnel_stage = 'INITIATED'
  AND wja.source = 'talentum'
  AND wja.updated_at < NOW() - INTERVAL '7 days'
  AND jp.status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE','PENDING_ACTIVATION','ACTIVE','ON_HOLD')
  AND NOT EXISTS (
    SELECT 1 FROM talentum_prescreenings tp
    WHERE tp.worker_id = wja.worker_id AND tp.job_posting_id = wja.job_posting_id
  )
GROUP BY jp.case_number
HAVING COUNT(*) > 0
ORDER BY workers_aguardando DESC
LIMIT 20;
-- não é regressão — é dashboard pra operação saber onde concentrar follow-up de WhatsApp
```

Conectar (1) e (2) a alerta no Cloud Monitoring com SLO: zero ocorrências por dia. (3) alimenta UI/dashboard operacional (TD-040).
