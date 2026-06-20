# Task: Desabilitar perfil de prestador (Super Admin)
**ClickUp:** https://app.clickup.com/t/86aj3yufq · **Status:** Open→Refinada · **Board:** APP Recrutamento

> Subtask de "Ajustes na Lista de Match das Vacantes" (`86aj3yuaj`). Ticket criado 2026-06-17, **sem descrição** e sem assignee. Este doc é o refinamento PO+Architect; **não** implementa código de feature.

---

## 1. Contexto (a armadilha: "sem edição é proposital")

Hoje a plataforma **não tem edição nem exclusão de perfil de prestador pelos operadores, e isso é uma decisão de produto, não uma lacuna**.

Evidência:
- `worker-management.md` lista endpoints admin de worker: há `PUT /api/admin/workers/:id/status`, `PUT .../occupation`, `PUT .../documents/review` — mas **nenhum** endpoint de "editar perfil" ou "deletar worker". A doc confirma: status válidos são `REGISTERED`, `INCOMPLETE_REGISTER`, `DISABLED` (worker-management.md l.145).
- Memória `project_no_worker_edit_intentional` (user, 2026-06-15): _"a app não tem edição de perfil de prestador pelos operadores DE PROPÓSITO... a fricção de não-edição é intencional pra gerar [o] contato"_ com o worker (ex.: classificar `profession`, 68% NULL — `project_worker_profession_null_bug`).
- `docs/FOLLOWUPS.md` l.530: _"Edição de profissão, quando existir, fica em **nível alto (Super Admin)**"_.

**Esta tarefa abre a primeira exceção a essa regra**: operação irreversível (desabilitar prestador) reservada a um nível alto — Super Admin. O destaque de produto é: a exceção **não** reintroduz edição ampla; é uma única ação destrutiva gated.

RBAC hoje é trivial: authz libera todos os staff. ABAC/Cerbos está em discovery e standby (`project_cerbos_not_in_use`, `permissions/01-requirements-and-decisions.md`). "Super Admin" será **grupo de sistema** no alvo (não novo role no enum), mas nesta task o gate é uma **allowlist tática** (seed/config com `gabriel.stein` + `diego.trevisan`) — o grupo real fica pra Fase ABAC (decisões travadas §9 D-3).

---

## 2. Objetivo

Permitir que um Super Admin **desabilite** (soft-disable) o perfil de um prestador, retirando-o do fluxo operacional (match, novas postulações), **sem apagar dados** (PII e histórico preservados; migrações aditivas). "Excluir (desabilitar)" no ticket = **desativar**, não hard delete.

---

## 3. Escopo

### Dentro
- Ação de desabilitar prestador (`status='DISABLED'`, SOFT — D-1) disparável a partir da **Lista de Match** (`VacancyMatchPage`) — contexto da subtask pai.
- Gate de autorização **Super Admin** sobre essa ação, via **allowlist tática** (guard `requireSuperAdmin` lendo seed/config com `gabriel.stein` + `diego.trevisan` — D-3). Backend + UI.
- **Adicionar filtro de DISABLED na Lista de Match SALVA** (`VacancyMatchController`) — hoje ela NÃO filtra (evidência §4.4, D-4). Prestador desabilitado deve **sumir** dessa lista.
- **Migration mínima aditiva**: coluna `workers.disabled_reason` (nullable) p/ registrar o motivo na desabilitação (D-5).
- Soft-disable **reversível** pelo Super Admin (re-habilitar recalcula status conforme campos, como o handler atual já faz — D-2).

### Fora
- Edição ampla de campos do perfil do worker pelo operador (continua proibida — §1).
- **Hard delete / remoção física via `deleted_at`** e purga de PII por DSAR/LGPD (fluxo distinto, não é "desabilitar"; `deleted_at` fica reservado p/ isso — D-1).
- Implementar o motor ABAC/Cerbos completo e o **grupo de sistema real (`user_groups` + membership por UI)** — fica pra Fase ABAC. Esta task entra com a allowlist tática (D-3).
- **WJA / encuadres**: nada muda neles — permanecem como histórico (D-6).
- App do worker (fora do escopo de permissões por sign-off do Gabriel — `permissions/01` l.99).

---

## 4. Estado atual do código — EVIDÊNCIA

### 4.1 Já existe coluna de soft-delete? → **SIM, duas camadas**
- **Enum de status com `DISABLED`**: `migrations/096_refactor_worker_status.sql` define `CHECK (status IN ('REGISTERED','INCOMPLETE_REGISTER','DISABLED'))`; comentário: `DISABLED = desativado`. Tipo no domínio: `worker-functions/src/modules/worker/domain/Worker.ts:50` → `type WorkerStatus = 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED'`.
- **Coluna `deleted_at` (soft-delete clássico)**: `migrations/005_add_soft_delete.sql:9` → `ALTER TABLE workers ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE`; índice parcial l.10; funções `soft_delete_user`/`restore_user` (l.26, l.46) e view `active_workers` (l.22) `WHERE deleted_at IS NULL`.

→ **Não é preciso criar coluna nova.** Há dois eixos: `status='DISABLED'` (estado de negócio, com histórico via trigger) e `deleted_at` (soft-delete físico). Ver decisão pendente DP-1 em §9.

### 4.2 Já existe endpoint de desabilitar / mudar status? → **SIM**
- `PUT /api/workers/:id/status` → `workerEncuadreRoutes.ts:22` → `EncuadreController.updateWorkerStatus`.
- Handler (`EncuadreController.ts:277-294`) **já aceita `DISABLED`**: valida `['REGISTERED','INCOMPLETE_REGISTER','DISABLED']`, e para qualquer valor ≠ REGISTERED roda `UPDATE workers SET status=$2` dentro de transação com `set_config('app.current_uid', ...)` → dispara o trigger de histórico `trg_worker_status_history` (migration 096 STEP 7), gravando em `worker_status_history`.
- **Não há guard de Super Admin**: a rota usa só `auth` (= `requireStaff`, qualquer staff). `grep super_admin` no backend retorna **NADA** funcional além de um comentário em `CerbosAuthorizationAdapter.ts:248`. Não há endpoint de hard-delete de worker (`grep "DELETE.*workers/:id"` → nada; só `DELETE /api/workers/me/documents/:type`).

### 4.3 Onde "Super Admin" está definido? → **decisão tomada, código ainda NÃO existe**
- **Backend enum** `EnliteRole` (`src/modules/identity/domain/EnliteRole.ts`): só `admin`, `recruiter`, `community_manager`. **Não há `super_admin`** — por design (D-P1).
- **Frontend**: `grep -rniE "super.?admin"` em `enlite-frontend/src/` → **NADA ENCONTRADO**.
- **Decisão de produto já assinada** (`permissions/01-requirements-and-decisions.md` D-P1 + sign-off l.100): Super Admin = **grupo de sistema** `"Super Admin"` (tabela `user_groups`), **não** novo role no enum. Membros iniciais: `gabriel.stein@enlite.health`, `diego.trevisan@enlite.health`. Requisito: add/remover membro tem que ser fácil via UI, **nunca hardcoded**.
- ⚠️ O grupo de sistema e a tabela `user_groups` ainda **não foram implementados** (são entregáveis da Fase ABAC, em discovery). Isto é a dependência dura desta task — ver §10.

### 4.4 Efeitos colaterais de desabilitar — o que JÁ acontece vs o que FALTA
- **Match automático (gerar candidatos)** — JÁ EXCLUI: `MatchmakingService.ts:255-258` filtra `WHERE w.merged_into_id IS NULL AND w.status = ANY($8) AND w.deleted_at IS NULL`, com `$8 = ['REGISTERED']` (ou `+INCOMPLETE_REGISTER` se incluir incompletos). DISABLED nunca entra; `deleted_at` também filtrado.
- **Novas postulações** — JÁ BLOQUEIA: `WorkerApplicationEligibility.ts:38-39` lança `WorkerNotEligibleError(reason='worker_disabled')` quando `status='DISABLED'`. Motivo canônico registrado em `migrations/209_worker_blocked_applications.sql:9,37` (`worker_disabled`).
- **Lista de Match SALVA (a tela desta subtask)** — ⚠️ **NÃO FILTRA**: `VacancyMatchController.ts` (query l.~70-105) lê `FROM worker_job_applications wja JOIN workers w` e seleciona `w.status` (l.76), mas **não tem `WHERE w.status != 'DISABLED'` nem `w.deleted_at IS NULL` nem `w.merged_into_id IS NULL`**. Um prestador desabilitado que já tinha WJA **continua aparecendo** na lista de match dessa vaga. → trabalho real desta task.
- **Lista admin de workers** (`AdminWorkersController.ts`): filtra `WHERE w.merged_into_id IS NULL` (l.129) mas **seleciona** `w.deleted_at` (l.18) sem filtrá-lo no WHERE. DISABLED aparece (é um filtro de status, não exclusão). Comportamento ok p/ admin, mas confirmar se Lista de Match deve esconder ou só marcar (DP-3).
- **WorkerApplicationRepository / WJAFunnel**: filtram `jp.deleted_at` (job posting), não o worker. Confirmar Kanban/funil (DP-4).

---

## 5. Mudanças propostas

| # | Camada | Mudança | Reuso vs Criação |
|---|---|---|---|
| 1 | DB — migration | **Migration mínima aditiva** (D-5): `ALTER TABLE workers ADD COLUMN disabled_reason TEXT` (nullable). Enum/`status='DISABLED'` já existem (096); `deleted_at` (005) **não é tocado** (D-1). Nunca drop. | Criação mínima (1 coluna) |
| 2 | Backend — guard | Novo guard `requireSuperAdmin()` (allowlist tática — D-3): checa o usuário contra allowlist em **seed/config** (`gabriel.stein` + `diego.trevisan`). Desenhar pra trocar a fonte (seed → `user_groups`) sem refazer call sites. **NÃO** implementar `user_groups`/membership por UI (Fase ABAC). | Criação (guard) |
| 3 | Backend — endpoint | **Restringir `PUT /api/workers/:id/status`** com `requireSuperAdmin` (hoje é só `requireStaff` — §4.2). O handler já aceita `DISABLED` e re-habilita recalculando status (D-2); passar a setar `disabled_reason` ao desabilitar e limpá-lo ao re-habilitar. Endpoint dedicado `disable/enable` é opcional — o requisito é o **gate** e o **reason**, não afrouxar o status genérico. | Edição (reusa handler) |
| 4 | Backend — match list | Adicionar `WHERE w.status != 'DISABLED' AND w.merged_into_id IS NULL` na query de `VacancyMatchController` para que o prestador desabilitado **suma** da Lista de Match SALVA (D-4). | Edição cirúrgica |
| 5 | Frontend — UI | Ação "Desabilitar prestador" no `MatchCandidateRow` (`MatchCandidateRow.tsx`), visível só p/ Super Admin (PermissionGate plugável — `permissions/01` l.102). Modal de confirmação obrigatório + campo de **motivo** (→ `disabled_reason`). Ação inversa "Re-habilitar" também gated. i18n no rótulo de status (`project_enum_i18n_frontend`). | Edição |

---

## 6. Schema / migrations

**Uma única migration, mínima e aditiva** (D-5):

```sql
ALTER TABLE workers ADD COLUMN disabled_reason TEXT;  -- nullable, nunca NOT NULL, nunca drop
```

- Mecanismo de desabilitar é `status='DISABLED'` (CHECK já existe em 096 — D-1). O `UPDATE` é auditado pelo trigger `trg_worker_status_history` → `worker_status_history(worker_id, field_name='status', old_value, new_value, changed_by=app.current_uid)`. **Quem** desabilitou já é capturado por `changed_by`; `disabled_reason` captura **por que**.
- `workers.deleted_at` (005) **não é tocado** — reservado p/ remoção física futura (LGPD), fora de escopo (D-1).
- Seguir o runner idempotente (`schema_migrations`) e o prefixo numérico sequencial (próximo número livre em `worker-functions/migrations/`).

---

## 7. Critérios de aceite

1. Super Admin (membro da allowlist tática — D-3) consegue desabilitar um prestador a partir da Lista de Match; staff não-Super-Admin **não vê** a ação e recebe **403** se chamar `PUT /api/workers/:id/status` direto (guard `requireSuperAdmin`).
2. Prestador desabilitado **deixa de aparecer** na Lista de Match SALVA da vaga (`VacancyMatchController`) — D-4. Hoje aparece sem filtro (evidência §4.4); o filtro é parte do escopo.
3. Prestador desabilitado **não** é gerado por novo match (já garantido — `MatchmakingService`) e **não** consegue postular (já garantido — `WorkerApplicationEligibility` → `worker_disabled`). Teste de não-regressão desses dois.
4. **PII e histórico preservados**: nenhum dado apagado; `deleted_at` intocado; WJA/encuadres intactos (D-6); `worker_status_history` registra `changed_by` = uid do Super Admin; `workers.disabled_reason` registra o motivo informado (D-5).
5. Ação **reversível** pelo Super Admin: re-habilitar volta o worker a `REGISTERED`/`INCOMPLETE_REGISTER` recalculando status conforme campos (handler atual — D-2) e **limpa** `disabled_reason`.
6. **Screenshot Playwright (`toHaveScreenshot()`) obrigatório** da Lista de Match: (a) com a ação visível p/ Super Admin, (b) estado pós-desabilitar (sumiço do prestador). Teste sem validação visual = incompleto (CLAUDE.md / `feedback_visual_tests_required`).
7. E2E real (navegador→banco) com conta de teste, não mock (`feedback_guarantee_means_full_real_e2e`).

---

## 8. Riscos & armadilhas

- **PII / LGPD**: desabilitar ≠ esquecer. Os dados do prestador continuam no banco (correto p/ "desabilitar"; mas não atende a um pedido de exclusão LGPD — escopo distinto, deixar claro p/ ops).
- **Sumiço de dados de match**: filtrar DISABLED da Lista de Match pode "esconder" candidatos que ops esperava ver; alinhar com DP-3 (esconder vs marcar). WJAs/encuadres do prestador **permanecem** (histórico), só a visibilidade/seleção muda.
- **RBAC ainda trivial**: hoje authz libera todos os staff; o grupo "Super Admin" **não existe em código**. Sem ele, o gate seria hardcoded — **proibido** pelo sign-off (`permissions/01` l.100). Esta task **depende** de o mínimo de `user_groups`/grupo "Super Admin" existir, ou de um MVP explicitamente aprovado.
- **Reuso indevido do endpoint genérico**: o `PUT /workers/:id/status` atual é `requireStaff` — se for reusado sem novo guard, **qualquer staff** poderia setar DISABLED, furando a regra de "só Super Admin". Não afrouxar.
- **Trigger de histórico depende de `app.current_uid`**: o caminho que desabilita precisa setar `set_config('app.current_uid', uid)` (como `runWorkerUpdate` já faz) senão `changed_by` fica nulo e perde-se a auditoria de quem desabilitou.

---

## 9. Decisões TRAVADAS (2026-06-19, Gabriel)

Todas as decisões abaixo estão **fechadas**. Esta task está **pronta para dev** — não há pergunta em aberto. (Substituem os antigos DP-1..DP-6.)

- **D-1 · Mecanismo = `status='DISABLED'` (SOFT, nunca hard delete).**
  A desabilitação é um `UPDATE workers SET status='DISABLED'`, auditado pelo trigger `trg_worker_status_history`. **`deleted_at` fica reservado p/ remoção física futura (LGPD) e está FORA de escopo** — esta task não toca `deleted_at`. PII e histórico preservados.
- **D-2 · Reversível pelo Super Admin.** Re-habilitar é a operação inversa: volta o worker para `REGISTERED`/`INCOMPLETE_REGISTER` e **o handler atual já recalcula o status conforme os campos** (mesmo caminho do `updateWorkerStatus`). Nada novo de cálculo de status é necessário — só expor a ação inversa gated.
- **D-3 · Gate Super Admin = ALLOWLIST TÁTICA AGORA.** Implementar o **mínimo**: um guard (`requireSuperAdmin`) que checa o usuário contra uma **allowlist em seed/config** com `gabriel.stein` + `diego.trevisan`. O grupo de sistema real (`user_groups` + membership gerenciável por UI) **fica para a Fase ABAC** — esta task NÃO o implementa. O guard deve ser desenhado pra trocar a fonte da allowlist (seed → `user_groups`) sem refazer os call sites.
- **D-4 · Visibilidade = prestador desabilitado SOME da Lista de Match.**
  IMPORTANTE: a **Lista de Match SALVA** (`VacancyMatchController`) hoje **NÃO filtra DISABLED** (evidência §4.4) — **adicionar esse filtro é parte do escopo desta task**. Match automático e eligibility de postulação já filtram (não regredir).
- **D-5 · Motivo da desabilitação = coluna aditiva `disabled_reason`.**
  Adicionar via **migration mínima e aditiva** (coluna nullable em `workers`), para registrar o motivo na desabilitação (auditoria). Nunca drop. Único motivo de migration nesta task.
- **D-6 · WJA / encuadres existentes = histórico intocado.** Postulações e encuadres do prestador **permanecem como estão** — nada muda neles. A única mutação de dados é `workers.status` (+ `workers.disabled_reason`). A mudança é apenas de visibilidade/seleção na Lista de Match.

---

## 10. Estimativa & dependências

**Sem dependência dura.** O grupo de sistema real (`user_groups` + membership por UI) **não** bloqueia mais esta task: D-3 trava uma **allowlist tática** (seed/config) como gate AGORA, com o guard desenhado pra trocar a fonte depois sem refazer call sites. A Fase ABAC migra a fonte da allowlist no futuro — não é pré-requisito.

**Esforço:**
- Backend: guard `requireSuperAdmin` (allowlist) + restringir `PUT /api/workers/:id/status` + filtro na query de Match + migration `disabled_reason` + E2E → **~M** (a maior parte da lógica de efeito já existe; o trabalho é o guard, a Lista de Match e o reason).
- Frontend: ação no `MatchCandidateRow` + modal de confirmação com motivo + PermissionGate + Playwright com screenshot → **~S/M**.

**Status: pronta para dev.** Sem decisões em aberto (§9 travado). Sequência sugerida: migration → guard → endpoint restrito + reason → filtro Match → UI → E2E.
