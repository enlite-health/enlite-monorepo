# Heurísticas — REUSAR vs CRIAR

Base teórica cruzada: Sandi Metz, Martin Fowler, Kent Beck, Vaughn Vernon, DDD community, HN/Reddit threads convergentes.

**Regra default:** REUSAR. Criação nova exige evidência de pelo menos 1 critério de criação listado abaixo.

---

## Critérios PRÓ-REUSAR (defaults)

### R1 — Já existe e cobre o caso

O código/coluna/tabela existente já cobre semanticamente o caso novo.

**Evidência exigida:** `grep` mostrando uso atual + leitura confirmando semântica idêntica.

**Exemplo Enlite:** `patients.case_number` já existe e é UNIQUE parcial — reusar pra dedup do webhook ClickUp em vez de criar `external_id`.

### R2 — Rule of Three NÃO satisfeita

Ainda não há 3 sites de uso com a mesma necessidade. Extração prematura.

Fonte: Fowler — _"Three strikes and you refactor."_ — duas ocorrências não justificam abstração; a terceira é o gatilho.

**Implicação:** se a feature nova é o 2º site de uso, NÃO criar abstração — duplicar e esperar o 3º.

### R3 — Mesmo bounded context

A funcionalidade pertence ao mesmo bounded context (case, worker, vacancy, encuadre, funnel) de algo existente. Estender é seguro.

Fonte: Vaughn Vernon / Eric Evans — bounded context define o escopo onde reuso é semanticamente válido.

### R4 — Schema aditivo viável

A mudança de schema cabe como coluna nova em tabela existente ou como tabela de extensão com FK clara. Migration aditiva é preferível a estrutura paralela.

**Memory cruzado:** `feedback_schema_decisions` — extension tables só existem quando o role tem colunas extras reais.

---

## Critérios PRÓ-CRIAR (exigem evidência)

### C1 — Bounded context diferente

A funcionalidade pertence a um bounded context distinto (mesmo que o NOME pareça reutilizável).

Fonte: Vernon — _"Termos têm semântica diferente em contextos distintos."_

**Exemplo Enlite:** "interview" no contexto de pré-seleção (worker_job_applications.interview_*) vs "interview" no contexto de matching (encuadres) — historicamente eram tratados como duplicados; decisão 2026-05-23 consolidou no WJA, mas a regra geral: nome igual em contextos diferentes = falso reuso.

### C2 — Wrong abstraction caro

Reusar exigiria adicionar parâmetros booleanos, casts, type-checks ou ramificações no código existente que servem só pro caso novo.

Fonte: Sandi Metz — _"duplication is far cheaper than the wrong abstraction"_ + Iron Academy — sintomas de wrong abstraction (cast, type-check, parâmetro booleano novo crescendo).

**Sinal claro:** se reusar te força a renomear a função pra um nome mais genérico que perde o significado original ("doStuff", "process", "handle"), você criou wrong abstraction.

### C3 — Rule of Three satisfeita

3+ sites de uso já existem com a mesma necessidade. Agora vale extrair.

Fonte: Fowler, Beck (Refactoring 2.0).

### C4 — Risco de acoplamento entre contextos

Estender X em vez de criar Y obrigaria a importar de outro bounded context, criando dependência cross-context onde não havia. Cria shared kernel poluído.

Fonte: DDD community / DevIQ — _"Shared Kernel should be minimal; business logic should not be reused as it always evolves on separate trajectories."_

### C5 — SLA / lifecycle radicalmente diferente

A funcionalidade nova tem ciclo de release, ownership ou requisitos não-funcionais (latência, availability, compliance) materialmente diferentes do que reuso ofereceria.

→ Quando esse critério dispara em escala de SERVIÇO, ir pra [`extracao-repo-novo.md`](extracao-repo-novo.md).

---

## Heurística do "nome honesto" (HN 12061453)

Pergunta diagnóstica para checar se reuso é falso:

> "Consigo nomear esta função/entidade/tabela de forma que o nome cubra honestamente todos os usos atuais e o novo?"

- **Sim** → reuso é válido. Estenda.
- **Não** (precisa de "ou" / "e também" no nome) → wrong abstraction. Duplicar.

**Exemplo:**
- `Patient` cobre paciente clínico e paciente de demonstração? Se "demonstração" não é semanticamente "paciente", criar entidade separada.
- `validateEmail` cobre email de worker e email de stakeholder? Se a regra é idêntica, sim. Se uma aceita +alias e outra não, separar.

---

## Decisão final — Algoritmo

```
1. Existe candidato a reuso?
   ├─ NÃO → CRIAR (justificar por que grep negativo)
   └─ SIM → continuar

2. Mesmo bounded context?
   ├─ NÃO → CRIAR (justificar por C1)
   └─ SIM → continuar

3. Reusar passa no teste do "nome honesto"?
   ├─ NÃO → CRIAR (justificar por C2 — wrong abstraction)
   └─ SIM → continuar

4. Rule of Three satisfeita OU estender é trivial (sem if/booleano novo)?
   ├─ NÃO → DUPLICAR LOCALMENTE (não extrair ainda)
   └─ SIM → REUSAR (estender existente)
```

---

## Anti-padrões a vetar com VETO duro

- **Criar tabela nova** quando coluna em tabela existente caberia → VETO
- **Criar entidade nova** quando estender campos de entidade do mesmo bounded context resolve → VETO
- **Criar extension table** sem que o role tenha pelo menos 2 colunas extras reais → VETO (memory: `feedback_schema_decisions`)
- **Extrair abstração** com 1-2 sites de uso → VETO (R2)
- **Reusar nome semanticamente diferente entre contextos** → VETO (C1)
- **Adicionar parâmetro booleano** numa função existente pra cobrir caso novo → VETO (C2)

---

## Citações de fonte para usar no parecer (quando útil)

- Sandi Metz, "The Wrong Abstraction" — _"duplication is far cheaper than the wrong abstraction"_ — https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction
- Martin Fowler, Bounded Context — https://martinfowler.com/bliki/BoundedContext.html
- Rule of Three — https://en.wikipedia.org/wiki/Rule_of_three_(computer_programming)
- DevIQ Shared Kernel — https://deviq.com/domain-driven-design/shared-kernel/

Usar com parcimônia — citação é evidência, não recheio.
