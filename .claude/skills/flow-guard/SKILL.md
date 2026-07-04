---
name: flow-guard
description: "Gate de qualidade que só passa quando o FLUXO INTEIRO da feature roda end-to-end com DADO REAL (nunca mockado) e as revisões independentes convergem sem blocker. Mock só é permitido em TDD unitário — nunca na prova de fluxo. Roda E2E real (make test-integration / Firebase real / banco real, navegador→banco como no CLAUDE.md), depois revisões (code-review + agente qa) em loop até zero blocker. Use antes de dar uma feature como pronta, antes de PR, ou quando o user pedir 'garantir que funciona', 'sem bugs', 'testar o fluxo todo'."
---

# Flow Guard — não fecha até PROVAR o fluxo com dado real

Não existe "zero bug garantido". O que esta skill garante é um **gate que só passa com prova**: o fluxo real executado ponta a ponta com dado real + revisões independentes convergindo. Se não provou, não fecha.

## Princípios inegociáveis

1. **Dado real, nunca mock.** A prova de fluxo roda contra Firebase real + banco real (padrão do projeto: `make test-integration`, E2E navegador→banco). Mock **só** vale em teste unitário TDD isolado — jamais na validação de fluxo. Um fluxo "verde" em cima de mock não é prova de nada.
2. **Fluxo INTEIRO, não o caminho feliz de um passo.** Do primeiro clique/entrada até o efeito persistido no banco, incluindo os ramos que a feature toca. Validar só a tela ou só o endpoint isolado não conta.
3. **Convergência, não uma passada.** Revisões independentes rodam até **zero blocker**. Uma revisão limpa depois de um fix não basta se o fix criou outro problema — re-revisa.
4. **Evidência, não afirmação.** Cada "passou" precisa do output real colado (suite verde com contagem, query no banco mostrando o efeito, diff revisado). Sem output, não passou.

## Protocolo

### Fase 0 — Delimitar o fluxo (evidência)
Antes de rodar nada, produza o **mapa do fluxo** da feature: entrada → passos → efeito persistido. Liste os arquivos tocados (`git diff --name-only` contra a base) e os pontos de escrita no banco. Sem esse mapa, não dá pra afirmar "fluxo inteiro".

### Fase 1 — E2E real com dado real (delegar ao protocolo e2e-run)
- Rodar o E2E de integração real: `make test-integration` (ou o escopo específico via `/e2e-run <escopo>`). **Nunca** chromium mock, nunca emulador banido.
- Conta de teste: `gabriel.g.stein@gmail.com` (+testN pra contas novas), conforme memória do projeto.
- Se vermelho → invocar `e2e-repair`, corrigir, re-rodar UMA vez. Se seguir vermelho, **para e reporta** — não maquiar.
- **Prova exigida:** contagem de suites/testes verdes + uma query de leitura (via agente `dba` ou MCP `db_query_readonly`) mostrando o efeito do fluxo persistido no banco real.

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

- Qualquer mock/stub no caminho do fluxo validado (fora de unit TDD) → **FAIL**, não é prova.
- E2E "pulado" ou rodado só em unit/tsc → **FAIL** (tsc não pega import quebrado em E2E; memória do projeto).
- "Funciona na minha simulação" sem efeito verificado no banco real → **FAIL**.
- Blocker de revisão "reconhecido mas adiado" sem o user aprovar explicitamente → **FAIL**.
