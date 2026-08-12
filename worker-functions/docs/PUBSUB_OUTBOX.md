# Pub/Sub & Messaging Outbox

> Sistema de mensageria assíncrona via Google Pub/Sub + Transactional Outbox Pattern.

---

## Visao Geral

O backend usa dois tópicos Pub/Sub com push subscriptions que chamam endpoints internos do Cloud Run. Todos os endpoints internos são protegidos pelo `InternalAuthMiddleware`, que aceita:

1. **OIDC Bearer token** — usado pelo Pub/Sub push (audience deve ser = `CLOUD_RUN_SERVICE_URL`)
2. **X-Internal-Secret header** — usado pelo Cloud Tasks

---

## Tópicos e Subscriptions

| Tópico | Subscription | Push endpoint | Função |
|---|---|---|---|
| `outbox-enqueued` | `outbox-push` | `/api/internal/outbox/process` | Processa mensagem da outbox (envia WhatsApp) |
| `talentum-prescreening-qualified` | `talentum-prescreening-qualified-push` | `/api/internal/events/process` | Processa domain event (agenda entrevista) |

### Config de autenticação (Pub/Sub → Cloud Run)

```
Push endpoint:    https://api.enlite.health/api/internal/...
OIDC audience:    https://worker-functions-121472682203.southamerica-west1.run.app
Service account:  pubsub-invoker@enlite-prd.iam.gserviceaccount.com
```

> **Importante:** o audience da subscription deve bater exatamente com a env var `CLOUD_RUN_SERVICE_URL` do Cloud Run. Se não bater, todas as mensagens falham com 403.

---

## Fluxo 1: Domain Events (`talentum-prescreening-qualified`)

```
Webhook Talentum → ProcessTalentumPrescreening
  └─ AT qualificado? → INSERT domain_events (funnel_stage.qualified)
     └─ pubsub.publish('talentum-prescreening-qualified', { eventId })
        └─ Pub/Sub push → POST /api/internal/events/process
           └─ DomainEventProcessor.processEvent(eventId)
              └─ QualifiedInterviewHandler
                 ├─ Gera 3 slots de entrevista
                 ├─ INSERT messaging_outbox (template: qualified_worker_request)
                 └─ pubsub.publish('outbox-enqueued', { outboxId })
```

### Handlers registrados

| Evento | Handler | Efeito |
|---|---|---|
| `funnel_stage.qualified` | `QualifiedInterviewHandler` | Gera slots de entrevista + envia convite WhatsApp |

---

## Fluxo 2: Messaging Outbox (`outbox-enqueued`)

Padrão **Transactional Outbox**: o use case insere na tabela `messaging_outbox` dentro da mesma transação do banco, depois publica no Pub/Sub para processamento assíncrono.

```
Use case → INSERT INTO messaging_outbox (status='pending')
  └─ pubsub.publish('outbox-enqueued', { outboxId })
     └─ Pub/Sub push → POST /api/internal/outbox/process
        └─ OutboxProcessor.processById(outboxId)
           └─ Envia mensagem WhatsApp via template
```

### Templates de mensagem

> **Vocabulário:** 'encuadre' nos nomes desses templates é o vocabulário operacional para WJA — ver [docs/features/worker-job-applications/02-vocabulario.md](../../docs/features/worker-job-applications/02-vocabulario.md). Templates permanecem com este nome por compatibilidade com WhatsApp HSM.

| Template slug | Trigger | Destinatário | Descrição |
|---|---|---|---|
| `qualified_worker_request` | AT qualificado (Talentum) | AT | Convite com 3 slots de entrevista |
| `qualified_worker_response` | AT escolhe horário via WhatsApp | AT | Confirmação do agendamento |
| `qualified_reminder_confirm` | Lembrete pré-entrevista | AT | "Confirma presença?" |
| `qualified_declined_admin` | AT recusa entrevista | Admin | Aviso de declínio |
| `encuadre_invitation` | Encuadre agendado | AT | Convite com link da reunião |
| `encuadre_reminder_day_before` | D-1 do encuadre | AT | Lembrete 1 dia antes |
| `encuadre_reminder_5min` | 5 min antes do encuadre | AT | Lembrete "começa em 5 min" |

### Tabela `messaging_outbox`

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | UUID | PK |
| `worker_id` | UUID | FK → workers |
| `template_slug` | text | Identificador do template WhatsApp |
| `variables` | jsonb | Variáveis para interpolação no template |
| `status` | text | `pending` → `sent` / `failed` |
| `attempts` | int | Contador de tentativas |

---

## Safety Nets (Cloud Scheduler)

Caso o Pub/Sub falhe ou perca mensagens, existem jobs periódicos como rede de segurança:

| Endpoint | Frequência | Função |
|---|---|---|
| `/api/internal/outbox/sweep` | A cada 5 min | Reprocessa mensagens `pending` órfãs |
| `/api/internal/events/sweep` | Periódico | Reprocessa domain events `pending` órfãos |
| `/api/internal/bulk-dispatch/process` | Diário (10h BRT) | Disparo em lote |

---

## Arquivos relevantes

| Arquivo | Responsabilidade |
|---|---|
| `src/interfaces/middleware/InternalAuthMiddleware.ts` | Auth OIDC + secret para endpoints internos |
| `src/interfaces/controllers/InternalController.ts` | Controller dos endpoints `/api/internal/*` |
| `src/interfaces/routes/internalRoutes.ts` | Definição das rotas internas |
| `src/infrastructure/events/PubSubClient.ts` | Client de publish/decode Pub/Sub |
| `src/infrastructure/events/DomainEventProcessor.ts` | Processa domain events por ID |
| `src/infrastructure/events/handlers/QualifiedInterviewHandler.ts` | Handler do evento `funnel_stage.qualified` |
| `src/infrastructure/services/OutboxProcessor.ts` | Processa e envia mensagens da outbox |
| `src/infrastructure/services/ReminderScheduler.ts` | Cria lembretes (encuadre + qualified) |
| `src/infrastructure/services/InterviewSchedulingService.ts` | Agenda entrevistas de encuadre |
| `src/application/use-cases/BookSlotFromWhatsAppUseCase.ts` | AT escolhe slot via WhatsApp |
| `src/application/use-cases/HandleReminderResponseUseCase.ts` | AT responde lembrete (confirma/recusa) |

---

## Troubleshooting

### 403 em `/api/internal/events/process` ou `/api/internal/outbox/process`

**Erro:** `[InternalAuth] OIDC token verification failed: Wrong recipient, payload audience != requiredAudience`

**Causa:** O audience da subscription Pub/Sub não bate com `CLOUD_RUN_SERVICE_URL`.

**Verificar:**
```bash
# Audience na subscription
gcloud pubsub subscriptions describe <SUBSCRIPTION> \
  --project=enlite-prd \
  --format='value(pushConfig.oidcToken.audience)'

# Env var no Cloud Run
gcloud run services describe worker-functions \
  --region=southamerica-west1 --project=enlite-prd \
  --format='yaml(spec.template.spec.containers[0].env)' | grep CLOUD_RUN_SERVICE_URL

# Corrigir audience
gcloud pubsub subscriptions update <SUBSCRIPTION> \
  --push-endpoint=<PUSH_URL> \
  --push-auth-service-account=pubsub-invoker@enlite-prd.iam.gserviceaccount.com \
  --push-auth-token-audience=<CLOUD_RUN_SERVICE_URL> \
  --project=enlite-prd
```

**Impacto do 403:** Nenhuma mensagem WhatsApp é enviada e nenhum domain event é processado. O sweep (a cada 5min) pode compensar parcialmente se usar `X-Internal-Secret`.
