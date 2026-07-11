# scripts/ — deploy do synthetic monitor (Cloud Run Job + Scheduler)

`deploy-monitor.sh` empacota a **camada smoke** (read-only) da suíte e a agenda pra
rodar **todo dia às 3h (horário da Argentina)** contra produção real (`enlite-prd`).

Convenção do monorepo: **prd é gerenciado por gcloud manual, não Terraform**
(`terraform/` cobre só stg — ver `../../CLAUDE.md`). Por isso o provisionamento é este
script bash, não IaC.

## O que ele cria

| Recurso | Nome | Função |
|---|---|---|
| Imagem (Artifact Registry) | `e2e-prod-smoke` | Playwright + suíte, buildada via Cloud Build |
| Cloud Run Job | `e2e-prod-smoke` | roda `smoke` + `coverage-gate` com `ENFORCE_COVERAGE=smoke` |
| Cloud Scheduler | `e2e-prod-smoke-daily` | dispara o job via API `:run` no cron `0 3 * * *` (TZ Argentina) |

O job é read-only e **não usa nenhum segredo** — só as 2 URLs de prod (setadas como env
pelo próprio script). A suíte smoke não precisa de credencial admin.

## Pré-requisitos

1. **gcloud autenticado** no projeto `enlite-prd` com permissão pra Cloud Build, Cloud Run,
   Cloud Scheduler e IAM (`gcloud auth login` + `gcloud config set project enlite-prd`).
2. **Repo do Artifact Registry** já criado na região `southamerica-west1`
   (formato Docker). Se não existir:
   ```bash
   gcloud artifacts repositories create e2e-prod \
     --repository-format=docker --location=southamerica-west1 --project=enlite-prd
   ```
3. **SA do Scheduler** (`e2e-prod-invoker@enlite-prd.iam.gserviceaccount.com`) criada.
   O script já concede `roles/run.invoker` dela **no job** (menor privilégio). Se a SA
   ainda não existe:
   ```bash
   gcloud iam service-accounts create e2e-prod-invoker \
     --display-name="e2e-prod scheduler invoker" --project=enlite-prd
   ```
4. **APIs habilitadas**: `run.googleapis.com`, `cloudscheduler.googleapis.com`,
   `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `monitoring.googleapis.com`.

## Como rodar

```bash
cd e2e-prod
./scripts/deploy-monitor.sh
```

É **idempotente** — rodar de novo atualiza a imagem e reconfigura job/scheduler sem quebrar.

Disparar um run manual (fora do horário) pra validar:
```bash
gcloud run jobs execute e2e-prod-smoke --project=enlite-prd --region=southamerica-west1
```

## TODOs (o user preenche)

- **(a) Alvo do alerta** — o passo `(d)` do script está comentado. Falta a DECISÃO do canal
  (email vs Slack/webhook) e criar o notification channel + a alert policy sobre
  `run.googleapis.com/job/completed_execution_count` com `result="failed"`. Sem isso, um
  smoke que falha às 3h não notifica ninguém — o monitor perde o propósito.
- **(b) Nome do repo Artifact Registry** — o script assume `REPO=e2e-prod`. Confirmar o
  nome real do repo Docker em `southamerica-west1` (pode já existir um repo compartilhado
  de containers com outro nome) e ajustar a variável `REPO` no topo do script.
- **(c) Camada 2 (regression)** — quando a suíte de writes+teardown existir, decidir se ela
  entra **neste mesmo job** (env `ENFORCE_COVERAGE=all` + `--project=regression`) ou num
  **job/scheduler separado** com cadência própria (semanal) e a SA/segredos que os writes
  exigirem. O smoke diário deve continuar isolado e sem lixo.
