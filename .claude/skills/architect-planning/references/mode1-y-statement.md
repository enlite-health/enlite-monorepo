# Mode 1 — Y-statement

Formato compacto de Olaf Zimmermann (ABB, HSR/OST) — 1 frase com 6 slots. Use para decisões granulares que cabem em uma sentença.

**Quando usar:** escolha entre 2 opções concretas, escopo local (1 nome, 1 coluna, 1 entidade pequena, 1 reuso vs duplicação de função).

---

## Estrutura literal

```
> Skill `architect-planning` aplicada — Mode 1. Referência: `architect-planning/references/mode1-y-statement.md`.

## Decisão (Y-statement)

In the context of **<componente/use-case>**,
facing **<concern/NFR>**,
we decided for **<opção escolhida>**
and neglected **<alternativa(s) descartada(s)>**,
to achieve **<benefício>**,
accepting **<downside/custo>**.

## Evidência
- <arquivo:linha> — <takeaway>
- <arquivo:linha> — <takeaway>
- <citação de RAG ou doc externa, se aplicável>

## Aplicação
- **Reusar / Criar / Estender:** <verbo + alvo>
- **Arquivos impactados:** <lista curta>
```

---

## Exemplo real (Enlite)

```
## Decisão (Y-statement)

In the context of identificação de paciente pelo webhook ClickUp,
facing risco de PII em logs e necessidade de dedup,
we decided for usar `patients.case_number` como identificador humano
and neglected criar `patients.external_id` ou usar `patient.name`,
to achieve dedup confiável + log PII-safe,
accepting case_number ser editável manualmente em raras correções (compensado por unique parcial).

## Evidência
- worker-functions/migrations/114_separate_vacancy_and_case_number.sql:1-40 — case_number já existe e é UNIQUE parcial
- worker-functions/src/modules/case/case.entity.ts:18 — patients.case_number declarado em domain
- memory: project_case_number_pii_identifier — convergência prévia

## Aplicação
- **Reusar** `patients.case_number` no webhook
- **Arquivos impactados:** worker-functions/src/modules/case/clickup-webhook.handler.ts
```

---

## Regras de preenchimento

- **1 frase só** no Y-statement. Se não cabe, escalar pra Mode 2.
- **3 ou mais linhas de Evidência** com `arquivo:linha`. Sem `arquivo:linha`, parecer inválido.
- **Não usar adjetivos vazios** ("robusto", "elegante", "escalável") como benefício. Trocar por métrica observável ("dedup confiável", "1 query a menos", "PII fora do log").
- **Sempre incluir o downside** — ausência de downside = parecer suspeito de viés.
- **Alternativa descartada nomeada** — não basta dizer "descartado outras opções"; nomear ≥1.

---

## Quando escalar pra Mode 2

- Decisão envolve > 1 entidade
- > 2 alternativas concretas em jogo
- Múltiplos arquivos em camadas diferentes (domain + infra + interface)
- PO pediu parecer de feature, não decisão atômica

Nesses casos, parar Mode 1 e refazer em Mode 2.
