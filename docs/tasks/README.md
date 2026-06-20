# Tarefas refinadas — Board ClickUp "APP Recrutamento"

Refinamento + **decisões travadas** das tarefas em status **Open** do board
[APP Recrutamento](https://app.clickup.com/9013274709/v/li/901327603662) (folder MVP EnLite, space Technology).
Os tickets no ClickUp **não têm descrição** — cada doc foi reconstruído do título + investigação do código com evidência
(file:line + greps), e todas as decisões de produto foram fechadas com o Gabriel em 2026-06-19.

**Estado: pronto para execução paralela.** Nenhuma tarefa tem perguntas em aberto que bloqueiem o dev
(exceções: 1 decisão pendente sobre a baja da Ana Care e dependências externas de go-live — ver seções próprias).

## Índice

| # | Doc | ClickUp | Prontidão |
|---|-----|---------|-----------|
| 1 | [Coluna Status de Documentos (Match)](01-match-coluna-status-documentos.md) | [86aj3yufg](https://app.clickup.com/t/86aj3yufg) | ✅ **Já em `main`** (504c6f4) — só verificar e fechar |
| 2 | [Modal de perfil do prestador (Match)](02-match-modal-perfil-prestador.md) | [86aj3yufn](https://app.clickup.com/t/86aj3yufn) | 🟢 Pronta |
| 3 | [Desabilitar prestador (Super Admin)](03-superadmin-desabilitar-prestador.md) | [86aj3yufq](https://app.clickup.com/t/86aj3yufq) | 🟢 Pronta |
| 4 | [Eventos de contato AT×Vaga](04-eventos-contato-at-vaga.md) | [86aj3yug2](https://app.clickup.com/t/86aj3yug2) | 🟢 Pronta |
| 5 | [Merge de perfis duplicados](05-merge-perfis-duplicados.md) | [86aj3yufw](https://app.clickup.com/t/86aj3yufw) | 🟢 Pronta |
| 6 | [Integração HubSpot (espelho)](06-integracao-hubspot.md) | [86aj3yvcd](https://app.clickup.com/t/86aj3yvcd) | 🟢 Pronta |
| 7 | [Integração Ana Care (espelho)](07-integracao-ana-care.md) | [86aj3yvdx](https://app.clickup.com/t/86aj3yvdx) | 🟡 Pronta exceto **baixa** (sem endpoint na API deles) |
| 8 | [Rotinas de Agendas de Enquadre](08-rotinas-agendas-enquadre.md) | [86aj3yva8](https://app.clickup.com/t/86aj3yva8) | 🟢 Pronta |

> Subtasks #1-#4 pertencem ao pai [Ajustes na Lista de Match das Vacantes](https://app.clickup.com/t/86aj3yuaj) (*in review*).
> [86aj4fanx](https://app.clickup.com/t/86aj4fanx) ("Estoy probando…") é teste de gravação de tela — **descartada**.

---

## Decisões travadas (2026-06-19, Gabriel)

- **#2 Modal:** mantém clique no nome navegando + ícone "ver perfil" que abre modal; reusa `WorkerDetailContent` inteiro; fecha por backdrop/ESC; atom `Modal` genérico = follow-up TD. **+ checkbox "Conta de teste" admin-only** no perfil (toggle `is_test`, gate `role === ADMIN`).
- **#3 Desabilitar:** `workers.status='DISABLED'` (soft, nunca hard delete); reversível pelo Super Admin; gate = **allowlist tática** (gabriel.stein + diego.trevisan) até ABAC; desabilitado **some** da Lista de Match (incl. lista salva do `VacancyMatchController`); coluna aditiva `disabled_reason`.
- **#4 Eventos:** backend + **UI no Match** (timeline); **sem tabela nova**; tipos MVP = WHATSAPP + FUNNEL_STAGE + CONTACT_NOTE; sem registro manual no v1; endpoint **WJA-scoped**.
- **#5 Merge:** sobrevivente = login Firebase real → senão o mais completo → senão **relatório de exceções** (Excel humano); modo **híbrido** (auto só phone-normalizado+CUIT igual); docs/CUIT/document **nunca** auto-sobrescritos; prevenção = normalizar phone no `create` + coluna `phone_normalized`; **reparentar as ~17 FKs** (hoje só 3); auditoria `worker_merge_audit`.
- **#6 HubSpot + #7 Ana Care = ESPELHO contínuo da base** (decisão revista 2026-06-19):
  - **Entrada (alta/create):** assim que o worker tiver os campos mínimos — Ana Care exige `nombre+apellidos+genero+email`; HubSpot exige só `nome+email`. Espelho precoce, "à medida que completam o cadastro".
  - **Atualização:** a **cada mudança relevante** do perfil (não só contato) → PATCH/upsert idempotente por `ana_care_id` / `worker_crm_links.external_id`.
  - **Baixa (espelho completo):** disable (#3) e merge do duplicado (#5) → baja/archive. HubSpot = property `enlite_status='DISABLED'` + archive (`DELETE`, recuperável ~90d). Ana Care = **workaround via PATCH** (sem DELETE/campo de status): candidato = valor dedicado "Baja"/"Inactivo" no catálogo `hiring-types` → set `tipo_contratacion` — **condicionado à confirmação do Javier**. Evento de baja é capturado no outbox e reprocessado quando a convenção for definida (no-op logado até lá).
  - **Backfill:** carga inicial `created_at >= 2026-04-01` + filtros anti-lixo, **após** a dedup (#5).
  - **Gatilho:** via outbox a cada write elegível de worker (mecanismo exato a ser unificado pelo architect no kickoff — ver nota).
- **#8 Enquadre:** v1 = **lembretes** (24h/5min via Cloud Scheduler, lendo de WJA) **+ transição no no-show** (`interview_response: pending→no_response`, `funnel_stage: CONFIRMED→IN_DOUBT`); fora: auto-slot, evento no Calendar.

### Predicado de elegibilidade do espelho (anti-lixo)

```sql
-- HubSpot (mais permissivo — só precisa de nome+email):
WHERE created_at >= '2026-04-01'            -- cutoff (só no backfill)
  AND merged_into_id IS NULL                -- não é duplicado absorvido
  AND status <> 'DISABLED'
  AND first_name_encrypted IS NOT NULL AND email IS NOT NULL
  AND is_test = false                       -- gate primário (workers.is_test, mig 221 da #5)
  AND email NOT LIKE '%@enlite.import' AND email NOT ILIKE '%+test%@%'  -- rede de segurança p/ históricos
  AND email NOT IN (/* TEST_EMAILS allowlist em config */)

-- Ana Care (mais estrito — precisa dos 4 obrigatórios + genero mapeável p/ M|H):
--   idem acima + nombre/apellidos/genero não-vazios (validado no app pós-KMS-decrypt)
```
> **`workers.is_test`** (coluna aditiva, mig 221 na #5) é o gate primário anti-lixo, alimentado por um **checkbox admin-only** no perfil (#2, endpoint `PATCH /api/admin/workers/:id/test-flag`, gate `role === ADMIN`). A heurística de email fica como rede pra registros históricos ainda não marcados.

---

## Plano de execução paralela — 4 worktrees

| Track | Worktree | Tarefas (ordem interna) | Isolamento |
|---|---|---|---|
| **A — Match UI** | `wt-match` | #2 → #3 → #4 | os 3 tocam os mesmos arquivos da tela de Match |
| **B — Integrações** | `wt-integrations` | fundação (gatilho+outbox+provider framework) → #6 → #7 | mesmo módulo `integration/` + secrets; **backfill espera Track C** |
| **C — Dedup** | `wt-dedup` | #5 (prevenção primeiro) | toca `WorkerRepository` isolado |
| **D — Enquadre** | `wt-enquadre` | #8 | módulo notification isolado |

**Dependência de sequência:** o **espelho contínuo** (novos/alterados) do Track B pode ligar a qualquer momento (filtra `merged_into_id IS NULL`); mas o **backfill histórico** do Track B só roda **depois** da dedup (#5, Track C) — senão sobe duplicado.

**Nota do architect (decidir no kickoff do Track B):** unificar o mecanismo de gatilho do espelho — recomendação: **trigger Postgres `AFTER INSERT/UPDATE ON workers` → tabela outbox dedicada `crm_sync_outbox` → processor despacha p/ HubSpot e Ana Care**. Garante que nenhuma mudança escape (incl. imports e merge), sem instrumentar cada use case e sem sobrecarregar o `messaging_outbox` (que é de WhatsApp).

**Zonas de conflito:** Match (`MatchCandidateRow.tsx`/`VacancyMatchPage.tsx`/`VacancyMatchController.ts`) → só Track A · `integration/`+`secrets.tf` → só Track B · `WorkerRepository.ts` → só Track C.

**Reserva de migrations** (max atual = `215`): #8=`216` · #3=`217` · #5=`218-221` (`218` phone_normalized · `219` phone_backfill · `220` worker_merge_audit · `221` is_test) · #6=`222` (worker_crm_links+trigger) · #7=`223` (ana_care idx+synced_at).

---

## Bloqueios e dependências externas

- 🟡 **#7 Ana Care — baixa via workaround PATCH (pendente de confirmação do Javier).** A spec v2 não tem DELETE nem campo de status. Decidido: baja por convenção via PATCH (valor "Baja" no catálogo `hiring-types` → `tipo_contratacion`). **Pergunta formal pro Javier:** "qual convenção usar — (a) valor dedicado em `hiring-types`/`nurse-types`, (b) campo de estado `activo:false` no PATCH, ou (c) baja é manual do lado de vocês? E qual o limite de itens por `bulk`?" O evento de baja já é capturado no outbox e reprocessado quando a convenção for definida. Não bloqueia create/update.
- **#6 HubSpot:** Private App token → secret `hubspot-api-token` (nome idêntico prd/stg) + custom properties (`enlite_profession`, `enlite_status`); desativar nó HubSpot do n8n legado no go-live.
- **#7 Ana Care:** API key (`X-Agency-Key`) + host base + limite de itens por bulk, da Ana Care; secret `ana-care-api-key` em prd e stg.
- **#3 Super Admin:** confirmar membros da allowlist (gabriel.stein + diego.trevisan).

## Gates de qualidade (todos os tracks)

lint + type-check + E2E verdes (inclusive pré-existentes); arquivos ≤400 linhas; sem `any`;
enums UPPERCASE EN no backend e via i18n no JSX; **teste visual Playwright `toHaveScreenshot()`** obrigatório em mudança de tela.
