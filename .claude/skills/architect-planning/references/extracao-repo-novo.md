# Extração para repo NestJS novo — Gating duro

Base teórica cruzada: Martin Fowler (MonolithFirst), Sam Newman (Monolith to Microservices), Shopify Engineering, Kamil Grzybek (Modular Monolith), Adrian Cockcroft, Segment, Three Dots Labs.

**Política Enlite** (CLAUDE.md): _"cada novo microservice nasce em repo próprio na org enlite-health. Não estender o monorepo com novos serviços."_ — mas extração de código EXISTENTE pra repo novo é decisão arquitetural separada que requer gating.

**Default arquitetural:** modular monolith dentro de `worker-functions`. Extração só com ≥ 1 dos 4 critérios abaixo satisfeito.

---

## Os 4 critérios de extração

Cada critério tem PROVA exigida. Architect só recomenda extração se ≥ 1 critério passa com prova explícita.

### Critério 1 — Scaling assimétrico (SLA / availability distinto)

A funcionalidade tem requisitos de latência, throughput ou availability materialmente diferentes do resto do monolito.

**Prova exigida:**
- Métrica quantitativa: ex. _"endpoint precisa < 200ms p99 vs média do monolito 800ms p99"_
- OU justificativa de carga: _"throughput de 500 req/s vs 50 req/s do resto"_
- OU disponibilidade: _"need 99.99% uptime, monolito tem 99.5%"_

**Fonte:** Shopify Engineering — extração só por "read-only use case with very high throughput".

**Aplicabilidade Enlite:** geralmente NÃO satisfeito. Plataforma tem carga uniforme até hoje.

---

### Critério 2 — Compliance / PII isolation

A funcionalidade processa dado sensível (PHI clínico, PCI, dados regulados) que precisa de audit boundary, encryption-at-rest separado ou conformidade regulatória distinta.

**Prova exigida:**
- Categoria do dado: PHI clínico (HIPAA/LGPD saúde), PCI, dado financeiro auditado
- Requisito de isolamento documentado (LGPD art. X, contratos com clientes, política interna)
- Já está no roadmap de arquitetura-alvo Enlite?

**Fonte:** Shopify (credit-card vaulting saiu por PCI), arquitetura-alvo Enlite (PHI clínico → Healthcare API no mês 9 — memory: `project_data_layer_roadmap`).

**Aplicabilidade Enlite:** SATISFEITO para domínios de prontuário clínico, relatórios diários com dado de saúde, supervisão médica. Pacientes/responsáveis NÃO satisfaz isoladamente (são dados pessoais comuns, vão pra case-service mas não Healthcare API).

---

### Critério 3 — Time independente maduro (Inverse Conway)

Existe time dedicado (≥ 2 devs estáveis) com on-call próprio e roadmap próprio, justificando boundary de deploy independente.

**Prova exigida:**
- Nome do time / squad
- Quantidade de devs alocados full-time
- On-call rotation já existente
- Roadmap próprio (não acoplado a sprints do monolito)

**Fonte:** Martin Fowler — Conway's Law; Sam Newman — boundary por team capability; Segment InfoQ — _"50+ destinations, ~3 novos/mês, devs drowning in complexity"_ (sinal de NÃO ter time pra cada serviço).

**Aplicabilidade Enlite:** geralmente NÃO satisfeito hoje. Time é pequeno. Se a recomendação de extração depende SÓ desse critério, vetar e revisitar quando time crescer.

---

### Critério 4 — Bounded context maduro e estável

O bounded context está bem definido há ≥ 6 meses, com poucos cross-references ao resto do monolito.

**Prova exigida:**
- Bounded context nomeado (case, worker, vacancy, encuadre, funnel, prescreening, supervisao_diaria, healthcare, comms)
- Estabilidade: sem mudanças estruturais ao schema/domain nos últimos ≥ 6 meses
- Acoplamento medível: `grep` mostrando < 5 imports cruzando a fronteira pra outros contextos

**Fonte:** Martin Fowler MonolithFirst — _"even experienced architects working in familiar domains have great difficulty getting boundaries right at the beginning"_; Sam Newman — bounded contexts como service first.

**Aplicabilidade Enlite:** parcial. `triage-service` já foi extraído quando esse critério passou. Para outros candidatos, verificar individualmente.

---

## Sinais negativos (forçam VETO mesmo se 1+ critério passa)

Se qualquer um dos abaixo, **VETAR extração** independentemente dos 4 critérios:

### V1 — Compartilha 3+ entidades de domínio com o monolito
Refactor cross-service vira distribuído.
Fonte: Fowler — _"refactoring between services is much harder than in a monolith"_.

### V2 — Chamadas sync chatty previsíveis
Se extrair criaria > 3 chamadas sync entre serviços para um caso de uso → distributed monolith.
Fonte: Three Dots Labs — _"a lot of calls back and forth = sign that maybe those two services shouldn't be separate."_

### V3 — Feature ainda exploratória (validation de produto)
Wrong abstraction risk é altíssimo. Esperar maturidade.
Fonte: Sandi Metz aplicada à arquitetura — _"the fastest way forward is back"_.

### V4 — Time pequeno (< 2 devs por contexto)
Segment provou: microservice com time pequeno = drowning.
Fonte: Segment InfoQ 2020.

---

## Procedimento do architect

Ao avaliar candidato a extração:

```
1. Identifico ≥ 1 dos 4 critérios satisfeito com PROVA?
   ├─ NÃO → VETAR extração, recomendar modular monolith
   └─ SIM → continuar

2. Há sinal negativo (V1, V2, V3, V4) ativo?
   ├─ SIM → VETAR extração, justificar com sinal específico
   └─ NÃO → continuar

3. Recomendar extração em Mode 3 (ADR persistente)
   - Status: Proposed
   - Listar critério satisfeito + prova
   - Listar sinais negativos checados e descartados
   - Rollback plan: o que fazer se a extração se mostrar errada
   - Follow-up: TD-NNN em FOLLOWUPS.md
```

---

## Saída esperada quando architect avalia extração

Esta seção deve aparecer no parecer (Mode 2) ou ADR (Mode 3):

```
## Avaliação de Extração pra Repo Nest Novo

### Critérios de extração
- [ ] C1 — Scaling assimétrico — <PROVA ou "Não satisfeito">
- [ ] C2 — Compliance / PII isolation — <PROVA ou "Não satisfeito">
- [ ] C3 — Time independente maduro — <PROVA ou "Não satisfeito">
- [ ] C4 — Bounded context maduro — <PROVA ou "Não satisfeito">

### Sinais negativos checados
- [ ] V1 — Compartilha 3+ entidades — <status>
- [ ] V2 — Chatty sync calls previstas — <status>
- [ ] V3 — Feature ainda exploratória — <status>
- [ ] V4 — Time < 2 devs — <status>

### Recomendação
EXTRAIR / NÃO EXTRAIR — <justificativa em 1 frase>
```

---

## Casos reais para referência

| Caso | Decisão | Por quê | Lição |
|---|---|---|---|
| **triage-service** (Enlite, já feito) | Extraído | C4 (boundary estável de triagem WhatsApp), C2 parcial (dados de conversa) | Bom: comunicação MCP enxuta |
| **Shopify monolith** | Manter | Sem scaling assimétrico universal; Packwerk garante boundary | Modular monolith escala muito longe |
| **Amazon Prime Video VQA** | Re-monolitizado | Chatty serverless inflado em custo; 1 componente isolado | _Não_ todo microservice é bom |
| **Segment Centrifuge** | Re-monolitizado | Time pequeno + 50+ destinations = drowning | Time pequeno → monolito |
| **Stack Overflow** | Sempre monolito | 4B req/mês com 9 IIS servers, "avoided SOA tax" | Performance > SOA |

Fontes em [`SKILL.md`](../SKILL.md) (restrições WebFetch) ou:
- https://shopify.engineering/shopify-monolith
- https://thenewstack.io/return-of-the-monolith-amazon-dumps-microservices-for-video-monitoring/
- https://www.infoq.com/news/2020/04/microservices-back-again/
- https://martinfowler.com/bliki/MonolithFirst.html
