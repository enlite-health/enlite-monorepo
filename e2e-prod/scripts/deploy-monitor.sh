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
MCP_TOKEN_SECRET="e2e-mcp-token"                       # token do principal MCP `e2e-prod` (Spec 009 · 3.2b)

# IAM que a jornada do paciente exige na SA do JOB (concedidos 2026-07-30):
#   • roles/logging.viewer no projeto        → ler os logs reais (Cloud Logging)
#   • roles/iam.serviceAccountTokenCreator   → SÓ em enlite-functions-sa, para
#     assinar o JWT de Domain-Wide Delegation e LER a agenda de admissão. A SA do
#     runner não ganha nada além disso: sem banco, sem secrets, sem escrita.
#     (Autorizar a SA do runner direto na DWD exigiria ação de admin do Workspace.)
#
# SA que o Cloud Scheduler usa pra INVOCAR o job (precisa de roles/run.invoker no job).
# Menor privilégio: uma SA dedicada só pra isso, não a default do projeto.
SCHEDULER_SA="e2e-prod-invoker@${PROJECT}.iam.gserviceaccount.com"

# SA de RUNTIME do job (identidade com que o container roda). Menor privilégio: SA dedicada
# `e2e-prod-runtime` (sem roles GCP amplos), a MESMA já provisionada no job e que lê o
# sendgrid-api-key. É a ela que o grant de secretAccessor (senha do admin) precisa ir —
# NÃO à compute default. Explícita pra grant e deploy ficarem consistentes.
RUN_SA="e2e-prod-runtime@${PROJECT}.iam.gserviceaccount.com"

# URLs de produção (Cloud Run) — injetadas como env do job (12-factor; fora da imagem).
# O domínio REAL do portal — o mesmo que a prestadora digita. Não é cosmético:
# o CORS do bucket `enlite-worker-documents` autoriza `app.enlite.health` e a
# run.app numérica, mas NÃO a variante em hash que estava aqui. Com ela, subir
# documento pelo navegador morria em "Failed to fetch" (medido 31/08/2026).
PROD_BASE_URL="https://app.enlite.health"
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
  --set-env-vars="PROD_BASE_URL=${PROD_BASE_URL},PROD_API_URL=${PROD_API_URL},ENFORCE_COVERAGE=smoke,CI=true,MONITOR_ALERT_TO=gabriel.g.stein@gmail.com,E2E_ADMIN_EMAIL=${E2E_ADMIN_EMAIL},FIREBASE_API_KEY=${FIREBASE_API_KEY},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN:-},FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-},GCP_PROJECT_ID=${GCP_PROJECT_ID:-enlite-prd},ADMISSION_IMPERSONATE_EMAIL=${ADMISSION_IMPERSONATE_EMAIL:-enlite@enlite.health},ADMISSION_CALENDAR_ID_AR=${ADMISSION_CALENDAR_ID_AR},ADMISSION_CALENDAR_ID_BR=${ADMISSION_CALENDAR_ID_BR},DWD_SIGNER_SA=${DWD_SIGNER_SA:-enlite-functions-sa@enlite-prd.iam.gserviceaccount.com},MCP_URL=${MCP_URL:-https://worker-functions-mcp-byh3gvl5yq-tl.a.run.app/mcp/v1}"
  # Secrets (Secret Manager): SendGrid (email) + senha do admin (login staff das jornadas/admin)
  # + o token do principal MCP `e2e-prod` (Spec 009 · 3.2b).
  #
  # MCP_TOKEN é o token de UM principal com UMA capability (worker.interview.slots.list) —
  # ele NÃO carrega a allowlist, que vive do lado do MCP em `mcp-principal-e2e-prod`. Sem o
  # secret o teste de fuso PULA com o motivo escrito; ele nunca falha por credencial ausente.
  --set-secrets="SENDGRID_API_KEY=sendgrid-api-key:latest,E2E_ADMIN_PASSWORD=${ADMIN_PW_SECRET}:latest,MCP_TOKEN=${MCP_TOKEN_SECRET}:latest"
  --max-retries=0          # retry no nível-job re-executa a suíte inteira e duplica o email de alerta em teste falho
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
# Args comuns a create e update. O flag de HEADER difere entre os dois subcomandos:
# `create http` usa --headers; `update http` usa --update-headers (--headers é inválido lá).
SCHED_ARGS=(
  --project="${PROJECT}"
  --location="${SCHEDULER_REGION}"
  --schedule="${CRON_SCHEDULE}"
  --time-zone="${TZ_ARG}"
  --uri="${RUN_JOB_URI}"
  --http-method=POST
  --oauth-service-account-email="${SCHEDULER_SA}"
  --message-body='{}'
)
# Idempotência: existe? → update. Senão → create.
if gcloud scheduler jobs describe "${SCHEDULER_NAME}" \
     --project="${PROJECT}" --location="${SCHEDULER_REGION}" >/dev/null 2>&1; then
  echo "    (existe → update)"
  gcloud scheduler jobs update http "${SCHEDULER_NAME}" "${SCHED_ARGS[@]}" \
    --update-headers="Content-Type=application/json"
else
  echo "    (não existe → create)"
  gcloud scheduler jobs create http "${SCHEDULER_NAME}" "${SCHED_ARGS[@]}" \
    --headers="Content-Type=application/json"
fi

# ─────────────────────────────────────────────────────────────────────────────
# (d) ALERTA — já existe, vive no Terraform (não aqui)
# ─────────────────────────────────────────────────────────────────────────────
# google_monitoring_alert_policy.e2e_prod_smoke_execution_failed em
# terraform/environments/prd/events.tf reusa o canal já existente
# (var.events_notification_channel, e-mail gabriel.g.stein@gmail.com). NÃO criar
# canal nem policy por `gcloud` aqui: recurso feito à mão em prd vira desvio de
# estado contra o Terraform (regra dura do monorepo) e não fecha até estar no HCL.
echo "==> [d] Alerta: TODO — criar notification channel + alert policy (ver bloco comentado acima)."

echo "==> OK. Job '${JOB_NAME}' agendado por '${SCHEDULER_NAME}' às ${CRON_SCHEDULE} (${TZ_ARG})."
echo "    Rodar manualmente agora:  gcloud run jobs execute ${JOB_NAME} --project=${PROJECT} --region=${REGION}"
