# syntax=docker/dockerfile:1
#
# e2e-prod — synthetic monitoring (Playwright contra enlite-prd)
#
# Base: imagem oficial Playwright já vem com os browsers instalados e as libs de
# sistema casadas com a versão do runtime. Fixamos v1.49.0-jammy pra casar com
# "@playwright/test": "^1.49.0" do package.json — mismatch entre browser e client
# do Playwright é fonte clássica de flake. NÃO rodar `playwright install` aqui:
# a imagem base já tem os navegadores; reinstalar só incha o layer.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# 1) Só os manifestos primeiro → cache de layer do npm ci não invalida quando só
#    os specs mudam. package-lock.json é obrigatório pro `npm ci` (build reproduzível).
COPY package.json package-lock.json ./

# 2) Instala EXATAMENTE o lockfile (determinístico). Inclui devDependencies
#    (@playwright/test, tsx, typescript) — são o que a suíte usa em runtime.
RUN npm ci

# 3) Código da suíte: config + tsconfig + as duas camadas que o job exercita.
#    (regression/ e .env* ficam de fora — ver .dockerignore.)
COPY tsconfig.json playwright.config.ts ./
COPY smoke/ ./smoke/
COPY src/ ./src/

# Ambiente do monitor. As URLs de prod são injetadas pelo Cloud Run Job (deploy-monitor.sh),
# NÃO embutidas na imagem (12-factor + permite apontar pra outro ambiente sem rebuild).
# CI=true → forbidOnly + workers=2 no config. ENFORCE_COVERAGE=smoke → gate com dentes.
ENV CI=true \
    ENFORCE_COVERAGE=smoke

# Job diário: smoke (o monitor read-only) + coverage-gate (a garantia de que nenhuma
# rota user-facing crítica ficou sem spec). Exit != 0 → o Cloud Run Job falha → alerta.
CMD ["npx", "playwright", "test", "--project=smoke", "--project=coverage-gate"]
