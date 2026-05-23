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
source                      VARCHAR(50)   -- talent_search | manual | talentum
acquisition_channel         VARCHAR(50)
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

-- Coluna deprecada (remover em F4)
-- application_status        VARCHAR(20)   -- legado pré-funil canônico
```

### `worker_job_application_stage_history` — trilha de auditoria

```
id           UUID PK
wja_id       UUID FK worker_job_applications
from_stage   VARCHAR(30)
to_stage     VARCHAR(30)
reason       VARCHAR(100)   -- TALENTUM_WEBHOOK | ADMIN_DRAG | REPROGRAMAR | AUTO_REJECT_NOT_QUALIFIED
metadata     JSONB
created_at   TIMESTAMPTZ
created_by   VARCHAR(100)   -- 'system' ou user_id
```

Insert-only. Nunca atualizar nem deletar.

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

Usada por `import-encuadres-from-clickup.ts` quando `case_number` mapeia mais de uma vaga. Mantida sem mudanças.

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

-- 🟡 RENOMEAR em F8: origen → import_source_audit
origen             VARCHAR(100)

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
