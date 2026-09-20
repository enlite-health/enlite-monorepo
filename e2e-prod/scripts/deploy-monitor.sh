#!/usr/bin/env bash
#
# deploy-monitor.sh — empacota a suíte e2e-prod como UM Cloud Run Job (imagem única, CMD
# unfiltered) e agenda DOIS Cloud Scheduler que o disparam com escopo DIFERENTE:
#
#   • e2e-prod-smoke-daily     — todo dia às 3h (Argentina): camadas READ-ONLY
#     (smoke + admin + coverage-gate + unit). Nunca escreve em prod.
#   • e2e-prod-regression-weekly — semanal (domingo, 4h Argentina): camada `regression`
#     (jornadas de ESCRITA reais + o novo `anacare-hours-sync.regression.ts`, que sincroniza
#     o mês corrente do Ana Care de verdade — ver e2e-prod/CLAUDE.md e o cabeçalho do spec).
#
# Por que DOIS agendamentos e não um `--project` cravado no CMD do Dockerfile: o guard
# `src/coverage/monitor-completeness.spec.ts` reprova o build se o CMD filtrar `--project`
# (proteção contra a regressão real de 2026-07: um `--project=smoke` no Dockerfile fez o
# schedule silenciosamente parar de rodar jornadas+admin). O CMD do Dockerfile continua
# `npx playwright test` SEM filtro — `gcloud run jobs execute` sem overrides (rodar manual,
# ver final deste script) ainda roda a suíte INTEIRA, como sempre. O que MUDA é só o corpo
# da requisição HTTP de CADA Scheduler: ele passa `overrides.containerOverrides[].args`
# pra API `:run` do Cloud Run (RunJobRequest), substituindo os args APENAS NAQUELA execução
# agendada — o Job e a imagem continuam os mesmos, e nada no Dockerfile muda.
#
# ⚠️ Achado que este script NÃO resolve sozinho (ver relatório da task que o gerou): se um
# projeto NOVO for adicionado a `playwright.config.ts` no futuro, ele PRECISA ser adicionado
# manualmente aos `args` de um dos dois blocos abaixo (ou de ambos) — o guard do Dockerfile
# só garante que o projeto roda no `gcloud run jobs execute` MANUAL, não em nenhum dos dois
# schedules. Não há guard automático pra isso ainda.
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
JOB_NAME="e2e-prod-smoke"                              # Cloud Run Job (ÚNICO — os dois schedules abaixo disparam o MESMO job)
SCHEDULER_NAME="e2e-prod-smoke-daily"                  # Cloud Scheduler DIÁRIO — camadas read-only (smoke+admin+coverage-gate+unit)
SCHEDULER_NAME_REGRESSION="e2e-prod-regression-weekly" # Cloud Scheduler SEMANAL — camada regression (writes reais, ver cabeçalho)

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

# Timezone do negócio (Argentina) — os crons abaixo são hora LOCAL, não UTC.
TZ_ARG="America/Argentina/Buenos_Aires"
CRON_SCHEDULE="0 3 * * *"                              # DIÁRIO — todo dia às 03:00 (Argentina): smoke+admin+coverage-gate+unit
# SEMANAL — domingo às 04:00 (Argentina): 1h DEPOIS do diário, de propósito (mesmo Job/mesma
# SA; nunca duas execuções do MESMO Job simultâneas por acidente de agenda — elas já são
# independentes por design do Cloud Run Jobs, mas não há motivo pra arriscar).
CRON_SCHEDULE_REGRESSION="0 4 * * 0"

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
# (c) Cloud Scheduler — DOIS jobs, o MESMO Cloud Run Job, escopo diferente por Scheduler
# ─────────────────────────────────────────────────────────────────────────────
# Chamamos a API Admin do Cloud Run (:run). Como é *.googleapis.com, o auth correto é
# OAuth (--oauth-service-account-email), NÃO OIDC. Escopo default cloud-platform.
#
# O corpo (`--message-body`) é o `RunJobRequest` da API. `overrides.containerOverrides[].args`
# substitui os args do CONTAINER só NESTA execução (o Job/imagem/CMD default não mudam — ver
# cabeçalho do arquivo). Como o Dockerfile não define `ENTRYPOINT` (só `CMD` em exec-form), o
# Cloud Run trata o `CMD` inteiro como `args` (não há `command`/entrypoint pra separar) —
# por isso o override abaixo repete `npx playwright test` por completo, não só as flags novas.
# ⚠️ Isto é inferido da semântica documentada do Cloud Run Jobs + do Dockerfile SEM
# `ENTRYPOINT` — não foi confirmado rodando (este script não é executado por mim, ver
# NÃO EXECUTADO no relatório). Antes do primeiro cron real, confirme com
# `gcloud run jobs describe ${JOB_NAME} --project=${PROJECT} --region=${REGION} --format=json`
# que o container não tem `command` próprio (senão o override de `args` precisaria mudar).
RUN_JOB_URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB_NAME}:run"

# ── (c.1) DIÁRIO — smoke + admin + coverage-gate + unit (READ-ONLY; nunca escreve em prod) ──
# `admin` depende de `admin-setup` (login real) — Playwright SEMPRE roda as dependências de um
# projeto filtrado, mesmo sem listá-las em `--project` (comportamento nativo do test runner),
# então não precisamos adicionar `--project=admin-setup` à mão.
echo "==> [c.1] Cloud Scheduler (${SCHEDULER_NAME}) — DIÁRIO, cron '${CRON_SCHEDULE}' TZ ${TZ_ARG}"
DAILY_ARGS_JSON='{"overrides":{"containerOverrides":[{"args":["npx","playwright","test","--project=smoke","--project=admin","--project=coverage-gate","--project=unit"]}]}}'
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
  --message-body="${DAILY_ARGS_JSON}"
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

# ── (c.2) SEMANAL — regression (writes reais + anacare-hours-sync, decisão do Gabriel 20/09) ──
# `overrides.timeout` (Duration da API, campo do NÍVEL `overrides`, não do container) estende o
# `--task-timeout=900s` (15min) do Job SÓ NESTA execução — o default do Job (usado pelo diário e
# por `gcloud run jobs execute` manual) continua 900s. Por quê precisa de mais: a suíte
# `regression` sozinha já levava "~5min a suíte toda" (comentário de `playwright.config.ts`); o
# novo `anacare-hours-sync.regression.ts` deixa o laço de sync rodar até o fim de propósito
# (~7min medidos na stage, timeout de teste dimensionado em 10min pra prod real — ver o cabeçalho
# do spec) e o projeto `regression` tem `retries:1` (warm-up) — no PIOR caso (retry completo desse
# teste) a run semanal pode passar de 900s. 1800s (30min) dá margem sem comprometer o Job diário,
# que não usa este override.
echo "==> [c.2] Cloud Scheduler (${SCHEDULER_NAME_REGRESSION}) — SEMANAL, cron '${CRON_SCHEDULE_REGRESSION}' TZ ${TZ_ARG}"
REGRESSION_ARGS_JSON='{"overrides":{"containerOverrides":[{"args":["npx","playwright","test","--project=regression"]}],"timeout":"1800s"}}'
SCHED_ARGS_REGRESSION=(
  --project="${PROJECT}"
  --location="${SCHEDULER_REGION}"
  --schedule="${CRON_SCHEDULE_REGRESSION}"
  --time-zone="${TZ_ARG}"
  --uri="${RUN_JOB_URI}"
  --http-method=POST
  --oauth-service-account-email="${SCHEDULER_SA}"
  --message-body="${REGRESSION_ARGS_JSON}"
)
if gcloud scheduler jobs describe "${SCHEDULER_NAME_REGRESSION}" \
     --project="${PROJECT}" --location="${SCHEDULER_REGION}" >/dev/null 2>&1; then
  echo "    (existe → update)"
  gcloud scheduler jobs update http "${SCHEDULER_NAME_REGRESSION}" "${SCHED_ARGS_REGRESSION[@]}" \
    --update-headers="Content-Type=application/json"
else
  echo "    (não existe → create)"
  gcloud scheduler jobs create http "${SCHEDULER_NAME_REGRESSION}" "${SCHED_ARGS_REGRESSION[@]}" \
    --headers="Content-Type=application/json"
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

echo "==> OK. Job '${JOB_NAME}' agendado por DOIS Schedulers:"
echo "    '${SCHEDULER_NAME}' (diário, ${CRON_SCHEDULE} ${TZ_ARG}) → smoke+admin+coverage-gate+unit"
echo "    '${SCHEDULER_NAME_REGRESSION}' (semanal, ${CRON_SCHEDULE_REGRESSION} ${TZ_ARG}) → regression"
echo "    Rodar manualmente a suíte INTEIRA agora (sem overrides, todos os projetos):"
echo "      gcloud run jobs execute ${JOB_NAME} --project=${PROJECT} --region=${REGION}"
echo "    Rodar manualmente só a regression (mesmos overrides do semanal):"
echo "      gcloud run jobs execute ${JOB_NAME} --project=${PROJECT} --region=${REGION} --args=npx,playwright,test,--project=regression"
