---
name: adr-writing
description: Procedimento canônico de persistência de ADRs em docs/adr/. Cobre numeração sequencial via filesystem, template Nygard literal, lifecycle de status e cross-link com FOLLOWUPS.md. Invocada pelo agente adr-writer (que é invocado APENAS pelo Claude principal — subagentes não podem spawnar outros subagentes).
model: sonnet
---

# ADR Writing — Skill de persistência de ADRs

Esta skill **não decide conteúdo**. Decisão arquitetural é responsabilidade do agente `architect` (skill `architect-planning` Mode 3). Esta skill cuida apenas de:

1. **Numerar** o ADR sequencialmente lendo `docs/adr/` no filesystem
2. **Escrever** o arquivo seguindo template Nygard literal
3. **Lifecycle de status** (Proposed → Accepted/Rejected/Deprecated/Superseded)
4. **Cross-link** com `docs/FOLLOWUPS.md` (abrir TD-NNN quando ADR gera trabalho subsequente)

---

## Quando invocar

Use esta skill quando você (agente adr-writer ou Claude principal) recebeu **conteúdo de ADR já formulado** e precisa persistir:

- Architect produziu Mode 3 e delegou persistência
- PO está documentando uma decisão técnica já discutida
- Claude principal está formalizando decisão tomada no chat

Não use esta skill para **decidir** se vale criar ADR ou para **escrever conteúdo**. Quem decide é o architect via [`architect-planning`](../architect-planning/SKILL.md) Mode 3.

---

## Procedimento (4 fases obrigatórias)

### Fase 1 — Numeração

Ler [`references/numeracao-sequencial.md`](references/numeracao-sequencial.md) e seguir literalmente.

Resumo: `ls docs/adr/` (ou criar diretório), pegar maior número existente, incrementar. Zero-padding 3 dígitos.

### Fase 2 — Template

Ler [`references/nygard-template.md`](references/nygard-template.md) e preencher TODAS as seções com o conteúdo recebido. Seções obrigatórias: Status, Context, Decision, Consequences, Alternatives Considered, Rollback.

Se o conteúdo recebido não cobrir uma seção obrigatória, **devolver erro estruturado ao caller** (não preencher com placeholder).

### Fase 3 — Persistir arquivo

Escrever o arquivo em `docs/adr/NNN-titulo-kebab.md` usando `Write`. Path absoluto baseado no `cwd` atual.

### Fase 4 — Cross-link com FOLLOWUPS.md

Ler [`references/cross-link-followups.md`](references/cross-link-followups.md) e seguir literalmente.

Se o ADR gera trabalho subsequente (migration, cleanup, deprecação), abrir TD-NNN em `docs/FOLLOWUPS.md` apontando para o ADR. Se não há follow-up necessário, registrar "sem follow-up necessário" no output final.

---

## Lifecycle de status

Ler [`references/status-lifecycle.md`](references/status-lifecycle.md) para transições válidas.

Resumo: ADR sempre nasce **Proposed**. Aprovação humana (PO ou Gabriel) move pra **Accepted**. Substituições e deprecações documentam-se entre ADRs.

---

## Output contratado

A skill **não escreve no chat** — quem fala é o agente caller. Mas o caller (adr-writer ou Claude principal) DEVE devolver ao usuário um bloco final neste formato:

```
## ADR persistido

- **Arquivo:** `docs/adr/NNN-titulo-kebab.md`
- **Número:** ADR-NNN
- **Status:** Proposed
- **Cross-link FOLLOWUPS:** TD-NNN (criado) OU "Sem follow-up necessário"
- **Próximo passo:** Aprovação humana (PO ou Gabriel) para mover Status para Accepted
```

Se a Fase 4 abriu TD-NNN, citar literalmente a linha adicionada em FOLLOWUPS.md.

---

## Restrições

- **Não modificar conteúdo** do ADR recebido. Só persistir literalmente. Se a estrutura não bate, devolver erro.
- **Não recalcular numeração** depois de escrita. Se 2 ADRs forem escritos em paralelo, o segundo deve ler novamente o FS antes de numerar.
- **Não deletar ADRs** existentes. Status `Deprecated` ou `Superseded by` é a forma correta de invalidar.
- **Não inferir** se um TD em FOLLOWUPS é necessário — o caller deve passar isso explicitamente; se omisso, perguntar.

---

## Anti-padrões que invalidam a persistência

- Escrever ADR sem todas as seções obrigatórias preenchidas → recusar
- Pular Fase 1 (numeração via FS) e usar número arbitrário → recusar
- Sobrescrever ADR existente → recusar (criar novo ADR substituto com `Superseded by`)
- Escrever em path fora de `docs/adr/` → recusar
- Status diferente de `Proposed` na criação → recusar (lifecycle só avança via revisão humana)
