# Mode 3 — ADR Nygard (persistente)

Formato Michael Nygard (cognitect.com, 2011). Decisão **persistida em arquivo** via delegação ao agente `adr-writer`.

**Quando usar (apenas se ≥ 1 gatilho):**

- Mudança de fronteira de serviço (extrair pra repo Nest novo, fundir serviços, dividir serviço)
- Mudança de schema base (renomear tabela, mudar PK, mudar tipo de coluna chave, deprecar entidade)
- Adoção/troca de biblioteca core (ORM, framework, transport entre serviços)
- Política de PII / RBAC / compliance global
- Decisão que vai durar > 6 meses e afeta múltiplos times

Se nenhum gatilho, usar Mode 1 ou 2.

---

## Procedimento — Architect formula, Claude principal orquestra persistência

> ⚠️ **Limitação técnica importante**: Subagentes Claude Code **não podem spawnar outros subagentes** ([docs oficiais](https://code.claude.com/docs/en/agent-sdk/subagents)). Portanto o `architect` NÃO invoca `adr-writer` diretamente. O architect formula o conteúdo e sinaliza handoff ao Claude principal, que orquestra a invocação do adr-writer.

O agente `architect` em Mode 3:

1. **Formula** o conteúdo do ADR seguindo a estrutura abaixo
2. **Reproduz inline** na resposta do chat — bloco completo com todas as seções obrigatórias
3. **Sinaliza handoff** via bloco final `## Próximo Passo` em formato fixo (ver abaixo)

O Claude principal lê o output do architect, identifica o handoff, e invoca o `adr-writer` (via `Agent` tool) passando o conteúdo formatado.

### Saída obrigatória do architect ao caller após Mode 3

```
> Skill `architect-planning` aplicada — Mode 3 (ADR a persistir).

## Conteúdo do ADR (para persistência)

Título: <título-kebab-case>
Contexto técnico: <repo/módulo>
Decisor(es): architect + PO (aguardando aprovação humana)

### Context
<conteúdo completo>

### Decision
<imperativo + bullets de mudança>

### Consequences
**Positivas:**
- ...
**Negativas:**
- ...
**Neutras:**
- ...

### Alternatives Considered

**Alternativa A: <nome>**
<descrição>
Descartada porque: <razão>

**Alternativa B: <nome>**
<descrição>
Descartada porque: <razão>

### Rollback
<plano concreto>

### Follow-up
- Tipo: TD | DP | null
- Título (se TD/DP): <curto>
- Descrição (se TD/DP): <1-2 linhas>

---

## Próximo Passo

> Para o Claude principal:
>
> Invocar `Agent(subagent_type="adr-writer", ...)` passando o conteúdo do ADR acima como prompt. O adr-writer vai:
> 1. Numerar via FS (`docs/adr/`)
> 2. Validar template Nygard
> 3. Escrever em `docs/adr/NNN-titulo.md`
> 4. Cross-linkar em `docs/FOLLOWUPS.md` se follow-up tipo TD ou DP
> 5. Devolver: path do arquivo + número + status
>
> Status esperado: Proposed (aprovação humana posterior moverá para Accepted).
```

O Claude principal deve copiar literalmente o bloco "Conteúdo do ADR" no prompt do adr-writer. Se o adr-writer recusar persistência (estrutura incompleta), o Claude principal volta ao architect pedindo complemento.

---

## Estrutura literal do arquivo `.md`

```markdown
# ADR <NNN>: <Título>

- **Status:** Proposed
- **Data:** <YYYY-MM-DD>
- **Decisor(es):** <agente architect + PO + Gabriel se humano confirmou>
- **Contexto técnico:** <repo/módulo onde a decisão se aplica>

## Context

<3-8 linhas descrevendo a situação técnica que força a decisão. Cita arquivos, regras de negócio, restrições. Sem prosa. Cada parágrafo tem propósito.>

## Decision

<Decisão imperativa em 1-3 frases. Verbos no presente, sem "vamos", "iremos", "consideramos". Exemplo: "Extrair o módulo X para repo NestJS dedicado na org enlite-health."

Listar mudanças concretas em bullets:
- Mudança concreta 1
- Mudança concreta 2
- ...>

## Consequences

### Positivas
- <ganho concreto 1>
- <ganho concreto 2>

### Negativas
- <custo concreto 1>
- <custo concreto 2>

### Neutras
- <mudança que não é ganho nem perda mas é importante registrar>

## Alternatives Considered

### Alternativa A: <nome>
<1-3 linhas descrevendo a alternativa>

**Descartada porque:** <razão objetiva, não "menos elegante">

### Alternativa B: <nome>
...

(mínimo 1 alternativa descartada; ideal 2-3)

## Implementation Notes (opcional)

- Migrations envolvidas: <lista ou "N/A">
- Feature flags: <nome + ramp date> ou "N/A"
- Rollback plan: <como reverter se der ruim>
- Follow-up TD (em `docs/FOLLOWUPS.md`): TD-NNN

## References

- <link ou path interno>
- <link Fowler/Newman/Anthropic se aplicável>
```

---

## Status lifecycle

| Status | Significado | Quem muda |
|---|---|---|
| `Proposed` | Architect propôs, aguarda revisão | Architect ao criar |
| `Accepted` | PO + Gabriel validaram | PO via revisão final |
| `Rejected` | Discussão concluída sem adoção | PO/Gabriel |
| `Deprecated` | Decisão antiga substituída por ADR posterior | Architect ao criar ADR substituto |
| `Superseded by ADR-NNN` | Substituída por outra decisão | Architect ao criar substituta |

Sempre que mudar status, atualizar campo `Status:` no topo. Não deletar ADRs antigos — manter rastro histórico.

---

## Anti-padrões específicos do Mode 3

| Anti-padrão | Sintoma | Correção |
|---|---|---|
| ADR sem alternativa descartada | Decision vira monólogo | ≥1 alternativa nomeada e descartada com razão objetiva |
| Decision em futuro condicional | "Poderemos extrair X" | Reescrever em imperativo presente |
| Consequences só positivas | Architect vendendo a decisão | Forçar pelo menos 1 negativa real |
| Ausência de Rollback plan em decisão de schema | Decisão irreversível sem plano | Sempre incluir como reverter (mesmo que seja "irreversível — backup pre-migration obrigatório") |
| ADR pra decisão local | Polui `docs/adr/` | Voltar pra Mode 1 ou 2 |

---

## Regra de coexistência com `docs/FOLLOWUPS.md`

- **ADRs**: registram a DECISÃO (por que escolhemos X em vez de Y, com consequências).
- **FOLLOWUPS (TD-NNN / DP-NNN)**: registram TRABALHO PENDENTE consequente (migration, cleanup, deprecação).

Quando um ADR é aceito e gera trabalho subsequente, abrir TD-NNN em `docs/FOLLOWUPS.md` apontando pro ADR (`Ver ADR-NNN`).
