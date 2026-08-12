# Template — Plano de Execução do PO

Estrutura **obrigatória** e **literal** de saída do agente `po` após refinamento de requisito. Não omitir seções; se uma seção for vazia, escrever explicitamente "N/A — <motivo>".

---

```
## Contexto do RAG
- Consultas executadas:
  - "<pergunta 1>" → <arquivo fonte> — <takeaway de 1 linha>
  - "<pergunta 2>" → <arquivo fonte> — <takeaway de 1 linha>
- Lacunas: <regras/conceitos sobre os quais o RAG não tem informação suficiente — ou "Nenhuma">

## Análise do Requisito
- **Pedido (1 frase):** <o que o stakeholder pediu, em uma frase>
- **Motivação:** <por que isso importa — citar regra de negócio / docs RAG>
- **Estado atual do código:** <o que já existe vs o que falta — citar arquivos>
- **Atores impactados:** <ATs, pacientes, supervisores, coordenadores, sistema externo X>

## Gaps e Sugestões
- **Ambiguidades:** <perguntas que ficaram em aberto — listar OU "Nenhuma">
- **Edge cases:** <casos limite que o pedido não cobre — listar OU "Nenhum identificado">
- **Reuso possível:** <componentes/use cases/colunas existentes que devem ser aproveitados — citar architect>
- **Riscos:** <regulatório, performance, sync ClickUp, RBAC, PII — listar OU "Baixo risco">

## Parecer do Architect
> **Importante:** o PO **não invoca** o architect (limitação técnica Claude Code). Esta seção é preenchida em uma das duas formas:
>
> 1. **Plano preliminar (PO 1ª passagem):** seção fica como `AGUARDANDO ARCHITECT` com descrição da pergunta arquitetural a ser respondida. Bloco `## Próximo Passo` no final do plano sinaliza "Architect necessário".
> 2. **Plano final (PO 2ª passagem, após Claude principal ter invocado architect):** seção é preenchida com o parecer retornado.

Quando preenchida:

- **Decisão:** REUSAR / CRIAR / HÍBRIDO
- **Justificativa (resumo):** <1-3 linhas do parecer>
- **Arquivos novos:** <lista> OU "Nenhum"
- **Arquivos modificados:** <lista>
- **Schema/migrations:** <se aplicável — número da migration prevista>
- **ADR criado (se Mode 3):** `docs/adr/NNN-titulo.md` — Status: Proposed

## Plano de Execução

### Task 1: <Nome curto e acionável> — [Backend|Frontend|Cross] — Complexidade: [Baixa|Média|Alta]
- **Objetivo:** <o que vai ficar pronto ao final desta task, em 1 frase>
- **Arquivos impactados:**
  - `caminho/arquivo.ts` (criar|modificar)
- **Critérios de aceite:**
  - [ ] <comportamento observável 1>
  - [ ] <comportamento observável 2>
  - [ ] Testes: <unit / e2e — quais cenários>
- **Dependências:** <Task N do plano OU "Nenhuma">
- **Modelo sugerido:** `haiku` | `sonnet` (conforme complexidade)

### Task 2: ...

(repetir o bloco para cada task)

## Sequenciamento
1. <Task X> — bloqueante para <Task Y>
2. <Task Y, Z> — podem rodar em paralelo
3. <Task W> — depende de X e Y

## Validação Final (checklist do QA)
- [ ] Todos os critérios de aceite de cada task atendidos
- [ ] Lint + type-check passam em ambos os projetos afetados
- [ ] Testes unitários e E2E passando (com screenshot assertion no frontend)
- [ ] Nenhum arquivo modificado ultrapassou 400 linhas; se ultrapassou, foi splitado
- [ ] Migrations rodadas em local e plano de prod documentado
- [ ] Nenhum `any`, nenhum enum em string solta no JSX (i18n), nenhum mock de DB em integration tests
- [ ] Regras de negócio Enlite respeitadas (citar quais foram tocadas)
```

---

## Regras de preenchimento

- **Não usar prosa entre seções.** Cabeçalhos + bullets apenas.
- **Citar arquivos com path relativo** (não absoluto) — ex: `worker-functions/src/domain/case/case.entity.ts:42`.
- **Cada critério de aceite** deve ser observável (passível de teste manual ou automatizado). Frases como "ficar bonito" ou "performance boa" são proibidas.
- **Modelo sugerido** segue a tabela do agente `po`:
  - Baixa (i18n, rename, campo simples) → `haiku`
  - Média (CRUD, componente com lógica, migration) → `sonnet`
  - Alta (cross-domain, refactor, lógica complexa) → `sonnet`
- Se uma task ficar > 8 horas estimadas mentais, **decompor**. Tasks gigantes mascaram risco.

## O que NUNCA incluir no plano

- Soluções genéricas tipo "adicionar logging" ou "melhorar performance" sem critério mensurável
- Tasks de "refatorar para deixar mais limpo" sem objetivo observável
- Estimativas em horas/dias (o time não usa)
- Linguagem de marketing ("solução robusta", "experiência fluida")
