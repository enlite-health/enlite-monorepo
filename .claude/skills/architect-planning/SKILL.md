---
name: architect-planning
description: Estrutura padrão do agente architect Enlite — 3 modos de parecer (Y-statement / Technical Analysis / ADR Nygard), heurísticas de reuso-vs-criação e gating duro pra extração de feature em repo NestJS próprio. Invocar antes de devolver parecer.
model: sonnet
---

# Architect Planning — Skill do arquiteto Enlite

Esta skill padroniza:
1. **Modo de saída** do parecer (escolher 1 dos 3 modos conforme escopo)
2. **Heurísticas** de reuso vs criação (Rule of Three, wrong abstraction, bounded context)
3. **Gating duro** pra extração em repo Nest próprio (4 critérios; default = manter no monolito modular)

---

## Passo 1 — Escolher o modo

Antes de gerar qualquer saída, classificar a decisão em **1 dos 3 modos** abaixo. Em dúvida, escalar pro modo maior (Technical Analysis > Y-statement).

| Modo | Escopo | Tamanho | Persistência | Reference |
|---|---|---|---|---|
| **Mode 1 — Y-statement** | Decisão granular única (1 nome, 1 coluna, 1 entidade pequena) | 1 frase + 3-5 linhas de evidência | Inline na resposta | `references/mode1-y-statement.md` |
| **Mode 2 — Technical Analysis** | Parecer de feature inteira pro PO antes do plano | 60-120 linhas | Inline na resposta | `references/mode2-technical-analysis.md` |
| **Mode 3 — ADR Nygard** | Decisão persistente (extrair serviço, mudar schema base, nova fronteira) | 50-80 linhas | **Gera arquivo** em `docs/adr/NNN-titulo.md` | `references/mode3-adr-nygard.md` |

### Gatilhos pra disparar Mode 3 (ADR persistente)

Qualquer um dos abaixo força Mode 3:

- Mudança de fronteira de serviço (extrair pra repo novo, fundir serviços)
- Mudança de schema base (renomear tabela, mudar PK, mudar tipo de coluna chave)
- Adoção/troca de biblioteca core (ORM, framework, transport)
- Política de segurança/PII (mover dado pra Healthcare API, mudar RBAC global)
- Decisão que vai durar > 6 meses e afeta múltiplos times

Se nenhum gatilho, usar Mode 1 ou Mode 2 conforme escopo.

---

## Passo 2 — Aplicar heurísticas de reuso vs criação

Leia [`references/reuso-vs-criacao.md`](references/reuso-vs-criacao.md) e aplique antes de recomendar criar algo novo.

Regra dura: **reusar é o default**. Toda criação nova exige evidência de pelo menos 1 critério de criação (ver reference).

---

## Passo 3 — Se a decisão envolve extração pra repo Nest novo

Aplicar o **veto duro de 4 critérios** em [`references/extracao-repo-novo.md`](references/extracao-repo-novo.md).

Se passar em ≥1 dos 4 critérios: recomendar extração com Mode 3 (ADR).
Se NÃO passar em nenhum: **VETAR** extração e propor modular monolith dentro de worker-functions.

---

## Limitação técnica — não spawnar subagentes

> ⚠️ Subagentes Claude Code **não podem invocar outros subagentes** ([docs oficiais](https://code.claude.com/docs/en/agent-sdk/subagents)). O architect:
>
> - **NÃO** invoca `adr-writer` via `Agent` tool
> - **NÃO** invoca `dba`, `qa` ou qualquer outro agente
>
> Em Mode 3, o architect formula o ADR inline e sinaliza ao Claude principal via bloco `## Próximo Passo`. O Claude principal orquestra a invocação do adr-writer com o conteúdo formatado. Ver `references/mode3-adr-nygard.md` seção "Procedimento — Architect formula, Claude principal orquestra persistência".

---

## Restrições de uso de WebSearch / WebFetch

O architect tem acesso a `WebSearch` e `WebFetch`. Restrições obrigatórias:

1. **Esgotar RAG + código primeiro**: só consultar web depois de já ter buscado em `mcp__local-rag__query_documents` e em `grep` no código.
2. **Só fontes técnicas reconhecidas**: martinfowler.com, docs oficiais (nestjs.com, expressjs.com, node.js docs), Anthropic engineering, Sandi Metz, papers acadêmicos. Não usar Medium/Dev.to/Reddit como fonte primária.
3. **Citar URL completo + 1 linha de takeaway** em toda referência externa. Sem citação, não vale.
4. **Não copiar prosa**: parafrasear e atribuir. Citações literais só entre aspas.

---

## Anti-padrões que invalidam o parecer

Se o parecer cometer qualquer um destes, é considerado **inválido** e deve ser refeito:

- Afirma "já existe X no código" sem citar `file:line` (must-have: arquivo + linha)
- Recomenda criar entidade/tabela/use case sem provar que reuso falhou (grep negativo explícito)
- Enumera 3+ alternativas sem escolher uma (architect decide; "depende" não vale)
- Usa "robusto", "limpo", "escalável", "elegante" como justificativa
- Sugere extrair pra repo Nest novo sem passar pelo gating de 4 critérios
- Output sem schema fixo (prosa solta)

---

## Output esperado da skill

A skill **não produz output direto** — é instrucional. O output final é responsabilidade do agente `architect`, seguindo literalmente o template do modo escolhido.

Considerar a skill **executada com sucesso** quando o agente cita explicitamente, no início da resposta:

```
> Skill `architect-planning` aplicada — Mode <1|2|3>. Referência: `architect-planning/references/<arquivo>.md`.
```
