# 07 — Tabelas envolvidas

Diagrama do schema-alvo após a deprecação progressiva (fases F1-F8).

## Tabelas canônicas (manter, expandir)

### `worker_job_applications` — SSOT do funil

```
id                          UUID PK
worker_id                   UUID FK workers
job_posting_id              UUID FK job_postings
UNIQUE (worker_id, job_posting_id)

-- Funil
application_funnel_stage    VARCHAR(30)   -- SSOT do estado
source                      VARCHAR(50)   -- system (match auto) | manual (admin/link público) | talentum (provider externo, ADR-004)
acquisition_channel         VARCHAR(50)   -- system | facebook | instagram | whatsapp | linkedin | site | NULL
match_score                 NUMERIC
messaged_at                 TIMESTAMPTZ

-- Agendamento (fluxo QUALIFIED → WhatsApp)
interview_meet_link         TEXT
interview_datetime          TIMESTAMPTZ
interview_response          VARCHAR(30)   -- pending | confirmed | declined | awaiting_reschedule
interview_responded_at      TIMESTAMPTZ
interview_reminder_sent_at  TIMESTAMPTZ
interview_slot_id           UUID FK interview_slots
interview_decline_reason    TEXT

-- Aplicação
applied_at                  TIMESTAMPTZ
rejection_reason            TEXT

-- Auditoria
created_at                  TIMESTAMPTZ
updated_at                  TIMESTAMPTZ

-- F7.c (2026-05-25): application_status DROPADO (migration 196). Era legado pré-funil canônico,
-- 100% redundante com application_funnel_stage + source. ADR-004.
-- Campo funnelStage no payload da API também removido (era alias redundante de internalStage).
```

### `worker_job_application_stage_history` — trilha de auditoria

Schema REAL em prod (verificado via psql 2026-05-25 — auditoria 09):

```
id              UUID PK DEFAULT gen_random_uuid()
application_id  UUID NOT NULL FK worker_job_applications(id)
field_name      VARCHAR(50) NOT NULL    -- 'application_funnel_stage' (genérico — suporta outros campos)
old_value       VARCHAR(50)             -- stage anterior (NULL em INSERTs)
new_value       VARCHAR(50) NOT NULL    -- stage novo
changed_by      VARCHAR(128)            -- vazio em prod hoje (TD-050)
change_source   VARCHAR(100)            -- vazio em prod hoje (TD-050)
created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

**TD-050:** docs anteriores falavam em `reason` e `metadata` — schema real é `changed_by` e `change_source`. Em prod ambas ficam vazias porque trigger usa `current_setting('app.current_uid', true)` mas backend nunca seta esse setting. Funcional pra detectar transições, limitada pra rastrear "quem mudou".

Insert-only. Nunca atualizar nem deletar.

**Limitação conhecida:** dados a partir de 2026-05-20 (data em que trigger 169 foi aplicado em prod). Bulk import de março-abril (7.599 workers) não está rastreado — esperado. Auditoria de 2026-05-25 confirmou **zero workers pós-trigger sem stage_history** (regressão zero). Detalhes em [09-auditoria-integridade.md](09-auditoria-integridade.md).

### `talentum_prescreenings` — log do estado externo

```
id                         UUID PK
talentum_prescreening_id   VARCHAR UNIQUE   -- chave de dedup do Talentum
talentum_profile_id        VARCHAR
worker_id                  UUID FK workers (nullable)
job_posting_id             UUID FK job_postings (nullable)
job_case_name              VARCHAR
status                     VARCHAR(20)   -- INITIATED | IN_PROGRESS | COMPLETED | ANALYZED
environment                VARCHAR(20)   -- production | test
created_at / updated_at    TIMESTAMPTZ
```

Esta tabela registra **o que o Talentum diz** — não confundir com `wja.application_funnel_stage`, que é o estado interno derivado.

### `talentum_questions` e `talentum_prescreening_responses`

Catálogo de Q&A do prescreening. Sem duplicação com outras tabelas. Manter inalteradas.

### `interview_slots` — blocos fixos do coordenador

```
id                UUID PK
coordinator_id    UUID FK coordinators
job_posting_id    UUID FK job_postings
slot_date         DATE
slot_time         TIME
slot_end_time     TIME
meet_link         VARCHAR(500)
max_capacity      INT
booked_count      INT
status            VARCHAR(20)   -- AVAILABLE | FULL | CANCELLED
```

**Débito técnico pendente (TD-026):** consolidar `slot_date + slot_time` em `slot_at TIMESTAMPTZ`. Não bloqueia esta consolidação.

### `encuadre_ambiguity_queue` — fila de resolução manual

Usada por `import-encuadres-from-clickup.ts` (em deprecação após F6 — ver TD-047) quando `case_number` mapeia mais de uma vaga. Mantida sem mudanças.

### Tabelas auxiliares de F5 (consolidação de duplicatas em encuadres)

Criadas pelas migrations 192/193 (commit `2cc7d06`):

- **`encuadres_backup_pre_f5`** — snapshot completo de `encuadres` antes da consolidação. Retenção: 14 dias após F5 estável em prod (TD-041).
- **`encuadres_consolidation_audit`** — trilha de quais encuadres duplicados foram fundidos no sobrevivente (richness score + recência). Colunas: `sobrevivente_id`, `deletado_id`, `worker_id`, `job_posting_id`, `sobrevivente_richness`, `deletado_richness`, `sobrevivente_origen`, `deletado_origen`, `deleted_at`.

**Estado atual:** F5 deployada em prod em **2026-05-25** (migrations 192/193). Tabelas auxiliares populadas; retenção de `encuadres_backup_pre_f5` por 14 dias até estabilidade (TD-041).

## Histórico de migrations deployadas em prod (F2-F8)

Todas deployadas em **2026-05-25** (Cloud Run revisão `worker-functions-00283-kxc`) com `schema_migrations` sincronizada manualmente após aplicação via `run-migration-prod.sh` (TD-049 documenta o gap do script).

| Migration | Fase | Mudança | Linhas afetadas |
|---|---|---|---|
| 190 | F2 | Remove `RECHAZADO` do CHECK + atualiza `funnel_stage_precedence` | DDL apenas |
| 191 | F3 | Backfill `NOT_QUALIFIED → REJECTED` (2463 rows) + remove do CHECK + atualiza função. Trigger 183 desabilitado durante backfill (workers INCOMPLETE_REGISTER) | 2.463 |
| 192 | F5 | Backup + consolidação atomic de duplicatas em `encuadres` (richness + recência) | 20.425 deletados |
| 193 | F5 | `UNIQUE (worker_id, job_posting_id)` em encuadres + atualiza trigger 189 | DDL apenas |
| 194 | F7.a | Remove `PLACED` do CHECK + UPDATE preventivo defensivo + atualiza `funnel_stage_precedence` (limpa `ANALYZED`) | DDL (0 rows com PLACED) |
| 195 | F7.b | Remove `REPROGRAM` do CHECK + atualiza `funnel_stage_precedence` | DDL (0 rows com REPROGRAM) |
| 196 | F7.c | DROP COLUMN `application_status` (+ recriação do trigger 183 sem essa coluna no UPDATE OF) | Coluna removida (12.258 rows) |
| 197 | F8 | RENAME `encuadres.origen` → `import_source_audit` + recriação do trigger 189 com nome novo | DDL apenas (34.223 rows) |

**Auditoria pós-deploy:** [09-auditoria-integridade.md](09-auditoria-integridade.md) confirmou em 2026-05-25 que 12.259/12.259 workers em prod estão íntegros em 3 camadas (DB × API × DOM).

## Tabela legada (em deprecação)

### `encuadres` — campos preservados vs deprecados

```
id                 UUID PK
worker_id          UUID FK workers
job_posting_id     UUID FK job_postings

-- ✅ MANTER: dados exclusivos da entrevista presencial (planilha histórica)
has_cv             BOOLEAN
has_dni            BOOLEAN
has_cert_at        BOOLEAN
has_afip           BOOLEAN
has_cbu            BOOLEAN
has_ap             BOOLEAN
has_seguros        BOOLEAN

-- ✅ MANTER: observações textuais pós-entrevista
obs_reclutamiento  TEXT
obs_encuadre       TEXT
obs_adicionales    TEXT

-- ✅ MANTER: role da candidatura
role               VARCHAR(20)   -- TITULAR | RAPID_RESPONSE

-- ✅ MANTER: resultado narrativo histórico (sem authority sobre stage)
resultado          VARCHAR        -- SELECCIONADO | RECHAZADO | AT_NO_ACEPTA | REPROGRAMAR | REEMPLAZO | BLACKLIST | PENDIENTE
accepts_case       VARCHAR(20)
attended           BOOLEAN
absence_reason     TEXT
rejection_reason   TEXT
rejection_reason_category VARCHAR(50)
redireccionamiento VARCHAR(200)

-- ✅ MANTER: identidade de display (fallback)
worker_raw_name    VARCHAR(200)
worker_raw_phone   VARCHAR(30)
occupation_raw     VARCHAR(100)

-- ✅ MANTER: metadados de recrutamento (planilha)
recruiter_name     VARCHAR(100)
coordinator_name   VARCHAR(100)
recruitment_date   DATE

-- ✅ MANTER: deduplicação histórica de import
dedup_hash         VARCHAR(64) UNIQUE

-- ✅ F8 (2026-05-25): renomeado de 'origen'. Auditoria de import histórico apenas — SSOT real é wja.source.
import_source_audit  VARCHAR(100)

-- ❌ DEPRECAR (read-only, parar de escrever em novos registros)
--    Substituídos pelos campos equivalentes em worker_job_applications
interview_date     DATE           -- → wja.interview_datetime
interview_time     TIME           -- → wja.interview_datetime
meet_link          VARCHAR(500)   -- → wja.interview_meet_link
interview_slot_id  UUID           -- → wja.interview_slot_id
reminder_day_sent_at   TIMESTAMPTZ
reminder_5min_sent_at  TIMESTAMPTZ

-- ❌ DEPRECAR: colunas LLM legadas
llm_*

created_at / updated_at  TIMESTAMPTZ
```

### Regra simples sobre `encuadres`

- **Leitura:** permitida. UI ainda exibe `obs_*`, `has_*`, `resultado` na ficha da candidatura.
- **Escrita em campos `✅ MANTER`:** permitida (são SSOT dos respectivos dados).
- **Escrita em campos `❌ DEPRECAR`:** **proibida em código novo.** Use `worker_job_applications` equivalente.
- **Novas colunas:** vão em `worker_job_applications`. Nunca em `encuadres`.

## Tabelas relacionadas (contexto)

| Tabela | Relação |
|---|---|
| `workers` | FK worker_id em WJA |
| `job_postings` | FK job_posting_id em WJA |
| `domain_events` | Outbox transacional — emite `funnel_stage.qualified`, `funnel_stage.rejected` etc. |
| `messaging_outbox` | Fila de mensagens WhatsApp/SMS — enfileirada por handlers |
