# Cross-link com docs/FOLLOWUPS.md

ADRs **registram a DECISÃO** (por que escolhemos X). `docs/FOLLOWUPS.md` **registra TRABALHO PENDENTE** consequente (migration, cleanup, deprecação).

Quando um ADR aceito gera trabalho subsequente, abrir uma entrada `TD-NNN` (Technical Debt) ou `DP-NNN` (Decisão Pendente) em `FOLLOWUPS.md` apontando pro ADR.

---

## Quando criar entrada em FOLLOWUPS

| Cenário | Criar TD/DP? | Tipo |
|---|---|---|
| ADR gera migration nova | Sim | TD-NNN |
| ADR força cleanup de código legado | Sim | TD-NNN |
| ADR introduz deprecação progressiva | Sim | TD-NNN |
| ADR documenta decisão pendente de validação humana | Sim | DP-NNN |
| ADR só descreve decisão tomada SEM trabalho subsequente | Não | — |
| ADR é "Rejected" | Não | — |

Em dúvida, perguntar ao caller. Não inferir.

---

## Protocolo da Fase 4

### Passo 1 — Caller passou flag de follow-up?

O caller (architect ou Claude principal) deve passar explicitamente um dos:

- `follow_up: { tipo: "TD" | "DP", titulo: "...", descricao_curta: "..." }`
- `follow_up: null` (sem follow-up necessário)

Se omisso, **perguntar ao caller** antes de prosseguir. Não inferir.

### Passo 2 — Verificar FOLLOWUPS existe

```bash
test -e /Users/gabrielstein-dev/projects/enlite/infra/docs/FOLLOWUPS.md && echo "OK" || echo "MISSING"
```

Se não existe, criar com a estrutura canônica Enlite (a mesma usada hoje em prod):

```markdown
# Follow-ups — Débitos Técnicos e Decisões Pendentes

> Registro central de itens descobertos durante implementações que **não bloqueiam o trabalho atual**, mas precisam ser tratados depois (ou dependem de decisão fora da engenharia).
>
> Convenção: cada item tem **status**, **descoberto em** (data + contexto), **dono provável** e **bloqueador? sim/não**.

---

## Débitos Técnicos

(TDs listados aqui em ordem cronológica, separados por `---`)

---

## Decisões Pendentes

(DPs listados aqui)
```

> ⚠️ Não usar seções "## Em aberto" / "## Concluídos". O FOLLOWUPS Enlite **não separa** por status — cada TD tem um campo `**Status:** aberto/concluído` individual, e a busca/filtro é por grep. Manter essa convenção evita reorganizações futuras.

### Passo 3 — Calcular próximo número TD ou DP

O formato real do FOLLOWUPS.md Enlite usa `### TD-NNN — <título>` como heading nível 3 (não bullet). Buscar com:

```bash
grep -oE '(TD|DP)-[0-9]+' /Users/gabrielstein-dev/projects/enlite/infra/docs/FOLLOWUPS.md | sort -V | tail -3
```

Próximo número = maior + 1. Sem zero-padding (TD-1, TD-2, ..., TD-40, TD-41).

### Passo 4 — Adicionar entrada (formato Enlite)

Usar `Edit` no `FOLLOWUPS.md` para anexar **após o último TD existente** (geralmente no final do arquivo) usando o template canônico Enlite:

```markdown
---

### TD-NNN — <título conciso, mesmo do ADR ou derivado>

- **Status:** aberto
- **Descoberto em:** <YYYY-MM-DD>, durante <contexto curto, ex: "refinamento de F5 do plano WJA">
- **Dono provável:** <backend (worker-functions) | frontend (enlite-frontend) | infra | design | etc>
- **Bloqueador?** Não — <razão curta, ex: "depende de F5 em produção estável">
- **Origem:** [ADR-NNN](adr/NNN-titulo.md)

**O que é:**

<2-4 parágrafos descrevendo o débito técnico, com referências cruzadas ao ADR>

**Critério para fechar:**

- <item observável 1>
- <item observável 2>
- <item observável 3>

**Ver:** [ADR-NNN](adr/NNN-titulo.md) — seção "Follow-up".
```

Para DP (Decisão Pendente), trocar o cabeçalho:

```markdown
### DP-NNN — <título>

- **Status:** aberto
- **Descoberto em:** <YYYY-MM-DD>, durante <contexto>
- **Aguardando:** <quem precisa decidir (PO, Gabriel, time específico)>
- **Bloqueador?** <Sim/Não — razão>
- **Origem:** [ADR-NNN](adr/NNN-titulo.md)

**Pergunta a responder:**

<descrição da decisão pendente>

**Opções em consideração:**

- A: ...
- B: ...

**Ver:** [ADR-NNN](adr/NNN-titulo.md).
```

> ⚠️ **Importante**: o separador `---` antes do `### TD-NNN` é parte do padrão Enlite (separa um TD do anterior). Sempre incluir.

### Passo 5 — Atualizar campo do ADR

Voltar ao ADR criado e atualizar a seção `## Implementation Notes`:

```markdown
## Implementation Notes

- Migrations envolvidas: <lista ou N/A>
- Feature flags: <lista ou N/A>
- Follow-up TD (em `docs/FOLLOWUPS.md`): TD-NNN
```

substituindo `TD-NNN` pelo número real atribuído. Usar `Edit`.

---

## Output da Fase 4

Adicionar ao output final da skill:

```
## Cross-link com FOLLOWUPS

- **Entrada criada:** TD-NNN (ou DP-NNN, ou "Sem follow-up necessário")
- **Posição:** Anexada após o último TD existente em `docs/FOLLOWUPS.md`
- **Heading literal:** `### TD-NNN — <título>`
- **Campo do ADR atualizado:** `Implementation Notes > Follow-up TD` agora aponta para TD-NNN
```

Se foi "Sem follow-up necessário", mostrar apenas:

```
## Cross-link com FOLLOWUPS

- **Entrada criada:** Nenhuma — caller indicou que ADR não gera trabalho subsequente
```

---

## Casos extremos

### ADR gera múltiplos follow-ups

Possível: ex. ADR de extração de serviço gera TD-X (migration), TD-Y (cleanup CLAUDE.md), TD-Z (deprecação endpoint). Aceitar lista de follow-ups no input do caller. Criar uma entrada por TD; campo "Follow-up TD" do ADR vira lista.

### Caller passou `follow_up: null` mas a Decision do ADR claramente menciona "criar migration X"

A skill **não infere**. Devolver ao caller:

```
## AVISO antes de persistir

A Decision do ADR menciona "criar migration X" mas você passou `follow_up: null`.
Confirma que NÃO quer criar TD em FOLLOWUPS.md? Se sim, prossiga com `confirm: true`.
```

Não escrever até receber confirmação.

### FOLLOWUPS.md tem formato customizado que não bate com este protocolo

A skill assume formato `- **TD-NNN** — ...`. Se o arquivo usa outro formato, devolver erro estruturado e pedir ao caller pra ajustar manualmente.
