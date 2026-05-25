# ADR 004: Providers de prescreening são plugáveis — Talentum é um deles, não o modelo

- **Status:** Accepted
- **Data:** 2026-05-25
- **Decisor(es):** Gabriel + PO + Architect
- **Contexto técnico:** worker-functions/src/modules/integration + worker-functions/src/modules/matching

## Context

Hoje, o único provider de prescreening externo integrado à Enlite é o **Talentum**. Ele recebe workers via WhatsApp, faz uma triagem (perguntas, captura de currículo, qualificação básica) e devolve um veredito (`QUALIFIED`, `IN_DOUBT`, `NOT_QUALIFIED`, `PENDING`) via webhook.

Vários pontos do código acoplam-se nominalmente a "Talentum":

- `TalentumPrescreeningRepository`, `TalentumWebhookController`, `TalentumFunnelStageMapper`
- `source = 'talentum'` na tabela `worker_job_applications`
- Pasta `worker-functions/src/modules/integration/talentum/`
- `talentum_prescreenings` (tabela), `talentum_status` (campo derivado)

**O problema:** Talentum **NÃO é a essência do funil** — é apenas um provider externo de prescreening. A Enlite pode (e deve) substituir, complementar ou descontinuar Talentum no futuro:

- Outro vendor (ex: novo serviço de triagem automatizada)
- Microserviço próprio (`enlite-prescreening-service` na arquitetura-alvo)
- Múltiplos providers simultâneos (Talentum pra um segmento, próprio pra outro)
- Triagem 100% interna sem dependência externa

Sem documentar essa intenção, refactors futuros tendem a renomear/migrar de `Talentum*` pra `NovoProvider*` 1:1, perpetuando o acoplamento ao invés de generalizar.

## Decision

**Talentum é UM provider de prescreening, não O modelo. Qualquer integração nova ou migração deve assumir a possibilidade de múltiplos providers coexistindo.**

### Princípios de design

1. **Funil canônico Enlite ≠ vocabulário de provider.** `application_funnel_stage` (INVITED, INITIATED, IN_PROGRESS, COMPLETED, QUALIFIED, IN_DOUBT, CONFIRMED, SELECTED, REJECTED) é vocabulário interno da Enlite. Cada provider traduz seu próprio vocabulário pro funil via mapper dedicado (interface `FunnelStageMapper<TProviderState>`).

2. **`source` é genérico, não nominal-de-vendor.** Valores válidos em `worker_job_applications.source`:
   - `'system'` — match automático interno (MatchmakingService)
   - `'manual'` — admin drag-drop ou worker auto-aplicação via link público
   - `'talentum'` — prescreening provider externo (Talentum, atualmente o único)
   - **Futuro:** novos providers viram novos valores em `source` (ex: `'prescreening_v2'`), OU `source='prescreening'` + coluna nova `prescreening_provider` separa o nome do provider da semântica

3. **Tabelas/símbolos com `Talentum*` no nome continuam aceitáveis enquanto Talentum for o único provider integrado.** O dia que entrar um segundo provider, fazer extract: `talentum_prescreenings` vira `prescreenings` (genérica) + coluna `provider_id`/`provider_name`. Não refatorar preventivamente.

4. **Endpoints de webhook seguem o padrão `/api/webhooks/<provider>/<event>`.** Talentum atual: `/api/webhooks/talentum/prescreening`. Novo provider X: `/api/webhooks/x/prescreening`. Permite roteamento por provider sem ambiguidade.

5. **Talentum descartável — sem dependências circulares.** Funcionalidades core da Enlite (criar vaga, matchmaking, agendamento, Kanban, seleção) **não podem depender** de Talentum estar online. Talentum entrega prescreening enriquecido; sem ele, workers ainda entram pelo funil via match automático ou link público (`application_funnel_stage='INVITED'`).

### O que NÃO muda em F7.c

- Símbolos `TalentumPrescreeningRepository`, `TalentumWebhookController`, etc. **permanecem com o nome**. Renomear preventivamente cria churn sem ganho — quando um segundo provider entrar, aí extract.
- Tabela `talentum_prescreenings` permanece. Migration pra `prescreenings + provider_id` fica pra quando o segundo provider for definido.
- `source='talentum'` continua sendo escrito pelo TalentumPrescreeningRepository.

### O que muda em F7.c

- `MatchmakingService` passa a escrever `source='system'` + `acquisition_channel='system'` (estava NULL — bug).
- Documentação dos docs WJA passa a referir-se a "providers de prescreening" no plural, com Talentum como exemplo, não como definição.
- Memória nova `project_prescreening_providers_pluggable.md` documenta a intenção pra futuras conversas.

## Consequences

### Positivas

- **Sinaliza intenção arquitetural** sem custo de refactor preventivo
- **Reduz risco de over-coupling** em features novas que mexem em prescreening
- **Aumenta legibilidade da arquitetura-alvo** (microserviços em `docs/architecture/` e roadmaps mencionam múltiplos providers — esta ADR conecta)
- **Permite renomear símbolos de forma incremental** quando segundo provider entrar (no PR que faz a integração)
- **Documenta `source='system'`** como vocabulário canônico pra match automático (era valor implícito/bugado)

### Negativas

- **ADR sem rollout imediato** corre risco de cair em obsolescência sem segundo provider entrar. Mitigação: revisar a cada 6 meses se ainda faz sentido.
- **`Talentum*` continua proeminente no código** — quem entra novo no projeto ainda associa "prescreening = Talentum". Mitigação: docs WJA atualizadas + memória.

### Neutras

- Sem mudança de schema cross-cutting
- Sem breaking change em endpoints
- Sem migração de dados

## Alternatives Considered

### Alternativa A: Refactor preventivo agora — renomear tudo pra `Prescreening*`

`TalentumPrescreeningRepository` → `PrescreeningRepository`, `talentum_prescreenings` → `prescreenings + provider_id`, `source='talentum'` → `source='prescreening'`.

**Rejeitado:** churn alto sem ganho concreto enquanto não há segundo provider. Adiciona indireção genérica que pode não casar com o segundo provider quando ele aparecer. Princípio: extract quando o segundo caso real chegar, não antes.

### Alternativa B: Não documentar — deixar implícito

Assumir que devs futuros entendem que Talentum é descartável.

**Rejeitado:** o nome está em 4+ módulos do código + tabela + endpoint + valor em `source`. Sem documentação explícita, refactors tendem a perpetuar o acoplamento. ADR custa pouco, comunica intenção.

### Alternativa C: Adicionar coluna `prescreening_provider` agora preemptivamente

Schema-only mudança: adicionar `worker_job_applications.prescreening_provider VARCHAR(50) DEFAULT NULL` agora.

**Rejeitado:** mudança de schema com 0 consumers = coluna morta. Se um dia chegar segundo provider, aí faz a coluna no mesmo PR que integra ele.

## Rollback

ADR rollback é puro — remove o arquivo + reverter as 2 linhas no `MatchmakingService` (source+acquisition_channel). Sem perda de dados, sem migração.

## Implementation Notes

- Aplicação inicial em F7.c (2026-05-25): adiciona `source='system'` no MatchmakingService.
- Docs WJA atualizadas pra usar "providers de prescreening" no plural.
- Memória `project_prescreening_providers_pluggable.md` criada.
- Trigger pra revisitar: quando segundo provider entrar no roadmap (sem deadline definido).

## References

- [ADR-002](002-wja-canonico-encuadres-deprecada.md) — promoção WJA a SSOT canônico
- [ADR-003](003-naming-wja-vs-encuadre.md) — convenções de naming WJA/Encuadre
- [`docs/features/worker-job-applications/02-vocabulario.md`](../features/worker-job-applications/02-vocabulario.md) — vocabulário canônico vs vocabulário de provider
- [`worker-functions/src/modules/matching/domain/FunnelStageMapper.ts`](../../worker-functions/src/modules/matching/domain/FunnelStageMapper.ts) — interface genérica de mapper por provider
- `docs/architecture/` — diagramas da arquitetura-alvo (9 microserviços) mencionam serviço de prescreening como peça independente
- Memória: `project_prescreening_providers_pluggable.md` (criada com este ADR)
