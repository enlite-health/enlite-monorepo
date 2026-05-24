---
name: po-planning
description: Estrutura padrão do PO técnico Enlite — template de Plano de Execução, checklist de decomposição em tasks e gates de revisão final pós-QA. Invocar antes de devolver análise/refinamento de requisito ou de aprovar implementação.
model: sonnet
---

# PO Planning — Estrutura padrão do PO técnico Enlite

Esta skill padroniza três artefatos que o agente `po` produz:

1. **Plano de Execução** — template fixo de saída pós-refinamento
2. **Decomposição em tasks** — checklist objetivo para quebrar feature em tasks acionáveis
3. **Gates de revisão final** — critérios verificáveis para aprovar/reprovar implementação pós-QA

Use a fase relevante conforme o momento do ciclo.

---

## Quando invocar cada fase

| Momento | Fase | Reference |
|---|---|---|
| Acabou análise + RAG + parecer do architect; vai devolver plano | **Plano** | `references/plano-template.md` |
| Está decompondo feature em tasks (parte do Plano) | **Decomposição** | `references/decomposicao-checklist.md` |
| QA aprovou; PO faz revisão final antes de marcar DONE | **Gates** | `references/gates-revisao-final.md` |

Ler o reference correspondente com `Read` e seguir literalmente.

---

## Fase 1 — Plano de Execução

> ⚠️ **Limitação técnica**: PO **não pode spawnar subagentes** (limitação Claude Code — ver `agents/po.md`). O PO produz plano preliminar e sinaliza ao Claude principal que próximo passo é Architect.

Antes de produzir o plano, confirme que você (PO) já cumpriu:

- [ ] Bloco **"Contexto do RAG"** preenchido (consultas + lacunas)
- [ ] Leu CLAUDE.md raiz + projeto-alvo
- [ ] Pattern analysis básica do código (≥ 3 `arquivo:linha`)
- [ ] Identificou se a feature exige parecer arquitetural — se sim, marcar tasks afetadas como **AGUARDANDO ARCHITECT**

Se a feature exige architect, o plano é **preliminar** (incompleto) — após o Claude principal invocar o architect e devolver parecer, o PO é re-invocado para gerar o plano final incorporando o parecer.

Estrutura obrigatória de saída: ver [`references/plano-template.md`](references/plano-template.md).

### Sinalização de handoff (bloco final obrigatório)

Todo output do PO deve terminar com bloco `## Próximo Passo` em um dos 3 formatos:

```
## Próximo Passo

**Architect necessário.** Pergunta arquitetural a responder:
<descrição objetiva da decisão aberta>

Contexto a passar pro architect:
- Feature: <nome>
- Tasks aguardando: <lista>
- Arquivos-chave identificados: <paths>
```

OU

```
## Próximo Passo

**Pronto para implementação.** Sem decisões arquiteturais abertas.
Devs sugeridos: backend-dev (tasks 1, 3), frontend-dev (task 2)
```

OU

```
## Próximo Passo

**Aguardando humano.** Decisão pendente:
<descrição da pergunta a ser respondida por PO/Gabriel>
```

---

## Fase 2 — Decomposição em tasks

Cada task do plano DEVE passar pelos checks em [`references/decomposicao-checklist.md`](references/decomposicao-checklist.md).

Regra dura: se a task falha em **qualquer** check, ela é decomposta ou redesenhada — nunca incluída "com ressalva".

---

## Fase 3 — Gates de revisão final (pós-QA)

Após o QA aprovar, o PO percorre TODOS os gates em [`references/gates-revisao-final.md`](references/gates-revisao-final.md) antes de marcar a feature como **DONE**.

Output binário: **APROVADO** ou **REPROVADO** (com lista de pendências citando gate violado).

Não existe "aprovado com ressalva". Se algum gate falha, é REPROVADO e volta ao dev responsável.

---

## Output esperado da skill

A skill **não produz output direto** — ela é instrucional. O output final é responsabilidade do agente `po` (Plano de Execução ou Revisão Final), seguindo os templates dos references.

A skill é considerada **executada com sucesso** quando o agente `po` cita explicitamente, na sua resposta final, qual fase desta skill foi aplicada (ex: _"Plano gerado conforme `po-planning/references/plano-template.md`"_).
