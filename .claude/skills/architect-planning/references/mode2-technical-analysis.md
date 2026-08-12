# Mode 2 — Technical Analysis

Formato Sifuentes-light (Conversational Development, dev.to). Use para parecer de **feature inteira** pro PO antes da decomposição em tasks.

**Quando usar:** PO está refinando feature; precisa de mapa do estado atual + recomendação prescritiva antes de planejar tasks.

---

## Estrutura literal

```
> Skill `architect-planning` aplicada — Mode 2. Referência: `architect-planning/references/mode2-technical-analysis.md`.

# Technical Analysis: <Feature Name>

## Problem
<1-2 frases descrevendo o problema técnico — não o problema de negócio>

## Architectural Impact
- **Camadas tocadas:** <domain | application | infrastructure | interface | cross-project>
- **Bounded contexts envolvidos:** <case | worker | vacancy | encuadre | funnel | ...>
- **Schema:** <muda | aditivo | sem mudança>
- **Serviços externos:** <ClickUp | Talentum | Firebase | Healthcare API | nenhum>

## Estado atual (Pattern Analysis)

### Tabelas relevantes
- `worker-functions/migrations/NNN_xxx.sql:linha` — <descrição curta>
- ...

### Entidades / domain
- `worker-functions/src/domain/.../X.entity.ts:linha` — <responsabilidade>
- ...

### Use cases / application
- `worker-functions/src/application/.../X.use-case.ts:linha` — <comportamento atual>
- ...

### Repositórios / infrastructure
- `worker-functions/src/infrastructure/.../X.repository.ts:linha` — <queries chave>
- ...

### Frontend (se aplicável)
- `enlite-frontend/src/.../X.tsx:linha` — <componente/página>
- ...

## Proposed Solution

**Recomendação:** REUSAR / ESTENDER / CRIAR — <verbo de ação curto>

**Justificativa (≤ 5 linhas):**
<por que essa recomendação, citando heurística de `reuso-vs-criacao.md` quando aplicável>

**Alternativas descartadas (≥ 1):**
- <opção descartada> — descartada porque <razão objetiva>

## Implementation Map

| # | Arquivo | Ação | Camada | Risco |
|---|---|---|---|---|
| 1 | `caminho/relativo/arquivo.ts` | criar / modificar / deletar | domain/app/infra/interface | baixo/médio/alto |
| 2 | ... | | | |

## Data Flow (se cross-camada)

```
<diagrama em texto — origem → middleware → destino, com responsabilidades>
```

## Build Sequence
1. <Passo 1 — incluindo migration se aplicável>
2. <Passo 2 — bloqueante para passo 3>
3. ...

## Risks & Mitigations

- **Risco:** <descrição objetiva>
  **Mitigação:** <ação concreta>

(repetir 1-3 vezes; se zero risco identificado, escrever "Nenhum risco material identificado — feature contida em <escopo>")

## Veredito do Architect

- **Suporta hoje?** SIM / PARCIAL / NÃO
- **Recomendação final:** <1 linha imperativa>
- **VETO (se aplicável):** <o que não pode ser feito e por quê>
```

---

## Regras de preenchimento

- **Pattern Analysis com `arquivo:linha`** é obrigatório. Sem isso, parecer inválido.
- **Recomendação imperativa**: "Estender `Patient.case_number`" é válido; "considerar estender ou criar" não é.
- **Pelo menos 1 alternativa descartada nomeada**. Sem descarte, não houve análise.
- **Tabela de Implementation Map**: linhas com risco "alto" exigem mitigação correspondente em Risks.
- **Build Sequence** deve refletir dependências reais (passo 2 não roda sem passo 1).

---

## Anti-padrões específicos do Mode 2

| Anti-padrão | Sintoma | Correção |
|---|---|---|
| Pattern Analysis sem `file:linha` | "Existe um use case de X" sem path | Sempre `arquivo:linha`. Se não achou, dizer "Não encontrado via grep `<padrão>`". |
| Recomendação plural | "REUSAR ou CRIAR" | Decidir uma; "depende" não vale. |
| Alternativa fantoche | Descarta opção obviamente ruim | Descartar alternativa séria (a que o caller poderia ter escolhido por default). |
| Build Sequence linear sem necessidade | Lista N passos sequenciais quando 2 podem paralelizar | Marcar paralelismo explicitamente. |
| Risco genérico | "Risco: regressão" | Risco precisa de fronteira: qual módulo, qual cenário, como verificar. |

---

## Quando escalar pra Mode 3

- A decisão muda fronteira de serviço (extrai pra repo Nest novo, funde serviços)
- A decisão muda schema base (renomeia tabela, muda PK, muda tipo de coluna chave)
- A decisão troca biblioteca core (ORM, framework)
- Política de PII/RBAC global muda

Nesses casos, parar Mode 2 e refazer em Mode 3 (gera arquivo em `docs/adr/`).
