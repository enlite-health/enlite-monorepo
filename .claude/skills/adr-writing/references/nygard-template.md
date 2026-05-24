# Template Nygard literal

Formato base: Michael Nygard, "Documenting Architecture Decisions" (cognitect.com, 2011). Adaptado pra Enlite com seções obrigatórias adicionais (Rollback, References) já validadas pela skill `architect-planning` Mode 3.

---

## Estrutura literal do arquivo `.md`

Escrever EXATAMENTE o seguinte template, substituindo os campos `<...>` pelo conteúdo recebido do caller. Não adicionar seções, não remover seções, não reordenar.

```markdown
# ADR <NNN>: <Título>

- **Status:** Proposed
- **Data:** <YYYY-MM-DD>
- **Decisor(es):** <agente architect + PO + Gabriel quando humano confirmou>
- **Contexto técnico:** <repo/módulo onde a decisão se aplica>

## Context

<Conteúdo recebido. 3-8 linhas descrevendo a situação técnica que força a decisão. Cita arquivos, regras de negócio, restrições. Cada parágrafo tem propósito. Sem prosa enchendo linguiça.>

## Decision

<Conteúdo recebido. Decisão imperativa em 1-3 frases. Verbos no presente, sem "vamos", "iremos", "consideramos".

Listar mudanças concretas em bullets:
- Mudança concreta 1
- Mudança concreta 2
- ...>

## Consequences

### Positivas
- <ganho concreto recebido>
- <ganho concreto recebido>

### Negativas
- <custo concreto recebido>
- <custo concreto recebido>

### Neutras
- <mudança que não é ganho nem perda mas é importante registrar — opcional>

## Alternatives Considered

### Alternativa A: <nome>
<1-3 linhas descrevendo a alternativa>

**Descartada porque:** <razão objetiva, não "menos elegante">

### Alternativa B: <nome>
<...>

**Descartada porque:** <razão objetiva>

(mínimo 1 alternativa descartada; ideal 2-3)

## Rollback

<Plano concreto pra reverter a decisão se necessário. Mesmo que seja "irreversível", documentar como mitigar — ex: backup pre-migration obrigatório, snapshot de tabela X antes de executar.>

## Implementation Notes (opcional — incluir só se aplicável)

- Migrations envolvidas: <lista ou omitir seção>
- Feature flags: <nome + ramp date ou omitir>
- Follow-up TD (em `docs/FOLLOWUPS.md`): TD-NNN (preenchido após Fase 4 da skill)

## References

- <link ou path interno relevante>
- <link Fowler/Newman/Anthropic se aplicável>
```

---

## Validação antes de escrever

Antes de invocar `Write`, verificar:

| Seção | Obrigatória | Validação |
|---|---|---|
| Title (linha 1) | Sim | Começa com `# ADR <NNN>:` |
| Status | Sim | Valor é exatamente `Proposed` na criação |
| Data | Sim | Formato `YYYY-MM-DD` |
| Decisor(es) | Sim | Não vazio |
| Context | Sim | ≥ 3 linhas de conteúdo |
| Decision | Sim | Verbo imperativo no presente; ≥ 1 bullet de mudança concreta |
| Consequences > Positivas | Sim | ≥ 1 item |
| Consequences > Negativas | Sim | ≥ 1 item (NUNCA "Nenhuma" — se vazio, ADR é suspeito de viés) |
| Alternatives Considered | Sim | ≥ 1 alternativa nomeada e descartada |
| Rollback | Sim | Não vazio |
| References | Opcional | — |

Se qualquer linha "Sim" falhar, **devolver erro estruturado ao caller** com o nome da seção faltando.

---

## Erros estruturados que a skill devolve

Quando conteúdo recebido não passa validação, devolver ao caller:

```
## ERRO ao persistir ADR

- **Causa:** Seção obrigatória <nome> ausente ou vazia
- **Fix:** Pedir ao architect que complete a seção e re-invocar
- **Não foi escrito:** Nenhum arquivo criado em `docs/adr/`
```

Não escrever arquivo parcial. Não preencher com placeholder.

---

## Anti-padrões observados (recusar persistir)

| Anti-padrão | Sintoma | Ação |
|---|---|---|
| Decision em futuro condicional | "Poderemos extrair X", "Talvez vale considerar Y" | Recusar; pedir reescrita imperativa |
| Consequências só positivas | Architect vende a decisão | Recusar; forçar ao menos 1 negativa real |
| ADR pra decisão local | "Renomear coluna foo pra bar" | Recusar; sugerir Mode 1 (Y-statement) ou Mode 2 (Technical Analysis) inline |
| Rollback "irreversível" sem mitigação | Plano vazio | Recusar; exigir pelo menos "backup obrigatório antes de aplicar" |
| Alternativa fantoche | Descarta opção obviamente ruim | Recusar; pedir alternativa séria que o caller poderia ter escolhido por default |
