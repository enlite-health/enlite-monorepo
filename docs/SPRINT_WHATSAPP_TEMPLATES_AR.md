# Sprint — WhatsApp Templates AR (recrutamento Argentina)

> **Status:** Templates criados no Twilio (6 approved, 2 pending). Backend pendente.
> **Owner:** _TBD_
> **Data spec:** 2026-05-19
> **Idioma:** `es_AR` (espanhol argentino, voseo)

## 1. Contexto

Operação argentina da EnLite precisa de 8 novos templates WhatsApp para o fluxo de recrutamento de Acompañantes Terapéuticos. Os templates cobrem três cenários:

| Bloco | Categoria | Templates | Trigger |
|---|---|---|---|
| Captação | MARKETING | M1, M2, M3 | Bulk via cron ou ação manual ops |
| Cadastro incompleto | UTILITY | U1, U2, U3 | Cron diário (modelo: `complete_register_ofc`) |
| Match de vaga | UTILITY | U4, U5 | Evento de domínio (criação de match) |

Esta sprint **reusa toda a infra existente** do módulo `notification/` (`TwilioMessagingService`, `MessageTemplateRepository`, `BulkDispatchScheduler`, `worker_reminder_state`). Não há refactor previsto.

## 2. Os 8 templates

### 2.1 Tabela de configuração

| slug (`message_templates.slug`) | category (DB) | content_sid | Meta category | Status Meta | Variáveis | Twilio type |
|---|---|---|---|---|---|---|
| `ar_invite_luz_personal` | recruitment | `HX5d77ccab1689ab6cf9b675a0b158e68d` | MARKETING | ✅ approved | `{{1}}` nome | call-to-action |
| `ar_invite_open` | recruitment | `HXfa0a2d7d8a9bf5a86ed1646e8497eb60` | MARKETING | ✅ approved | — | call-to-action |
| `ar_invite_poetic` | recruitment | `HX0e091cb0050c957f5d2ebe6096da888b` | MARKETING | ✅ approved | — | call-to-action |
| `ar_finalize_signup_direct` | onboarding | `HXeb5ece4811d2dce435ffb43b5f8738d0` | UTILITY | ✅ approved | `{{1}}` nome, `{{2}}` docs faltantes | text |
| `ar_signup_pending_reminder` | onboarding | `HX0d0b07db24fe3f90f8261856c3e37353` | MARKETING | ⏳ pending | `{{1}}` nome, `{{2}}` docs faltantes | text |
| `ar_finalize_signup_luz` | onboarding | `HX54d66dd603a9fdfd1eb9255128178514` | UTILITY | ✅ approved | `{{1}}` nome, `{{2}}` docs faltantes | text |
| `ar_vacancy_match_complete` | recruitment | `HXa1ff7c9189b625587929c5f19e4e614f` | MARKETING | ✅ approved | `{{1}}` nome, `{{2}}` localidade, `{{3}}` link vaga | text |
| `ar_vacancy_match_incomplete` | recruitment | `HXd8cd5071c998317731286be3e5164854` | MARKETING | ⏳ pending | `{{1}}` nome, `{{2}}` localidade, `{{3}}` docs faltantes, `{{4}}` link vaga | text |

> Categoria `recruitment` vs `onboarding` segue convenção das migrations 059/063 (`message_templates.category`), **não** confundir com categoria Meta (MARKETING/UTILITY).

> **Nota:** Slug `ar_finalize_signup_brief` foi renomeado pra `ar_signup_pending_reminder` durante a sprint (rejeitado pelo Meta como duplicado da U1 — reescrito com tom de notificação sistêmica e novo nome).

### 2.2 Conteúdos completos

#### M1 — `ar_invite_luz_personal` (MARKETING) ✅
```
¡Hola {{1}}! Soy Luz, de EnLite Health.

Ya formás parte de nuestra comunidad de profesionales del cuidado humano, y todos los días llegan pacientes que pueden necesitar lo que vos sabés ofrecer.

Para conectarte con las oportunidades más cercanas a tu zona, pasá por https://app.enlite.health, completá tu perfil y subí tus documentos. Ahí mismo vas a ver y postularte a las vacantes disponibles.

Creemos en el vínculo. Como Acompañante Terapéutica, podés transformar vidas.

Si querés conocer la comunidad antes, sumate al grupo: https://chat.whatsapp.com/Dmx1Pntou8L6OLOQDCmEsT

¿Lista para empezar?
```
**Botões CTA (URL):**
- `Acceder a EnLite` → `https://app.enlite.health`
- `Conocer beneficios` → `https://jobs.enlite.health/es/beneficios/`

> Link do grupo WhatsApp **não pode ficar em botão** (Meta proíbe `chat.whatsapp.com/...` em CTA). Foi movido pro corpo.

#### M2 — `ar_invite_open` (MARKETING) ✅
```
¡Hola! ¿Te imaginás trabajando con un propósito real, acompañando a personas en su camino de salud mental?

En EnLite Health ya somos más de 5 mil profesionales que eligieron este camino. Y siempre hay lugar para una mano más.

Si querés sumarte, registrate en https://app.enlite.health. Una vez dentro, vas a tener tu perfil, tus documentos y todas las vacantes en un mismo lugar.

Si querés sentir cómo es la comunidad antes de entrar, nuestro grupo abierto está acá: https://chat.whatsapp.com/Dmx1Pntou8L6OLOQDCmEsT

Te esperamos con la puerta abierta.
```
**Botões CTA:** mesmos da M1.

#### M3 — `ar_invite_poetic` (MARKETING) ✅
```
¡Hola! Espero que tu día esté siendo lindo.

Sumate a una red de profesionales que iluminan caminos en salud mental. En EnLite cuidamos a las personas con empatía e innovación — y sabemos que ese cuidado empieza por cuidar también a quien acompaña.

Registrate en https://app.enlite.health. Adentro vas a tener tu perfil, tus documentos y todas las vacantes en un mismo lugar.

Sumate también a nuestra comunidad: https://chat.whatsapp.com/Dmx1Pntou8L6OLOQDCmEsT

Estamos acá para hacerte el próximo paso más simple.
```
**Botões CTA:** mesmos da M1.

#### U1 — `ar_finalize_signup_direct` (UTILITY) ✅
```
¡Hola {{1}}! Tu registro en EnLite quedó a mitad de camino, y queremos ayudarte a terminarlo.

Para activar tu perfil y conectarte con oportunidades que coincidan con tu perfil, tu zona y tu disponibilidad, todavía nos falta: {{2}}.

Entrá a https://app.enlite.health para completarlo. Estamos para ayudarte.
```

#### U2 — `ar_signup_pending_reminder` (MARKETING) ⏳
> Slug renomeado de `ar_finalize_signup_brief` (rejeitado como duplicado da U1). Reescrito com tom de notificação sistêmica.
```
Buen día {{1}}. Te recordamos que tu inscripción en EnLite quedó incompleta.

Documentos pendientes: {{2}}.

Ingresá a https://app.enlite.health para finalizar el proceso.
```

#### U3 — `ar_finalize_signup_luz` (UTILITY) ✅
```
¡Hola {{1}}! Soy Luz. Paso para contarte que tu registro en EnLite ya está casi listo — falta poquito para que empieces a recibir matches personalizados de vacantes.

Para terminar nos falta: {{2}}.

Entrá a https://app.enlite.health y avanzá cuando tengas un ratito. Si trabás en algo, escribime.
```

#### U4 — `ar_vacancy_match_complete` (MARKETING) ✅
> Submetido como UTILITY, Meta reclassificou pra MARKETING (allow_category_change).
```
¡Hola {{1}}! Soy Luz, de EnLite Health.

Llegó una nueva oportunidad cerca tuyo, en {{2}}. Tu perfil coincide con lo que está buscando esta persona.

Mirá los detalles e inscribite a la entrevista acá: {{3}}.

¡Vamos a iluminar esta historia juntos!
```

#### U5 — `ar_vacancy_match_incomplete` (MARKETING) ⏳
```
¡Hola {{1}}! Soy Luz, de EnLite Health.

Llegó una oportunidad cerca tuyo, en {{2}}. Para postularte, todavía necesitamos: {{3}}.

Entrá a https://app.enlite.health, completá tu perfil y postulate acá: {{4}}.

Si tenés dudas, estoy del otro lado.
```

## 3. Etapas de implementação

### Etapa 1 — Criar templates no Twilio

Resultado esperado: **8 `ContentSid` (`HX...`) + 8 aprovações WhatsApp em status `approved`**.

Existem 4 caminhos. Escolher um — não misturar:

#### Caminho A — Console (manual, mais simples)
1. Acessar `Twilio Console → Messaging → Content Template Builder → Create new`
2. Para cada template, preencher:
   - **Friendly name:** o slug da tabela 2.1
   - **Language:** `es_AR`
   - **Content type:** `Call to Action` (M1/M2/M3) ou `Text` (U1–U5)
   - **Body:** copiar de 2.2
   - **Sample values:** preencher os `{{1}}`, `{{2}}` etc com exemplos reais (`María`, `tu CV actualizado y tu monotributo activo` etc) — Twilio rejeita se variável fica sem sample
   - **Actions (M1/M2/M3):** dois URL buttons conforme 2.2
3. `Save and submit for WhatsApp approval` → selecionar categoria (`MARKETING` ou `UTILITY` conforme 2.1) + ativar `Allow Meta to change category`
4. Aguardar aprovação (5min–24h) e copiar o `HX...` SID que aparece na lista

#### Caminho B — Twilio CLI (recomendado para reprodutibilidade)
Pré-requisitos:
```bash
npm install -g twilio-cli
twilio plugins:install @twilio-labs/plugin-content
twilio login
```

Criar e submeter cada template (exemplo M1):
```bash
twilio api:content:v1:contents:create \
  --friendly-name "ar_invite_luz_personal" \
  --language "es_AR" \
  --types '{"twilio/call-to-action":{"body":"¡Hola {{1}}!...","actions":[{"type":"URL","title":"Conocer beneficios","url":"https://jobs.enlite.health/es/beneficios/"},{"type":"URL","title":"Sumarme a la comunidad","url":"https://chat.whatsapp.com/Dmx1Pntou8L6OLOQDCmEsT"}]}}' \
  --variables '{"1":"María"}'
# Resposta inclui: sid = HXxxxxxxxxx

twilio api:content:v1:contents:approval-requests:whatsapp:create \
  --content-sid HXxxxxxxxxx \
  --name "ar_invite_luz_personal" \
  --category "MARKETING" \
  --allow-category-change
```

#### Caminho C — Twilio MCP Server (Alpha)
Para usar via Claude Code / Claude Desktop / Cursor, instalar o MCP:
1. Seguir instruções em https://twilioalpha.com/mcp (servidor self-hostable, configura credenciais Twilio)
2. Adicionar entrada no `~/.claude.json` (escopo MCP) apontando pro servidor local
3. Reiniciar Claude Code
4. As ferramentas `mcp__twilio__*` aparecem disponíveis — usar `content.create` + `content.approval_requests.create`

> ⚠️ MCP Twilio ainda é Alpha. Avaliar maturidade antes de adotar como padrão da equipe. Para criação one-shot dos 8 templates, **Caminho B (CLI) é mais previsível**.

#### Caminho D — curl direto à Content API
JSON payloads + comandos curl já documentados separadamente no anexo do PR de spec. Para cada template:
```bash
curl -X POST https://content.twilio.com/v1/Content \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d @m1.json
# → { "sid": "HX...", ... }

curl -X POST "https://content.twilio.com/v1/Content/$SID/ApprovalRequests/whatsapp" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"ar_invite_luz_personal","category":"MARKETING","allow_category_change":true}'
```

### Etapa 2 — Migration

Criar `worker-functions/migrations/NNN_add_ar_whatsapp_templates.sql` (próximo número da sequência — verificar com `ls worker-functions/migrations/`):

```sql
-- Add 8 WhatsApp templates for Argentina recruitment
-- Spec: docs/SPRINT_WHATSAPP_TEMPLATES_AR.md

INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
VALUES
  ('ar_invite_luz_personal',
   'AR · Invitación Luz personal',
   NULL,
   'recruitment',
   true,
   'HX5d77ccab1689ab6cf9b675a0b158e68d'),

  ('ar_invite_open',
   'AR · Invitación abierta',
   NULL,
   'recruitment',
   true,
   'HXfa0a2d7d8a9bf5a86ed1646e8497eb60'),

  ('ar_invite_poetic',
   'AR · Invitación poética',
   NULL,
   'recruitment',
   true,
   'HX0e091cb0050c957f5d2ebe6096da888b'),

  ('ar_finalize_signup_direct',
   'AR · Finalizar registro · directo',
   NULL,
   'onboarding',
   true,
   'HXeb5ece4811d2dce435ffb43b5f8738d0'),

  ('ar_signup_pending_reminder',
   'AR · Recordatorio inscripción pendiente',
   NULL,
   'onboarding',
   true,
   'HX0d0b07db24fe3f90f8261856c3e37353'),

  ('ar_finalize_signup_luz',
   'AR · Finalizar registro · Luz',
   NULL,
   'onboarding',
   true,
   'HX54d66dd603a9fdfd1eb9255128178514'),

  ('ar_vacancy_match_complete',
   'AR · Match vacante · perfil completo',
   NULL,
   'recruitment',
   true,
   'HXa1ff7c9189b625587929c5f19e4e614f'),

  ('ar_vacancy_match_incomplete',
   'AR · Match vacante · perfil incompleto',
   NULL,
   'recruitment',
   true,
   'HXd8cd5071c998317731286be3e5164854')

ON CONFLICT (slug) DO UPDATE
SET content_sid = EXCLUDED.content_sid,
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    is_active = EXCLUDED.is_active;
```

> `body` fica `NULL` porque o conteúdo vive no Twilio (referenciado via `content_sid`). O fluxo em `TwilioMessagingService.ts:56-67` detecta `content_sid !== null` e chama `messages.create({ contentSid, contentVariables })`.

Rodar:
```bash
# Local
cd worker-functions && node scripts/run-migrations-docker.js

# Staging / Produção
./scripts/run-migration-prod.sh worker-functions/migrations/NNN_add_ar_whatsapp_templates.sql
```

### Etapa 3 — Implementação de dispatch

#### 3.1 Helper compartilhado: `missingDocsLabel()`

Criar em `worker-functions/src/modules/notification/domain/MissingDocsLabel.ts`:

```ts
export type MissingDoc = 'cv' | 'antecedentes' | 'monotributo';

const LABELS: Record<MissingDoc, string> = {
  cv: 'tu CV actualizado',
  antecedentes: 'tu certificado de antecedentes penales',
  monotributo: 'tu monotributo dado de alta',
};

export function missingDocsLabel(missing: MissingDoc[]): string {
  if (missing.length === 0) {
    throw new Error('missingDocsLabel called with empty list');
  }
  const items = missing.map((k) => LABELS[k]);
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} y ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}
```

Função `detectMissingDocs(worker)` — definir baseado no schema real de `workers` (ver `WorkerRepository`). Casos:
- CV vazio → `'cv'`
- Antecedentes não enviados → `'antecedentes'`
- Monotributo não validado → `'monotributo'`

#### 3.2 Fluxo M1/M2/M3 — Captação

**Decisão pendente:** lista de prospects é mantida em Postgres ou ClickUp? (memória `project_clickup_source_of_truth`)

Opção recomendada: criar tabela `prospect_lists` (slug, worker_id, status, last_sent_at, template_slug_target) e cron que itera.

Reuso: `BulkDispatchScheduler` aceita slug parametrizado. Criar `BulkDispatchProspectUseCase` análogo a `BulkDispatchIncompleteWorkersUseCase` (`worker-functions/src/modules/notification/application/`).

Dedup: usar `worker_reminder_state` (`worker_id` + `template_slug` + `sent_date`). Sample com cap diário recomendado (ex: max 200 envios/dia por slug).

#### 3.3 Fluxo U1/U2/U3 — Cadastro incompleto

**Padrão de reuso direto** de `BulkDispatchTalentumIncompleteUseCase`. Diferenças:

| Item | `talentum_incomplete_reminder` (existe) | `ar_finalize_signup_*` (novo) |
|---|---|---|
| Critério de seleção | INITIATED/IN_PROGRESS > 5d | Workers AR com cadastro iniciado mas docs incompletos |
| Variantes | 1 slug | 3 slugs (rotação A/B/C semanal? ou por persona?) |
| Variável extra | — | `{{2}}` = `missingDocsLabel(detectMissingDocs(worker))` |

**Decisão pendente:** qual variante (U1, U2 ou U3) cada worker recebe? Sugestões:
- Rotação aleatória inicial pra A/B (10% U1, 10% U2, 80% U3 — Luz personalizado tende a converter mais)
- Após 30 dias, escolher a campeã e padronizar

Implementar como `BulkDispatchArSignupIncompleteUseCase` que:
1. Lê workers AR com `worker_documents` incompletos
2. Calcula `missingDocs` via helper
3. Escolhe variante (hash do `worker_id` % 3 → consistência por worker)
4. Resolve `templateSlug` e envia via `IMessagingService.sendWithContentSid()`
5. Marca em `worker_reminder_state`

Cron Cloud Scheduler:
```
ar-finalize-signup-cron
↓ HTTP POST /api/internal/bulk-dispatch/ar-signup-incomplete
↓ daily 10h ART (13h UTC)
```

#### 3.4 Fluxo U4/U5 — Match de vaga

**Trigger:** evento de domínio quando match é criado. Verificar onde isso acontece hoje — provavelmente em `worker-functions/src/modules/matching/` ou similar (commit `dbf16f8 feat(matching): convite automático pós-criação de vaga` indica que já existe).

Padrão: emitir evento `MatchCreated` no Outbox, e em `OutboxProcessor` adicionar handler que:
1. Carrega `worker` + `vacancy`
2. Verifica `worker.is_profile_complete` (ou equivalente)
3. Se completo → envia `ar_vacancy_match_complete` com `{ 1: firstName, 2: localityName, 3: vacancyUrl }`
4. Se incompleto → envia `ar_vacancy_match_incomplete` com `{ 1: firstName, 2: localityName, 3: missingDocsLabel(...), 4: vacancyUrl }`

Dedup: `worker_reminder_state` com `template_slug = 'ar_vacancy_match_*'`, `sent_date = today`, **+** uma chave que inclua `vacancy_id` (sem isso, worker que dá match em 2 vagas no mesmo dia só recebe 1). Sugestão: adicionar coluna nullable `context_id` em `worker_reminder_state` (próxima migration).

## 4. Checklist de execução

- [ ] **Etapa 1 — Twilio**
  - [ ] 8 Content templates criados (Console / CLI / MCP / curl)
  - [ ] 8 Approval requests submetidos
  - [ ] 8 status = `approved` confirmado (acompanhar via console ou `twilio api:content:v1:contents:approval-fetch`)
  - [ ] 8 `HX...` SIDs anotados em algum lugar acessível (ex: 1Password Enlite shared)
- [ ] **Etapa 2 — Migration**
  - [ ] Migration `NNN_add_ar_whatsapp_templates.sql` criada com SIDs reais
  - [ ] Rodada localmente (`run-migrations-docker.js`)
  - [ ] Rodada em staging
  - [ ] Rodada em produção
- [ ] **Etapa 3 — Backend**
  - [ ] `MissingDocsLabel.ts` criado + testado (unit)
  - [ ] `detectMissingDocs()` implementado no domain layer de worker
  - [ ] U1/U2/U3: `BulkDispatchArSignupIncompleteUseCase` criado
  - [ ] U1/U2/U3: rota interna `/api/internal/bulk-dispatch/ar-signup-incomplete`
  - [ ] U1/U2/U3: Cloud Scheduler configurado
  - [ ] U4/U5: handler de `MatchCreated` no `OutboxProcessor`
  - [ ] U4/U5: coluna `context_id` adicionada em `worker_reminder_state` (se confirmada a necessidade)
  - [ ] M1/M2/M3: decisão sobre lista de prospects feita
  - [ ] M1/M2/M3: trigger implementado (cron ou endpoint manual)
- [ ] **Etapa 4 — QA**
  - [ ] Smoke test (seção 5) executado em staging
  - [ ] Critérios de aceite (seção 6) validados
- [ ] **Etapa 5 — Documentação operacional**
  - [ ] Runbook em `docs/runbooks/RUNBOOK_AR_WHATSAPP_TEMPLATES.md` (como pausar/retomar, como verificar saúde, alertas)
  - [ ] Atualizar `docs/FEATURES.md`

## 5. Smoke test (staging)

Para cada um dos 8 templates:

1. Identificar 1 worker de teste em staging com número WhatsApp próprio.
2. Forçar disparo:
   - Templates M*: invocar manualmente o use case via endpoint interno
   - Templates U1/U2/U3: marcar worker com docs incompletos e rodar cron manualmente
   - Templates U4/U5: criar match no staging
3. Conferir:
   - WhatsApp recebido com texto correto e variáveis interpoladas
   - Botões CTA funcionam (M1/M2/M3)
   - Link `app.enlite.health` redireciona pro env correto
   - `worker_reminder_state` tem registro com `status='sent'`
4. Rodar cada disparo 2x — confirmar que o segundo é deduplicado (não envia).

## 6. Critérios de aceite

- [ ] Todos os 8 templates aprovados pelo Meta sem reclassificação inesperada (UTILITY → MARKETING). Se algum UTILITY for reclassificado, revisar texto.
- [ ] Tempo de envio < 5s do dispatch ao recebimento WhatsApp em 95% dos casos
- [ ] Dedup funciona: mesmo worker não recebe o mesmo template 2x no mesmo dia
- [ ] Logs Cloud Run sem erro nas primeiras 100 mensagens
- [ ] Cap diário respeitado (M1/M2/M3) — não estouras limite WhatsApp do business
- [ ] Política de re-disparo definida: quantos dias depois de um U1, pode mandar de novo?

## 7. Decisões pendentes (precisa do PO / Ops)

| # | Pergunta | Bloqueia? |
|---|---|---|
| 1 | M1/M2/M3: lista de prospects mora em Postgres ou ClickUp? | Sim (Etapa 3.2) |
| 2 | U1/U2/U3: rotação A/B fixa ou variante única? | Não (default: hash do worker_id % 3) |
| 3 | U4/U5: precisa cap por worker (ex: max 1 match por dia)? | Sim (Etapa 3.4 — dedup) |
| 4 | Quem aprova mudança em texto dos templates depois? Marketing? Operações? | Não (mas formaliza pro futuro) |
| 5 | Política de re-disparo (cooldown depois do primeiro lembrete) | Não (default: 3 dias) |

## 8. Referências

### Arquivos do projeto
- Módulo notification: `worker-functions/src/modules/notification/`
- Twilio service: `worker-functions/src/modules/notification/infrastructure/TwilioMessagingService.ts` (linhas 56-67 = Content API, linhas 136-153 = `mapToContentVariables`)
- Bulk dispatch scheduler: `worker-functions/src/modules/notification/infrastructure/BulkDispatchScheduler.ts`
- Use cases similares: `BulkDispatchIncompleteWorkersUseCase`, `BulkDispatchTalentumIncompleteUseCase`
- Migrations templates: 059, 063, 095, 099, 108, 123, 125, 127, 174, 175
- Migration `worker_reminder_state`: 176

### Externas
- Twilio Content API: https://www.twilio.com/docs/content
- Twilio Content Template Builder: https://www.twilio.com/docs/content/create-templates-with-the-content-template-builder
- Twilio CLI: https://www.twilio.com/docs/twilio-cli/quickstart
- Twilio MCP Server (Alpha): https://twilioalpha.com/mcp
- Meta template categorization: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization

### Sprint relacionada
- `docs/SPRINT_NOTIFICATION_EXTRACTION.md` — refactor do módulo notification (precondição para este sprint, já implementada — commit 092847b, c21a805, 72dc85a, dbf16f8)
- `docs/SPRINT_RECRUITMENT_AUTOMATION.md` — automação de recrutamento (contexto maior)

## 9. Lições aprendidas (2026-05-20)

Registradas pra próximas sprints que envolvem submissão de templates pro Meta.

### Regras Meta que **não estavam óbvias** na pesquisa inicial

1. **Botões CTA não podem linkar pra `chat.whatsapp.com/...` nem `wa.me/...`** — Meta rejeita com `subCode=2388081` ("Direct links to WhatsApp aren't allowed for buttons"). Esses links **podem ficar no corpo da mensagem**, só não em botão.
2. **Variáveis não podem ficar no fim** do template — Meta rejeita com `subCode=2388299` ("Variables can't be at the start or end of the template"). Sempre ter texto literal depois da última variável (ex: ".", "Si tenés dudas, escribime."). Variáveis no início (`¡Hola {{1}}!`) parecem OK na prática (todos templates assim foram aprovados).
3. **Templates muito similares entre si geram rejeição como duplicados**, mesmo que não literalmente idênticos. `ar_finalize_signup_brief` (texto curto) foi rejeitado por similaridade com `ar_finalize_signup_direct` (texto longo) — abertura `¡Hola {{1}}! Tu registro...`, mesma URL `app.enlite.health`, mesmo fechamento `Estamos para ayudarte` foi o suficiente. Resolução: reescrever com **tom estruturalmente diferente** (notificação sistêmica formal vs carta amigável) e renomear o slug.
4. **`allow_category_change=true` funciona** — Meta reclassifica em vez de rejeitar quando acha que UTILITY na verdade é MARKETING. U4 foi submetido como UTILITY e aprovado como MARKETING automaticamente. Mas a regra **não cobre todos os casos**: U2 foi submetido como UTILITY e rejeitado com `INCORRECT_CATEGORY` em vez de auto-reclassificar. Comportamento opaco.
5. **MARKETING é muito mais permissivo que UTILITY** na avaliação automática do Meta. Estratégia recomendada para reduzir risco de rejeição: submeter como MARKETING quando dúvida (trade-off: cobra por message como marketing).
6. **Friendly_name pode ser reutilizado** após rejeição (sem esperar 30 dias) — esse cooldown só vale pra templates approved/deleted, não pros rejeitados.
7. **"Unknown rejection reason"** é genérico e geralmente significa **duplicidade de conteúdo** com outro template aprovado da mesma conta.

### Estratégia recomendada de submissão

Antes de criar um novo template:
- [ ] Checar se a copy é **estruturalmente diferente** de outros templates da conta (não só palavra-por-palavra)
- [ ] Garantir variáveis **não estão no início ou fim** do body
- [ ] Botões CTA **não apontam pra WhatsApp** (`chat.whatsapp.com`, `wa.me`)
- [ ] Headers (se usar) **não têm emoji ou formatação**
- [ ] Submeter com `allow_category_change=true`
- [ ] Quando em dúvida: submeter como MARKETING

### Histórico de iterações desta sprint

1. **Primeira leva (8 templates):** 3 aprovados, 5 rejeitados.
   - M1/M2/M3 rejeitados por botão `chat.whatsapp.com` em CTA → fix: trocar botão por `Acceder a EnLite`, link de comunidade pro body.
   - U2 rejeitado como `INCORRECT_CATEGORY` → estratégia: submeter como MARKETING.
   - U5 rejeitado por `{{4}}` no fim → fix: adicionar "Si tenés dudas, estoy del otro lado." depois.
2. **Segunda leva (5 retentativas):** 4 aprovados, 1 rejeitado (U2 "Unknown reason").
   - U2 rejeitado por similaridade com U1 → fix: reescrever com tom notificação sistêmica + renomear slug pra `ar_signup_pending_reminder`.
3. **Terceira leva (1 retentativa U2 + conversão U5 pra MARKETING):** 2 pending, 6 já approved.

Resultado final: 8 templates entregues, todos viáveis. Tempo total da iteração: ~3h.
