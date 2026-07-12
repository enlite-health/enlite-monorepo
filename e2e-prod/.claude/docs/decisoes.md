# Log de decisões (append-only)

Formato de cada entrada:
## AAAA-MM-DD — Título curto
**Decisão:** o que ficou combinado.
**Por quê:** a razão (incluindo custos/trade-offs discutidos).
**Status:** aberto | firmado | revisado (aponta pra entrada nova).

Quando algo mudar de rumo: NOVA entrada (não apagar histórico) + atualizar o Status do CLAUDE.md.

---

## 2026-07-11 — Suíte de prod é synthetic monitoring, não E2E de CI
**Decisão:** o que estamos construindo é um monitor sintético (Playwright agendado contra prod +
alerta na falha), conceito distinto do E2E de CI que já existe (local/mock).
**Por quê:** pesquisa confirmou que a indústria trata "E2E agendado em prod que paga humano na
falha" como synthetic monitoring, com padrões próprios (monitoring-as-code, retry antes de alertar).
Nomear certo destrava as práticas certas.
**Status:** firmado.

## 2026-07-11 — Código no monorepo, em `e2e-prod/` na RAIZ (não em enlite-frontend)
**Decisão:** projeto irmão de enlite-frontend/worker-functions, na raiz, com package.json próprio.
**Por quê:** (a) best practice "monitoring-as-code" = monitor junto do app, revisado em PR (evita
drift de seletor/i18n que repo separado sofre); (b) a suíte é cross-cutting (UI admin + páginas
públicas + API worker-functions direto pra erros determinísticos), então não é "coisa do frontend";
(c) a IaC do runner já vive na raiz (terraform/, .github/); (d) monitor caixa-preta NÃO deve acoplar
nos helpers internos do front — decouplar é feature. O user desafiou meu "enlite-frontend" inicial e
tinha razão.
**Custo:** alguma duplicação de seletores vs reuso do staging journey — aceitável e saudável p/ caixa-preta.
**Status:** firmado (revisou decisão inicial equivocada de por dentro do frontend).

## 2026-07-11 — Runner: Cloud Scheduler → Cloud Run Job (não GitHub Actions cron)
**Decisão:** gatilho "todo dia 3h" via Cloud Scheduler disparando Cloud Run Job; secrets no Secret
Manager; alerta via Cloud Monitoring/Slack. IaC em `terraform/synthetic-monitoring/`.
**Por quê:** pesquisa mostrou que GH Actions cron é anti-pattern p/ monitoramento — desliga sozinho
após 60 dias sem commit (silencioso!) e não tem SLA de horário (atrasos 5–30min). Um monitor de app
estável (poucos commits) MORRERIA calado justo quando mais se confia nele. GCP-native já é a casa deles.
**Custo:** Cloud Run Job + Scheduler ~ centavos/dia; setup Terraform inicial. Migração futura não
muda o código dos testes, só o gatilho.
**Status:** firmado (user escolheu explicitamente self-host GCP sobre Checkly).

## 2026-07-11 — Prod real + conta real + teardown obrigatório
**Decisão:** rodar contra prod com dados reais, mas remover TUDO que criar. Marca inequívoca
(`gabriel+e2e-<data>@`, `[E2E]`) + sweeper idempotente pré-suíte + afterEach/afterAll.
**Por quê:** user quer fidelidade máxima (prova que PROD está no ar), sem deixar lixo na base. O
sweeper por marca é a rede de segurança pra teste que morre no meio (teardown normal não roda).
**Custo/risco:** efeitos externos irreversíveis (WhatsApp/ClickUp/Periskope) nos caminhos felizes —
esses ficam fora do diário ou usam conta-sentinela. A MAIORIA dos caminhos de erro é validação
(rejeita antes de gravar) = seguro sem teardown.
**Status:** firmado.

## 2026-07-11 — Zero mock na suíte de prod; erro de negócio real, erro de infra monitorado
**Decisão:** `page.route()` banido aqui. Erros de negócio (400/403/404/WORKER_NOT_ELIGIBLE) testados
REAIS. Erros de infra (500/timeout) não são testados — são monitorados (assere que prod NÃO os retorna).
**Por quê:** "usuário real" e "mockar erro" se contradizem. Prod genuinamente rejeita input inválido
sem efeito colateral, então dá pra testar erro de negócio real. 500/timeout não dá pra forçar em prod
com segurança — vira sinal de alerta, não caso de teste. Coerente com memória guarantee_means_full_real_e2e.
**Status:** firmado.

## 2026-07-11 — Garantia de cobertura = gate de CI (manifesto × specs)
**Decisão:** meta-teste que cruza o manifesto de rotas user-facing (denominador) × specs (numerador);
rota user-facing sem spec = build vermelho. Exclusões (máquina-a-máquina, morto) numa allowlist justificada.
**Por quê:** "garantir todos os fluxos" não pode ser sentimento. O gate quebra quando um fluxo novo entra
sem teste (rota nova em App.tsx → CI vermelho até ter spec). É assim que a cobertura não apodrece.
**Status:** firmado.

## 2026-07-11 — Setup/teardown via API, fluxo sob teste via UI
**Decisão:** preparar estado por API (rápido), dirigir a UI como usuário real no fluxo que importa,
limpar por API.
**Por quê:** best practice (10 ações de UI viram 1 request; não quebra quando tela de setup muda) +
resolve o teardown de forma limpa, mantendo "usuário real" onde importa.
**Status:** firmado.

## 2026-07-11 — Jornada de criação de vaga em prod: guarda de backend + verificação de teardown
**Contexto (investigações):** criar vaga SEMPRE emite `vacancy.created`; o `VacancyAutoInviteHandler`+
`MatchmakingService` NÃO checam is_draft/status → rodam matchmaking e enviam **WhatsApp REAL a ATs reais** (irreversível),
mesmo em draft. Talentum: publish cria 1 recurso (pre-screening project, POST /pre-screening/projects); unpublish deleta
EXATAMENTE esse (DELETE mesmo id) — simetria confirmada, sem resíduo, existe GET pra verificar. Short.io não cria link em
status default; soft-delete tira do feed. Único efeito irreversível = WhatsApp.
**Decisões (user aprovou):**
- **Guarda de backend (opção A):** `job_postings.is_test` + `VacancyAutoInviteHandler` faz early-return se is_test →
  0 matchmaking/WJA/WhatsApp. É o 1º pedaço do is_test cirúrgico, mínimo. NÃO filtrar feed (vaga nasce draft+PENDING_ACTIVATION,
  já não aparece).
- **Verificação de teardown Talentum (opção A):** novo endpoint `GET /api/admin/vacancies/:id/talentum-status` — o BACKEND
  bate no Talentum (creds no Secret Manager dele) e responde {exists}. Teste chama isso com sessão admin; creds Talentum não
  saem do backend. O teste prova: publish→exists true; unpublish→exists false (GET→404). Round-trip real, não confiança.
- **Sequência:** implementar guarda+endpoint → TESTAR local → USER faz deploy (merge→main) → SÓ ENTÃO jornada E2E em prod.
  Claude NÃO deploya backend sozinho.
- **Patient:** reusar existente (zona não importa, guard mata matchmaking). Sem criar/limpar paciente.
**Status:** firmado; Parte 1 (backend) em implementação.

### Fontes da pesquisa de best practices (2026-07-11)
- Playwright oficial: https://playwright.dev/docs/best-practices , https://playwright.dev/docs/locators ,
  https://playwright.dev/docs/test-reporters
- Synthetic monitoring / monitoring-as-code: Checkly docs, USENIX "SM & E2E two sides of the same coin"
- GH Actions cron anti-pattern p/ monitoramento: zenn (60-day disable), cronuru (sem SLA)
- Estrutura em escala (POM por intenção + fixtures, sharding): TestDino, Kailash Pathak (Medium)
- Setup via API / negative testing: TestDino, cryan.com

## 2026-07-11 — Triangulação (best practices × grandes players × fóruns) + análise de fit
**Decisão:** confirmar e refinar o split de 2 camadas à luz da pesquisa triangulada.
- **Smoke (diário 3h) = READ-ONLY, curto, estável, só os fluxos MAIS críticos.** É o "monitor" no
  sentido estrito. Bate com Fowler ("subset"), praticantes MoT ("read-only, não-destrutivo, flows
  curtos/rápidos") e Microsoft ("caminho mais crítico, não cobertura total, complexidade mínima").
  → NADA de writes no diário. Se um teste de write entrar no smoke, está em violação.
- **Regressão (semanal/sob-demanda) = writes + cobertura total + teardown.** NÃO é "monitor"
  estrito; é E2E agendado contra prod. Carrega o risco de write, por isso roda raro + sweeper.
**Por quê:** o pedido do user ("todos os fluxos, writes, diário") conflita com o consenso da
indústria ("poucos fluxos read-only no alta-frequência"). O split resolve os dois: cobertura total
existe (na regressão), e o monitor diário fica enxuto e confiável (praticante: "distinguir falha
sintética de problema real de backend" exige flow curto e estável).
**Status:** firmado.

## 2026-07-11 — RISCO NOVO: poluição de analítica por tráfego sintético (Fowler)
**Decisão (provisória, pendente de verificação):** todo write da suíte deve ser marcado como teste
E excluído das métricas de operação. Investigar se a analítica do Enlite já exclui registros
test-flagged (existe `PATCH /api/admin/workers/:id/test-flag` + `AdminWorkerTestFlagController`).
**Por quê:** Fowler alerta que tráfego sintético polui analítica/notificações; praticantes evitam
writes justamente por "risco downstream". Nossos dashboards de funil/contagem (que a operação usa)
seriam corrompidos por workers/postulações de teste. Se a analítica NÃO excluir test-flag, ou (a)
regressão fica read-only também, ou (b) precisamos de flag de exclusão antes de qualquer write.
**Custo/risco:** alto se ignorado — corromper métrica de operação é pior que não ter o teste.
**Status:** ABERTO — recon disparada (agente) pra confirmar comportamento da analítica vs test-flag.

## 2026-07-11 — Marca/teardown à luz da pesquisa (Fowler: conta dedicada com prefixo)
**Decisão:** conta dedicada por run com prefixo identificável (`gabriel+e2e-<data>@`) — habilita
execução paralela (Fowler) e é a chave do sweeper. Alternativa "conta reusada limpa no início"
rejeitada (força serial). Para API, marcar via header de teste (Fowler) se o backend suportar.
**Por quê:** conta dedicada com prefixo é o padrão canônico do Fowler pra idempotência + paralelo.
**Status:** firmado (refina a decisão anterior de marca).

## 2026-07-11 — VEREDITO do risco de poluição (recon concluída): writes em prod BLOQUEADOS
**Fato (evidência):** `workers.is_test` (mig 224) é cosmético — 5 usos no código, NENHUM é filtro de
query. `AnalyticsRepository` conta workers/applications/encuadres só com `merged_into_id IS NULL` +
`deleted_at IS NULL`, SEM filtro de `is_test`. Analítica, funil e Kanban NÃO excluem teste. Não há
header de modo-teste. Feed público lista job postings (não workers) — worker de teste não vaza lá, mas
VAGA de teste vazaria (sem flag de teste pra job posting).
**Decisão:**
- **Smoke read-only em prod = GO.** Só GET/render, zero write, zero poluição. Construir agora.
- **Writes em prod = BLOQUEADO** até o user decidir. Criar worker/postulação de teste polui métrica de
  operação e pode disparar AnaCare/WhatsApp via outbox (irreversível; teardown não desfaz domain_events).
**Por quê (alinhado às regras do user):** segurança primeiro, honestidade sobre risco, não fazer ação
outward-facing irreversível sem consentimento, perguntar antes de mudança destrutiva. Construir a metade
segura (maior valor) e escalar a metade arriscada com recomendação pronta NÃO é idle — é a decisão certa.
**Opções a apresentar ao user (regressão-com-writes):**
- (A) tornar `is_test` filtrável no backend (fix correto; mexe na analítica de operação — call do user).
- (B) rodar regressão-com-writes contra STAGING (contraria "tudo em prod", mas é o trade-off real).
- (C) híbrido (ex.: writes só em fluxos que comprovadamente não alimentam analítica — hoje ~nenhum).
**Status:** ABERTO (a única decisão que espera o user). Fecha a entrada anterior "RISCO NOVO".

## 2026-07-11 — Fatos de ambiente prod confirmados (recon)
**Decisão:** materializados em `.env.example`. Front `enlite-frontend-byh3gvl5yq-tl.a.run.app`,
API `worker-functions-byh3gvl5yq-tl.a.run.app`, Firebase `enlite-prd` (apiKey web pública, não-segredo).
Auth: Identity Toolkit REST (signUp/delete p/ worker) + owner gabriel.g.stein@gmail.com admin via custom
claim `role`. Ressalva da recon: claim admin confirmada em staging/modelo, NÃO verificada por query em
enlite-prd — validar antes de confiar em smoke admin autenticado.
**Status:** firmado.

### Fontes desta rodada (triangulação)
- Canônico: https://martinfowler.com/bliki/SyntheticMonitoring.html
- Praticantes: https://club.ministryoftesting.com/t/has-anyone-used-synthetic-monitoring-for-production-smoke-tests/84923
- Grandes players: microsoft.github.io/code-with-engineering-playbook (smoke + synthetic-monitoring),
  shopify.dev/docs (e2e Playwright + auth bypass token)
- New Relic / Checkly / Datadog synthetic docs; USENIX "two sides of the same coin"
