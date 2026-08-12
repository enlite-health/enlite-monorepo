---
name: flow-guard
description: "Gate de qualidade que só passa quando o FLUXO INTEIRO da feature roda end-to-end com AUTH FIREBASE REAL + banco real (nunca mockado) e as revisões independentes convergem sem blocker. Mock só é permitido em TDD unitário — nunca na prova de fluxo, e AUTH MOCK NÃO CONTA (make test-integration usa USE_MOCK_AUTH=true, é iteração rápida, não é garantia). A prova roda no projeto Playwright chromium (auth.setup faz signIn real no enlite-prd), backend em prod-auth, depois revisões (code-review + agente qa) em loop até zero blocker. Use antes de dar uma feature como pronta, antes de PR, ou quando o user pedir 'garantir que funciona', 'sem bugs', 'testar o fluxo todo'."
---

# Flow Guard — não fecha até PROVAR o fluxo com dado real

Não existe "zero bug garantido". O que esta skill garante é um **gate que só passa com prova**: o fluxo real executado ponta a ponta com dado real + revisões independentes convergindo. Se não provou, não fecha.

## Princípios inegociáveis

1. **Auth Firebase REAL + banco real, nunca mock.** A prova roda no projeto Playwright **`chromium`** — o `auth.setup` faz **signIn de verdade no Firebase de produção (enlite-prd)** com `gabriel.g.stein@gmail.com` e salva `storageState`. O backend fica em **prod-auth** (o padrão; NÃO `make test-integration`, que é `USE_MOCK_AUTH=true`). Mock **só** vale em teste unitário TDD isolado — jamais na validação de fluxo. Um fluxo "verde" com auth mockado **não é prova de nada** e reprova o gate (ver exclusões).
2. **Fluxo INTEIRO, não o caminho feliz de um passo.** Do primeiro clique/entrada até o efeito persistido no banco, incluindo os ramos que a feature toca. Validar só a tela ou só o endpoint isolado não conta.
3. **Convergência, não uma passada.** Revisões independentes rodam até **zero blocker**. Uma revisão limpa depois de um fix não basta se o fix criou outro problema — re-revisa.
4. **Evidência, não afirmação.** Cada "passou" precisa do output real colado (suite verde com contagem, query no banco mostrando o efeito, diff revisado). Sem output, não passou.

## Protocolo

### Fase 0 — Delimitar o fluxo (evidência)
Antes de rodar nada, produza o **mapa do fluxo** da feature: entrada → passos → efeito persistido. Liste os arquivos tocados (`git diff --name-only` contra a base) e os pontos de escrita no banco. Sem esse mapa, não dá pra afirmar "fluxo inteiro".

### Fase 0.5 — Pré-condição de ambiente (checar ANTES da Fase 1)
O E2E aborta no `global-setup` se o ambiente não estiver de pé. Confirmar, nesta ordem:
```bash
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'enlite-postgres|enlite-api'   # postgres + api healthy
curl -sf http://localhost:8080/health   # API em PROD-AUTH (não mock). Se veio de make test-integration, restaurar: docker compose up -d --no-deps api
curl -sf http://localhost:5173          # frontend dev server. Se 000: cd enlite-frontend && pnpm dev (background)
```
Se algo faltar, subir **sem recriar** o `enlite-api` já healthy (memória: recriar container quebra por imagem stale). Só então Fase 1.

### Fase 1 — E2E real com AUTH FIREBASE REAL (projeto chromium)
- Rodar o fluxo no projeto **chromium** (real auth), NÃO na integração mock:
  ```bash
  cd enlite-frontend && pnpm test:e2e --project=chromium --grep "<feature>"
  ```
  O projeto `chromium` depende de `setup` → `auth.setup` faz signIn real no **Firebase enlite-prd** (`gabriel.g.stein@gmail.com` / `Teste@123`, override via `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD`) e salva `storageState` (IndexedDB). Backend em **prod-auth** valida o token real.
- **`make test-integration` / projeto `integration` NÃO satisfaz este gate** — é `USE_MOCK_AUTH=true`, serve pra iteração rápida de dev, não pra garantia. Se a feature só tem suite de integração (mock-auth), o gate exige **criar/rodar uma versão chromium real-auth** do fluxo (via `/e2e-create`).
- Se vermelho → invocar `e2e-repair`, corrigir, re-rodar UMA vez. Se seguir vermelho, **para e reporta** — não maquiar. Drift de baseline visual NÃO se auto-atualiza: é decisão humana (regressão real vs ruído).
- **Prova exigida:** contagem de testes verdes (output colado) + uma query read-only (agente `dba` ou MCP `db_query_readonly`) mostrando o efeito do fluxo persistido no banco real. PII é encrypted — provar via campos não-PII + presença dos `*_encrypted`.

### Fase 2 — Revisões independentes em loop (delegar a subagentes)
Rodar em paralelo, cada um num subagente, cada um atacando por um ângulo:
- **`code-review`** (ou `/code-review high`) — correção, bugs, edge cases no diff.
- **agente `qa`** — critérios de aceite + fronteiras + fluxo.
- (opcional, se o user pedir "auditar tudo") **agente `type-guardian`** — tipagem estrita.

Consolidar os blockers. **Se houver ≥1 blocker:** aplicar fix → voltar pra Fase 1 (o fix pode ter quebrado o fluxo) → re-revisar. Repetir até **zero blocker** ou teto de 4 rodadas.

### Fase 3 — Veredicto
Só existe **PASS** se: E2E real verde + efeito no banco comprovado + zero blocker nas revisões. Qualquer outra coisa é **FAIL** com o gap explícito.

## Output estruturado (fixo)

```markdown
## Flow Guard: [feature]
**Fluxo:** [entrada] → … → [efeito persistido]
**Arquivos tocados:** [N] (git diff)

### Fase 1 — E2E real
- Comando: `make test-integration [escopo]`
- Resultado: [X suites / Y testes verdes]  ← output colado
- Efeito no banco: [query + linhas retornadas provando persistência]
- Mock usado no fluxo? NÃO (só TDD unitário: [onde, se houver])

### Fase 2 — Revisões (rodadas: k)
| Revisor | Rodada final | Blockers |
|---|---|---|
| code-review | k | 0 |
| qa | k | 0 |

### Veredicto
✅ PASS — fluxo provado com dado real, zero blocker.
❌ FAIL — [gap exato: E2E vermelho em X / blocker Y não resolvido / efeito não persistiu]. NÃO está pronto.
```

## Critérios de exclusão duros (reprova automática)

- **Auth mockado (`USE_MOCK_AUTH=true` / projeto `integration` / `make test-integration`) → FAIL.** Não é prova de fluxo real. A garantia é chromium + Firebase real.
- Qualquer outro mock/stub no caminho do fluxo validado (fora de unit TDD) → **FAIL**, não é prova.
- E2E "pulado" ou rodado só em unit/tsc → **FAIL** (tsc não pega import quebrado em E2E; memória do projeto).
- "Funciona na minha simulação" sem efeito verificado no banco real → **FAIL**.
- Blocker de revisão "reconhecido mas adiado" sem o user aprovar explicitamente → **FAIL**.
