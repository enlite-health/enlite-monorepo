# Import — infra de outbox / domain-events (enlite-prd)

Estes recursos foram criados **manualmente via gcloud** durante o incidente do
sync AnaCare (jul/2026) e são adotados pelo Terraform **sem recriação**. O HCL
vive em `events.tf`. Este guia importa cada recurso pro state e verifica no-op.

> **NÃO rode `terraform apply` antes do `plan` estar limpo.** Se algum recurso
> destas linhas ainda não estiver no state e você aplicar, o TF pode tentar
> recriar (Pub/Sub/scheduler) ou sobrescrever alertas em produção.

## Pré-requisitos

```bash
cd infra/terraform/environments/prd
gcloud auth application-default login
export GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=tf-admin@enlite-prd.iam.gserviceaccount.com
terraform init
```

## Comandos de import (um por recurso)

```bash
# --- Pub/Sub topics ---
terraform import google_pubsub_topic.worker_mirror_requested \
  projects/enlite-prd/topics/worker-mirror-requested

terraform import google_pubsub_topic.worker_registration_completed \
  projects/enlite-prd/topics/worker-registration-completed

# --- Pub/Sub push subscriptions ---
terraform import google_pubsub_subscription.worker_mirror_requested_push \
  projects/enlite-prd/subscriptions/worker-mirror-requested-push

terraform import google_pubsub_subscription.worker_registration_completed_push \
  projects/enlite-prd/subscriptions/worker-registration-completed-push

# --- Cloud Scheduler jobs (região southamerica-east1) ---
terraform import google_cloud_scheduler_job.events_health \
  projects/enlite-prd/locations/southamerica-east1/jobs/events-health

terraform import google_cloud_scheduler_job.events_sweep_safe \
  projects/enlite-prd/locations/southamerica-east1/jobs/events-sweep-safe

# --- Log-based metrics (ID = nome da métrica) ---
terraform import google_logging_metric.domain_event_delivery_failure \
  domain_event_delivery_failure

terraform import google_logging_metric.domain_event_backlog_stuck \
  domain_event_backlog_stuck

# --- Alert policies (ID = resource name completo) ---
terraform import google_monitoring_alert_policy.domain_event_delivery_failure \
  projects/enlite-prd/alertPolicies/2331726307622468602

terraform import google_monitoring_alert_policy.domain_event_backlog_stuck \
  projects/enlite-prd/alertPolicies/2881189405565742499
```

> O **data source** `data.google_secret_manager_secret_version.internal_token`
> NÃO se importa — data sources resolvem no `plan`/`apply`, não guardam estado.

## Verificação obrigatória

```bash
terraform plan
```

O objetivo é **"No changes. Your infrastructure matches the configuration."**
Se aparecer diff, ajuste o HCL até dar no-op — **não** aplique pra "corrigir".

### Diffs esperados / benignos

1. **Header `User-Agent` nos schedulers** — o serviço injeta
   `User-Agent: Google-Cloud-Scheduler` automaticamente. O provider normalmente
   ignora esse header no diff. Se ele aparecer como "a remover", NÃO adicione ele
   ao HCL (é read-only server-side) — confirme que é só o User-Agent e siga.
2. **`body` do `events-sweep-safe`** — o state guarda `e30=` (base64 de `{}`).
   O HCL usa `base64encode("{}")`, que resolve pra `e30=`. Deve casar.
3. **`X-Internal-Secret`** — resolvido do secret `internal-token-secret`, cujo
   valor é idêntico ao que estava inline (verificado byte-a-byte). No-op.
4. **`threshold_value = 0`** nos alertas — o describe não mostra o campo porque
   `0` é o default da API; declarar `0` explícito casa com o state.
5. **`message_retention_duration` / `expiration_policy.ttl`** — declarados com os
   valores default (604800s / 2678400s) exatamente como o describe retornou.

## Fonte da verdade (gcloud describe usado pra escrever o HCL)

- `gcloud pubsub topics describe <t> --project enlite-prd`
- `gcloud pubsub subscriptions describe <s> --project enlite-prd`
- `gcloud scheduler jobs describe <j> --location southamerica-east1 --project enlite-prd`
- `gcloud logging metrics describe <m> --project enlite-prd`
- `gcloud alpha monitoring policies describe <id> --project enlite-prd`
