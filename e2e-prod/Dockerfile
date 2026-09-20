# syntax=docker/dockerfile:1
#
# e2e-prod — synthetic monitoring (Playwright contra enlite-prd)
#
# Base: imagem oficial Playwright já vem com os browsers instalados e as libs de
# sistema casadas com a versão do runtime. Fixamos v1.49.0-jammy pra casar com
# "@playwright/test": "^1.49.0" do package.json — mismatch entre browser e client
# do Playwright é fonte clássica de flake. NÃO rodar `playwright install` aqui:
# a imagem base já tem os navegadores; reinstalar só incha o layer.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# 1) Só os manifestos primeiro → cache de layer do npm ci não invalida quando só
#    os specs mudam. package-lock.json é obrigatório pro `npm ci` (build reproduzível).
COPY package.json package-lock.json ./

# 2) Instala EXATAMENTE o lockfile (determinístico). Inclui devDependencies
#    (@playwright/test, tsx, typescript) — são o que a suíte usa em runtime.
RUN npm ci

# 3) Código da suíte INTEIRA — COPY . . (o .dockerignore exclui node_modules/.env*/.auth/
#    test-results/.claude/.git). Copiar TUDO (não cherry-pick de dirs) é o que garante que
#    um teste/spec NOVO entre na imagem AUTOMATICAMENTE, sem ninguém precisar editar este
#    Dockerfile. O `npm ci` acima fica em layer separado (cache preservado); só este último
#    layer rebuilda quando um spec muda.
COPY . .

# Ambiente do monitor. As URLs de prod + credenciais (admin/Firebase) são injetadas pelo
# Cloud Run Job (deploy-monitor.sh), NÃO embutidas na imagem (12-factor; segredo via Secret
# Manager, nunca em texto plano na imagem). CI=true → forbidOnly + workers no config.
ENV CI=true \
    ENFORCE_COVERAGE=smoke

# Este CMD roda SEM filtro --project DE PROPÓSITO — não é "o job diário roda tudo". O guard
# `monitor-completeness.spec.ts` exige exatamente isto (CMD sem --project) e é o que o disparo
# MANUAL do Job usa (`gcloud run jobs execute` sem overrides). Mas quem decide o que roda TODO
# DIA não é mais este CMD: o Cloud Scheduler `e2e-prod-smoke-daily` sobrescreve os `args` via
# `overrides.containerOverrides[]` (RunJobRequest) pra rodar só smoke+admin+coverage-gate+unit
# (read-only); `regression` (writes reais) tem agendamento PRÓPRIO, semanal, no Scheduler
# `e2e-prod-regression-weekly` (domingo 4h AR) — ver `scripts/deploy-monitor.sh`. Projeto NOVO
# precisa ser registrado no playwright.config.ts E incluído em UM dos dois blocos de `args` de
# `scripts/deploy-monitor.sh` — senão ele roda só no disparo manual (`--project` deste CMD) e
# fica ÓRFÃO de qualquer schedule automático. Exit != 0 do CMD → o Job falha → alerta.
CMD ["npx", "playwright", "test"]
