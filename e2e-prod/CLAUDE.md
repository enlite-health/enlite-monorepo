# e2e-prod — Suíte de testes E2E reais em produção (synthetic monitoring)

> **Como este arquivo carrega:** só este `CLAUDE.md` auto-carrega ao trabalhar em `e2e-prod/`.
> O conteúdo pesado (histórico, decisões detalhadas, matriz de cobertura) vive em
> `.claude/docs/` e é lido sob demanda pelos ponteiros daqui. Convenções de código, quando
> houver, vão pra `.claude/rules/*.md` (frontmatter `paths:`, auto-carregam só no arquivo casado).
> Preferências pessoais/gitignored → `CLAUDE.local.md`. O `CLAUDE.md` da raiz do monorepo
> (`../CLAUDE.md`) continua valendo — este só ADICIONA regras deste subprojeto.

## O que é este projeto

Suíte de **synthetic monitoring**: testes Playwright E2E que rodam **contra produção real**
(enlite-prd), diariamente (~3h), simulando um usuário de verdade — caminho feliz **e**
caminhos de erro (usuário erra, tenta o que não pode). Objetivo: **garantir, por evidência
determinística, que TODOS os fluxos user-facing funcionam** e que cada gate/validação barra
com a mensagem certa. Não é E2E de CI (isso já existe, local/mock); é monitor de prod.

Pessoas: Gabriel (dono do produto, GCP-native, aprendendo E2E/monitoring junto) + Claude (par).

## Meu papel (Claude) — regras que NÃO saem da linha

- **Explicar o porquê**, não só o como — o user está construindo junto (mentor + par).
- **Evidência, não alegação**: nunca afirmar que algo funciona sem exercitar e observar
  (rodar, testar, ler o resultado). Verificação determinística > opinião do modelo.
- **Eu testo ANTES do user**: bancada/harness/smoke próprios, provar localmente antes de
  pedir validação — o user não é cobaia. Teste do user falhou? Primeira pergunta: "por que
  EU não peguei isso?" → vira instrumentação nova (log, teste automatizado).
- **Segurança primeiro**: menor privilégio (credencial por-recurso, nunca ampla); segredo
  nunca em texto plano/log/URL (rotacionar na hora se vazar); binários com hash pinado;
  superfície mínima; PII/sensível nunca pra serviço sem enquadramento legal. Apresentar os
  pontos fracos da solução com honestidade. (Plataforma de saúde — PII é levado a sério.)
- **Honestidade sobre custo/risco**: toda recomendação vem com custo (R$, tempo, manutenção)
  explícito; quando um custo mudar, avisar sem ser perguntado.
- **Documentar CADA passo NO MOMENTO em que conclui** (não no fim): comandos, artefatos,
  resultados verificados, pendências → `.claude/docs/diario.md` (append-only). Decisões →
  `.claude/docs/decisoes.md`. Estado → Status abaixo (checkbox só marca depois de VER funcionar).
- **Manter a linha entre chats** — este arquivo + docs existem pra isso.
- **Parceria**: toda pergunta a sério (pergunta "boba" não existe — várias viraram arquitetura);
  celebrar marcos; correção de rumo do user = decisão registrada, não derrota.
- **Aprender NA HORA**: correção → memória automática (type feedback, com o porquê) na hora.
  Bug corrigido → vira TESTE de regressão. Fim de bloco → `/retro`.

## Regras técnicas específicas desta suíte (o "nunca sair da linha" do E2E)

1. **Zero mock na suíte de prod.** `page.route()` é BANIDO aqui. Erro de negócio (400/403/404/
   WORKER_NOT_ELIGIBLE) se testa REAL (prod rejeita input ruim de verdade, sem efeito colateral).
   Erro de infra (500/timeout) NÃO se testa — se MONITORA (assere que prod NÃO retorna 500).
2. **Teardown garantido.** Tudo que a suíte cria leva marca inequívoca (email `gabriel+e2e-<data>@`,
   prefixo `[E2E]`). Cleanup em 2 níveis: afterEach/afterAll (normal) + **sweeper idempotente**
   que roda ANTES da suíte e limpa órfãos por marca (rede de segurança se um teste morre no meio).
3. **Setup/teardown via API; fluxo sob teste via UI.** Cria o estado por API (rápido), dirige a
   tela como usuário real no que importa, remove por API. Nada de clicar 10 forms de setup.
4. **Localizar como usuário**: `getByRole`/`getByText`/`getByLabel`; `getByTestId` como fallback
   estável (atenção: front é i18n ES/EN — texto puro pode variar de idioma).
5. **Web-first assertions** (`await expect(...).toBeVisible()`); NUNCA `waitForTimeout` cru.
   Cold-start Cloud Run → timeout tolerante + 1 retry de warm-up no smoke.
6. **Duas camadas**: `smoke/` (read-only, diário, UI + API health — o monitor de verdade, sem
   lixo) · `regression/` (writes + marca + sweeper + teardown, semanal/sob-demanda).
7. **Garantia de cobertura = gate de CI**: meta-teste cruza o manifesto de rotas user-facing
   (denominador) × specs (numerador). Rota user-facing sem spec = build vermelho. O que fica de
   fora (máquina-a-máquina, morto) está numa allowlist justificada, não esquecido.
8. **Resultados**: HTML reporter + trace `on-first-retry` (artefato por run) + JSON/JUnit;
   em prod, falha → alerta Cloud Monitoring/Slack (retry antes de alertar; só falha consecutiva).

## Decisões e restrições já firmadas (detalhe em `.claude/docs/decisoes.md`)

1. **Local**: `e2e-prod/` como projeto IRMÃO na raiz do monorepo (não dentro de enlite-frontend —
   suíte é cross-cutting UI+API; monitor caixa-preta não acopla helper interno do front).
2. **Runner**: Cloud Scheduler → Cloud Run Job (GCP-native), IaC em `terraform/synthetic-monitoring/`.
   NÃO GitHub Actions cron (desliga sozinho após 60d sem commit + sem SLA de horário).
3. **Ambiente**: PROD real, conta real, com teardown obrigatório de tudo que criar.
4. **Objetivo em camadas**: smoke diário + regressão completa.
5. **Estado inicial**: nada testava prod hoje (campo limpo); reusar padrão de teardown da
   jornada de staging (`enlite-frontend/e2e/staging-journey-clean.e2e.ts`).

## Status atual

> 🔴 **PRIORIDADE #1 — A RAZÃO DE EXISTIR DA SUÍTE: cobrir JORNADAS REAIS ponta-a-ponta.**
> Hoje a suíte tem **0 cobertura happy** (`@depth:happy=0`) — só casca (render + validação + auth
> negativo). Construir a **jornada worker real** (cadastro → REGISTERED → postularse) é o topo do
> backlog, acima de qualquer novo smoke/erro. Bloqueios já caíram (gate AnaCare deployado + desenho
> de conta firmado). Ver memórias `project_e2e_prod_real_journeys_top_priority` e
> `project_e2e_worker_journey_design`, e a entrada 2026-07-13 em `.claude/docs/decisoes.md`.

- [x] Mapeado E2E existente (nada roda em prod hoje — confirmado por evidência)
- [x] Manifesto determinístico de rotas front+back extraído (denominador da cobertura)
- [x] Best practices Playwright pesquisadas (fontes em decisoes.md)
- [x] Arquitetura firmada (local, runner, camadas, teardown, no-mock, gate de cobertura)
- [x] Sistema de trabalho contínuo plantado (este arquivo + `.claude/docs/`)
- [x] Esqueleto base: `package.json` + `tsconfig` + `.gitignore` + `playwright.config.ts` (env-param, 2 camadas + coverage-gate)
- [x] Recon de ambiente prod concluída (URLs/Firebase/auth em `.env.example`; VEREDITO poluição: writes em prod bloqueados)
- [x] **~76 testes VERDES contra prod** (51 smoke/erro-público + 25 admin incl. login+erros) — cobertura **86%** (56/65), 0 órfãs. Profundidade: auth 22 · smoke 14 · **erro 16** · **happy 0**
- [x] Conta dedicada `gabriel+e2e-admin` = **admin**; suíte roda com ela (owner fora do caminho crítico; `[senha-owner-REDIGIDA]` saiu do `.env.local`)
- [x] **Gate de cobertura COM DENTES** — `ENFORCE_COVERAGE=smoke` passa; credita smoke+admin; parseia `@depth:`; 0 órfãs
- [x] Runner empacotado (`Dockerfile` + `deploy-monitor.sh` + README) — write-only, pronto (pende repo AR + canal de alerta + senha dedicada no Secret Manager)
- [x] Frente ERRO: 3 levas seguras (público FE Zod + API + admin), profundidade erro 3→16
- [x] ✅ **[TOP 1] Jornada WORKER real — 3 fatias VERDES contra prod (5+ runs consecutivos via `npm run test:regression`).** Fatia 1 (signup→init→is_test, para antes do espelho AnaCare) · Fatia 2 (→REGISTERED + assert AnaCare barrado) · Fatia 3 (postularse→WJA INVITED + Kanban INICIADO + fidelidade request↔DOM na página pública). **2026-07-14, resolvido:** (a) bug de determinismo — `uniqueArMobile()` E `documentNumber` usavam `Date.now()` cru e colidiam sob `fullyParallel` → 400; fix = `uniqueSuffix()` (TEST_PARALLEL_INDEX+contador+random) em `workerRegistration.ts`; (b) paralelo era flaky por lag de read-replica (falhava em passos diferentes por run) → jornada SERIALIZADA (`regression` `fullyParallel:false` + `test:regression --workers=1`); (c) `retries:1` (warm-up) no regression absorve blip transiente. Nota: hangs de `page.goto` vistos no meio da sessão eram degradação de egress ao Google (Firebase + Cloud Run frontend), NÃO defeito — some com rede normal (confirmado). Desenho em `project_e2e_worker_journey_design`.
- [x] ✅ **Jornada Talentum — pré-screening publicado nasce com ÁUDIO (ticket 86ajfm80t).** `regression/talentum-prescreening-audio.regression.ts`: cria vaga is_test → salva pré-screening SEM responseType (cenário do bug) → publica na Talentum (real) → `GET talentum-status` assere `audioEnabled=true` (fonte externa) → despublica+cleanup+404. **1 passed (30.4s)** contra prod, 0 órfãos. Cobertura 81%→87%, **happy 0→5**. Backend expõe `audioEnabled` no talentum-status (reusa o GET; padrão #134) — assert é capability-gated até o deploy. Detalhe/decisões: diario 2026-07-14 + memória `project_prescreening_audio_default_talentum`.
- [ ] Deploy do runner (Cloud Scheduler + Cloud Run Job) — precisa das 3 pendências acima + rotacionar `[senha-owner-REDIGIDA]`
- [ ] Follow-ups backend achados pela suíte: (a) `/api/vacancies/:id` não-UUID→500 (+FE página branca); (b) `DELETE /api/admin/users/:id` antes de `/by-email` (colide); (c) data-loss service-area/availability/general-info; (d) i18n: msgs BE cruas + email zod inalcançável (HTML5 barra antes). NÃO-bug: "CORS em erro" era o header x-e2e-synthetic (removido)

## Ponteiros

- Histórico passo-a-passo → `.claude/docs/diario.md`
- Decisões com porquê/custos → `.claude/docs/decisoes.md`
- Contexto amplo do produto → `../CLAUDE.md` (raiz do monorepo) + memória automática
  (`project_prod_synthetic_monitoring_suite` e correlatas)
