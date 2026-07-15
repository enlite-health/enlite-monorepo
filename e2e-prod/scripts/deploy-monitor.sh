#!/usr/bin/env bash
#
# deploy-monitor.sh — empacota a suíte smoke de e2e-prod como Cloud Run Job e a
# agenda pra rodar diariamente às 3h (horário da Argentina) contra produção real.
#
# Convenção do monorepo (../CLAUDE.md): prd é gerenciado por gcloud MANUAL, não
# Terraform (terraform/ cobre só stg). Por isso a "IaC" deste monitor é este script.
#
# IDEMPOTENTE: rodar 2x não quebra — cada recurso é create-or-update. Seguro repetir.
#
# NÃO roda testes localmente; só provisiona a infra de prod. Pré-requisitos no README.md.
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuração (ajuste só se algum nome de recurso divergir do provisionado)
# ─────────────────────────────────────────────────────────────────────────────
PROJECT="enlite-prd"                                   # projeto GCP (confirmado: deploy do front)
REGION="southamerica-west1"                            # região do Job/Artifact Registry (MESMA do front/back prod)
# Cloud Scheduler NÃO existe em southamerica-west1 (região inválida pra Scheduler). O
# scheduler vive em southamerica-east1 (SP) — onde já está provisionado. Var separada de REGION.
SCHEDULER_REGION="southamerica-east1"
REPO="e2e-prod"                                        # repo Docker do Artifact Registry (confirmado: existe)
IMAGE_NAME="e2e-prod-smoke"                            # nome da imagem no repo
JOB_NAME="e2e-prod-smoke"                              # Cloud Run Job
SCHEDULER_NAME="e2e-prod-smoke-daily"                  # Cloud Scheduler que dispara o job

# ─────────────────────────────────────────────────────────────────────────────
# Credenciais do monitor — carregadas do .env.local do operador NO MOMENTO do deploy
# (gitignored; nunca hardcoded no script). A SENHA do admin vai pro Secret Manager
# (nunca em texto plano no env do job). A apiKey web do Firebase NÃO é segredo (já vai
# embarcada no bundle público do front) → env comum. Admin+Firebase são exigidos pelas
# jornadas (regression) e pelos testes admin, que agora rodam no job diário.
# ─────────────────────────────────────────────────────────────────────────────
ENV_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env.local"
if [[ -f "${ENV_LOCAL}" ]]; then
  set -a; # shellcheck disable=SC1090
  source "${ENV_LOCAL}"; set +a
fi
: "${E2E_ADMIN_EMAIL:?defina E2E_ADMIN_EMAIL no e2e-prod/.env.local antes do deploy}"
: "${E2E_ADMIN_PASSWORD:?defina E2E_ADMIN_PASSWORD no e2e-prod/.env.local antes do deploy}"
: "${FIREBASE_API_KEY:?defina FIREBASE_API_KEY no e2e-prod/.env.local antes do deploy}"
ADMIN_PW_SECRET="e2e-admin-password"                   # secret do Secret Manager (criado/atualizado abaixo)

# SA que o Cloud Scheduler usa pra INVOCAR o job (precisa de roles/run.invoker no job).
# Menor privilégio: uma SA dedicada só pra isso, não a default do projeto.
SCHEDULER_SA="e2e-prod-invoker@${PROJECT}.iam.gserviceaccount.com"

# SA de RUNTIME do job (identidade com que o container roda). A suíte smoke é read-only
# e não precisa de nenhuma permissão GCP — a default do Cloud Run já basta. Deixe vazio
# pra usar a default, ou aponte uma SA sem roles (menor privilégio explícito).
RUN_SA=""                                              # ex.: e2e-prod-runtime@${PROJECT}.iam.gserviceaccount.com

# URLs de produção (Cloud Run) — injetadas como env do job (12-factor; fora da imagem).
PROD_BASE_URL="https://enlite-frontend-byh3gvl5yq-tl.a.run.app"
PROD_API_URL="https://worker-functions-byh3gvl5yq-tl.a.run.app"

# Timezone do negócio (Argentina) — o cron "3h" é 3h local, não UTC.
TZ_ARG="America/Argentina/Buenos_Aires"
CRON_SCHEDULE="0 3 * * *"                              # todo dia às 03:00 (horário da Argentina)

# Tag imutável (rastreável) + :latest (o job sempre puxa o mais recente do deploy).
TAG="$(date +%Y%m%d-%H%M%S)"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${IMAGE_NAME}"
IMAGE_URI="${IMAGE_BASE}:${TAG}"
IMAGE_LATEST="${IMAGE_BASE}:latest"

# Raiz do projeto e2e-prod (este script vive em e2e-prod/scripts/).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_CONTEXT="$(cd "${HERE}/.." && pwd)"

echo "==> Projeto=${PROJECT}  Região=${REGION}  Job=${JOB_NAME}"
echo "==> Imagem=${IMAGE_URI}"

# ─────────────────────────────────────────────────────────────────────────────
# (a) Build + push da imagem pro Artifact Registry (via Cloud Build — não usa Docker local)
# ─────────────────────────────────────────────────────────────────────────────
# Empurra as duas tags (imutável + latest) no mesmo build, pra ter rastreio e um alvo estável.
echo "==> [a] Build + push da imagem (Cloud Build → Artifact Registry)"
gcloud builds submit "${BUILD_CONTEXT}" \
  --project="${PROJECT}" \
  --tag="${IMAGE_URI}"
# Marca o :latest apontando pro mesmo digest recém-buildado (sem rebuild).
gcloud container images add-tag "${IMAGE_URI}" "${IMAGE_LATEST}" \
  --quiet || true

# ─────────────────────────────────────────────────────────────────────────────
# (b) Cloud Run Job — create-or-update (gcloud run jobs deploy é idempotente por si)
# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
# (a.1) Secret Manager — senha do admin (nunca em env plano). Cria ou adiciona versão.
# ─────────────────────────────────────────────────────────────────────────────
echo "==> [a.1] Secret Manager: ${ADMIN_PW_SECRET} (senha do admin)"
if gcloud secrets describe "${ADMIN_PW_SECRET}" --project="${PROJECT}" >/dev/null 2>&1; then
  printf '%s' "${E2E_ADMIN_PASSWORD}" | gcloud secrets versions add "${ADMIN_PW_SECRET}" \
    --project="${PROJECT}" --data-file=-
else
  printf '%s' "${E2E_ADMIN_PASSWORD}" | gcloud secrets create "${ADMIN_PW_SECRET}" \
    --project="${PROJECT}" --replication-policy=automatic --data-file=-
fi
# A SA de runtime do job precisa de secretAccessor no secret (idempotente). Se RUN_SA vazio,
# o Cloud Run usa a compute default (mesma que já lê sendgrid-api-key).
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')"
RUNTIME_SA="${RUN_SA:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"
gcloud secrets add-iam-policy-binding "${ADMIN_PW_SECRET}" \
  --project="${PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

echo "==> [b] Deploy do Cloud Run Job (${JOB_NAME})"
RUN_JOB_ARGS=(
  "${JOB_NAME}"
  --project="${PROJECT}"
  --region="${REGION}"
  --image="${IMAGE_URI}"
  # CI=true → forbidOnly + workers no config. ENFORCE_COVERAGE=smoke → gate de cobertura com dentes.
  # MONITOR_ALERT_TO → destinatário do email (o reporter custom dispara a CADA run).
  # Credenciais (admin + Firebase) exigidas pelas JORNADAS (regression) e testes admin, que o
  # job agora exercita junto do smoke. FIREBASE_API_KEY é público (bundle do front) → env comum.
  --set-env-vars="PROD_BASE_URL=${PROD_BASE_URL},PROD_API_URL=${PROD_API_URL},ENFORCE_COVERAGE=smoke,CI=true,MONITOR_ALERT_TO=gabriel.g.stein@gmail.com,E2E_ADMIN_EMAIL=${E2E_ADMIN_EMAIL},FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN:-},FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-}"
  # Secrets (Secret Manager): SendGrid (email) + senha do admin (login staff das jornadas/admin).
  --set-secrets="SENDGRID_API_KEY=sendgrid-api-key:latest,E2E_ADMIN_PASSWORD=${ADMIN_PW_SECRET}:latest"
  --max-retries=1          # 1 retry de nível-job absorve blip de cold start/egress; alerta só em falha real
  --task-timeout=900s      # 15min: smoke + admin + jornadas reais (publish Talentum ~30s + teardown)
)
# SA de runtime só se definida (senão usa a default do Cloud Run).
if [[ -n "${RUN_SA}" ]]; then
  RUN_JOB_ARGS+=(--service-account="${RUN_SA}")
fi
gcloud run jobs deploy "${RUN_JOB_ARGS[@]}"

# ─────────────────────────────────────────────────────────────────────────────
# (b.1) IAM — a SA do Scheduler precisa de run.invoker NESTE job (menor privilégio)
# ─────────────────────────────────────────────────────────────────────────────
echo "==> [b.1] Concede roles/run.invoker à SA do Scheduler no job (idempotente)"
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker"

# ─────────────────────────────────────────────────────────────────────────────
# (c) Cloud Scheduler — dispara o Run Job via API REST, às 3h (Argentina)
# ─────────────────────────────────────────────────────────────────────────────
# Chamamos a API Admin do Cloud Run (:run). Como é *.googleapis.com, o auth correto é
# OAuth (--oauth-service-account-email), NÃO OIDC. Escopo default cloud-platform.
RUN_JOB_URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB_NAME}:run"

echo "==> [c] Cloud Scheduler (${SCHEDULER_NAME}) — cron '${CRON_SCHEDULE}' TZ ${TZ_ARG}"
SCHED_ARGS=(
  --project="${PROJECT}"
  --location="${SCHEDULER_REGION}"
  --schedule="${CRON_SCHEDULE}"
  --time-zone="${TZ_ARG}"
  --uri="${RUN_JOB_URI}"
  --http-method=POST
  --oauth-service-account-email="${SCHEDULER_SA}"
  --headers="Content-Type=application/json"
  --message-body='{}'
)
# Idempotência: existe? → update. Senão → create.
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" \
     --project="${PROJECT}" --location="${SCHEDULER_REGION}" >/dev/null 2>&1; then
  echo "    (existe → update)"
  gcloud scheduler jobs update http "${SCHEDULER_NAME}" "${SCHED_ARGS[@]}"
else
  echo "    (não existe → create)"
  gcloud scheduler jobs create http "${SCHEDULER_NAME}" "${SCHED_ARGS[@]}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# (d) ALERTA — TODO: notificar quando o job falhar (execuções com resultado 'failed')
# ─────────────────────────────────────────────────────────────────────────────
# O valor do monitor é o alerta: um smoke que falha às 3h e ninguém vê não protege nada.
# Deixado como TODO porque falta a DECISÃO do canal (email vs Slack) — o user preenche.
#
#   # 1) Canal de notificação (escolher UM — email OU Slack/webhook):
#   #    TODO(user): trocar o e-mail / configurar o webhook do Slack.
#   # gcloud beta monitoring channels create \
#   #   --project="${PROJECT}" \
#   #   --display-name="e2e-prod alerts" \
#   #   --type=email \
#   #   --channel-labels=email_address=TODO@enlite.health
#   # → anote o CHANNEL_ID retornado (projects/${PROJECT}/notificationChannels/NNN)
#
#   # 2) Alert policy sobre execuções falhas do Cloud Run Job.
#   #    Métrica: run.googleapis.com/job/completed_execution_count
#   #             filtrada por result="failed" e job_name="${JOB_NAME}".
#   #    Dispara se count > 0 na janela do run diário.
#   # gcloud alpha monitoring policies create \
#   #   --project="${PROJECT}" \
#   #   --notification-channels="projects/${PROJECT}/notificationChannels/TODO_CHANNEL_ID" \
#   #   --display-name="e2e-prod smoke FALHOU (prod)" \
#   #   --condition-display-name="job completed_execution_count result=failed > 0" \
#   #   --condition-filter='metric.type="run.googleapis.com/job/completed_execution_count"
#   #        AND resource.type="cloud_run_job"
#   #        AND resource.labels.job_name="'"${JOB_NAME}"'"
#   #        AND metric.labels.result="failed"' \
#   #   --condition-threshold-value=0 \
#   #   --condition-threshold-comparison=COMPARISON_GT \
#   #   --condition-threshold-duration=0s \
#   #   --combiner=OR
#
echo "==> [d] Alerta: TODO — criar notification channel + alert policy (ver bloco comentado acima)."

echo "==> OK. Job '${JOB_NAME}' agendado por '${SCHEDULER_NAME}' às ${CRON_SCHEDULE} (${TZ_ARG})."
echo "    Rodar manualmente agora:  gcloud run jobs execute ${JOB_NAME} --project=${PROJECT} --region=${REGION}"
