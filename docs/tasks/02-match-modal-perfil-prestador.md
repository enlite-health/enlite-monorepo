# Task: Modal de perfil do prestador na Lista de Match

**ClickUp:** https://app.clickup.com/t/86aj3yufn · **Status:** Open→Refinada · **Board:** APP Recrutamento

> Subtask de "Ajustes na Lista de Match das Vacantes" ([86aj3yuaj](https://app.clickup.com/t/86aj3yuaj)). Ticket original **sem descrição** — escopo abaixo é inferido do título + investigação de código.

---

## 1. Contexto

A **Lista de Match das Vacantes** (`/admin/vacancies/:id/match`) ranqueia workers (ATs/prestadores) por compatibilidade com uma vaga e lista cada candidato numa linha de tabela (nome, status, docs, ocupação, zona, casos, score). Hoje, para consultar o perfil de um candidato, o recrutador clica no nome e é **navegado para fora da lista** (`/admin/workers/:id`), perdendo a seleção em curso e o contexto de match.

O ticket pede um **link que abra um modal com o perfil do prestador para consulta rápida** — ou seja, ver o perfil **sem sair da Lista de Match**.

Evidência do comportamento atual (navegação que sai da página):
- `enlite-frontend/src/presentation/components/features/admin/VacancyMatch/MatchCandidateRow.tsx:44-49` — `handleWorkerClick()` faz `navigate('/admin/workers/${candidate.workerId}', { state: { from: ... } })`.
- `MatchCandidateRow.tsx:85-95` — o nome do candidato é um `<button data-testid="match-worker-link">` que chama esse navigate.

---

## 2. Objetivo

Permitir que o recrutador abra o **perfil completo do prestador num modal sobreposto à Lista de Match**, para consulta rápida, sem navegação de rota e sem perder a seleção/filtro atual da lista.

---

## 3. Escopo

### Dentro
- **MANTER o clique no nome** navegando para `/admin/workers/:id` (comportamento atual, `MatchCandidateRow.tsx:44-49,85-95`) **E adicionar** um ícone/link "ver perfil" na **coluna de ações** (`MatchCandidateRow.tsx:137-160`) que abre o **modal de perfil** do worker (decisão TRAVADA §9.1, opção b).
- Criar componente `WorkerProfileModal` (overlay) que carrega o perfil via `getWorkerById(workerId)` e renderiza o conteúdo de perfil existente. **Fecha por backdrop-click + ESC** (decisão TRAVADA §9.3).
- Extrair o **`WorkerDetailContent` INTEIRO** (miolo completo da `WorkerDetailPage`, sem versão enxuta) para um componente reusável consumido tanto pela página quanto pelo modal (**fix-once**, decisão TRAVADA §9.4).
- **Checkbox admin-only "Conta de teste"** no `WorkerDetailContent` (logo aparece na página E no modal, já que ambos reusam o mesmo conteúdo — fix-once). Marca/desmarca `workers.is_test` (coluna criada na **#5**, migration 221). **Visível APENAS para admin** (`adminProfile?.role === EnliteRole.ADMIN`) — escondido de recruiter/community_manager (decisão TRAVADA §9.6). Toggle persiste via novo endpoint backend gated por admin (§5, §9.6). É a única **exceção** ao "read-only" do modal — escrita pontual de uma flag operacional, não edição de perfil.
- i18n das novas labels (es-AR principal + pt-BR), via chaves `admin.match.*` / `admin.workerProfile.*`.
- Teste E2E com **screenshot assertion** do modal aberto (obrigatório por CLAUDE.md).
- Logar a extração do atom `Modal` genérico como **follow-up TD** em `docs/FOLLOWUPS.md` (decisão TRAVADA §9.2 — apenas mencionar; o TD não é criado por esta task).

### Fora
- Edição de worker no modal (não existe edição de worker — é proposital; ver memória `project_no_worker_edit_intentional`). Modal é **read-only**, com **uma exceção pontual**: o checkbox admin-only "Conta de teste" (toggle de `is_test`). Não é edição de perfil — é uma flag operacional de limpeza de base, gated por admin. O resto do conteúdo continua read-only.
- Mascaramento de PII por campo / RBAC field-level (não existe hoje; é decisão futura — ver §8 e memória `project_rbac_pii_visibility`).
- Novo endpoint de backend **para LEITURA do perfil** (o existente `GET /api/admin/workers/:id` já serve — §4.4). **Exceção:** o toggle de `is_test` exige **um** endpoint de escrita novo (`PATCH /api/admin/workers/:id/test-flag`, admin-only — §5, §9.6). **Zero schema** nesta task: a coluna `workers.is_test` é criada na **#5** (migration 221); aqui só se consome. Fora isso, sem outros endpoints/migrations (decisão TRAVADA §9.5 atualizada por §9.6).
- **Criar o atom genérico `Modal`** no design system agora — seguir o padrão hand-rolled dos modais do Match; a extração vira follow-up TD (decisão TRAVADA §9.2).
- **Versão enxuta** do perfil no modal — reusa o `WorkerDetailContent` inteiro (decisão TRAVADA §9.4).
- Mudanças no algoritmo de matchmaking ou no shape `SavedCandidate`.

---

## 4. Estado atual do código — EVIDÊNCIA

### 4.1 Tela/componente da Lista de Match — onde fica o gatilho
- Página: `enlite-frontend/src/presentation/pages/admin/VacancyMatchPage.tsx` (260 linhas). Renderiza a tabela e já orquestra **dois modais inline** (`InviteProgressModal` :240-247, `ScheduleInterviewModal` :250-257) via state — padrão a seguir para o novo modal.
- Linha de candidato: `MatchCandidateRow.tsx` (174 linhas). É **aqui** que o link/gatilho do perfil deve ser adicionado — a coluna de nome (:83-107) e/ou a coluna de ações (:137-160, hoje só botão WhatsApp + chevron de notas).
- O id do worker disponível na row: `candidate.workerId` (`types/match.ts:5`).

### 4.2 Perfil/visão de prestador já existente
- Página completa: `enlite-frontend/src/presentation/pages/admin/WorkerDetailPage.tsx` (187 linhas). Recebe id via `useParams` (:23), carrega via `useWorkerDetail(id)` (:28).
- Conteúdo é composto por **cards isolados por seção** em `src/presentation/components/features/admin/WorkerDetail/`:
  - `WorkerContactCard`, `WorkerPersonalInfoCard`, `WorkerAddressCard`, `WorkerProfessionalCard`, `WorkerProfileTabs`, `WorkerEncuadresCard`, `WorkerDocumentsCard`, `WorkerAvailabilityCard` (imports em `WorkerDetailPage.tsx:13-20`).
  - Abas: encuadres, documents (default), availability, financial/history (placeholders "coming soon", `WorkerDetailPage.tsx:178`).
- **Reusabilidade ALTA:** a página **não usa `PageContainer`**; só o shell (header "voltar" :60-76 e estados loading/erro :40-53) depende de `useNavigate`/`useLocation`. O miolo (linhas ~78-176) depende só de `worker`, `activeTab` e handlers de docs — extraível para `WorkerDetailContent({ id, onClose? })` com baixo risco. Os cards recebem props primitivas desestruturadas, sem acoplamento a router.
- **Atenção (não-recorrência):** existem cards legados não usados pela página (`WorkerPersonalCard`, `WorkerLocationCard`, `WorkerStatusCard`) — grep confirma que nenhum é importado fora de `WorkerDetail/`. Não consumir os legados; usar os mesmos da página.

### 4.3 Componente Modal/Dialog no design system
- **NÃO EXISTE** atom/molecule genérico de Modal. `find` em `atoms/` e `molecules/` por `Modal/Dialog/Drawer/Sheet.tsx` → 0 arquivos. `atoms/index.ts` não exporta Modal. `grep` de import de Modal compartilhado em `src/` → **0**.
- Padrão de fato (**~20 arquivos** usam `fixed inset-0` direto): overlay hand-rolled com Tailwind, sem portal:
  ```
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
    <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg|2xl p-6 ...">
      <header> Heading + <X size={20}/> (aria-label common.close) </header>
      ...children...
  ```
- Os dois modais do Match seguem exatamente esse padrão (sem portal/ESC/scroll-lock):
  - `InviteProgressModal.tsx:62-77` (`max-w-lg`, botão `<X>` :70-77).
  - `ScheduleInterviewModal.tsx:337-353` (`max-w-2xl`, header `<X>` :347-353).
- Único caso com `createPortal`: `VacancyDetail/VacancyScheduleEditModal.tsx:2,111` — mas é **drawer lateral**, não modal centralizado; precedente isolado.
- **Conclusão:** o `WorkerProfileModal` deve seguir o padrão hand-rolled centralizado dos dois modais do Match (consistência fix-with-the-flock), com `max-w` largo (`max-w-3xl`/`max-w-4xl`) por causa do volume de conteúdo do perfil.

### 4.4 Endpoint que retorna o perfil completo do worker
- Frontend client: `enlite-frontend/src/infrastructure/http/AdminApiService.ts:255-257` — `getWorkerById(id): Promise<WorkerDetail>` → `GET /api/admin/workers/:id`.
- Backend rota: `worker-functions/src/index.ts:304` — `app.get('/api/admin/workers/:id', staffOnly, ...)` → controller `AdminWorkersController.getWorkerById` (`modules/worker/interfaces/controllers/AdminWorkersController.ts:242-259`). Shape montado em `AdminWorkersDetailBuilder.ts:150-195`.
- Tipo no frontend: `WorkerDetail` em `domain/entities/Worker.ts:67-118`.
- **Já existe e é suficiente** para um modal de consulta rápida — retorna identidade, contato, documentos (URLs assinadas GCS), endereço, profissão, disponibilidade e encuadres num único request, já tipado. Hook `useWorkerDetail(id)` (`hooks/admin/useWorkerDetail.ts:19,36`) reusável tal qual.
- **Ressalva de payload (não bloqueante):** o builder gera URL assinada de TODOS os documentos e descriptografa ~15 campos via KMS a cada chamada (`AdminWorkersDetailBuilder.ts:39-42,81-95`). Para "consulta rápida" funciona; se latência incomodar, é otimização futura (endpoint leve), não pré-condição.

### 4.5 RBAC / PII — como é tratado hoje
- Campos PII retornados em **texto claro**, sem mascaramento por campo: `documentType`+`documentNumber` (RG/CPF/DNI, `AdminWorkersDetailBuilder.ts:157`), `phone`/`whatsappPhone`/`email` (:151), `birthDate`/`sex`/`gender`/`sexualOrientation`/`race`/`religion`/`weightKg`/`heightCm` (:155-166), endereço+lat/lng (`location`/`serviceAreas` :169-177), documentos incl. **antecedentes penais** `criminalRecordUrl` (:55), e `encuadres[]` com `patientName` (PII do paciente, :178-186).
- Único controle = **acesso por role**, não por campo: middleware `staffOnly` = `requireStaff()` (`AuthMiddleware.ts:220-232`) exige role em `['admin','recruiter','community_manager']`. Qualquer staff autenticado vê toda a PII.
- **NÃO ENCONTRADO** mascaramento/redação no endpoint nem no client (grep `mask|redact|rbac|permission` → só `phoneMasked` em `WorkerControllerV2.ts:105`, controller do fluxo do próprio worker, **irrelevante** aqui).
- Consistente com memórias `project_rbac_pii_visibility` e `project_no_worker_edit_intentional`: não hardcodar mascaramento; RBAC futuro decide.

### 4.6 Como o frontend gateia admin (para o checkbox admin-only) — EVIDÊNCIA
- **Hook canônico:** `useAdminAuth()` em `enlite-frontend/src/presentation/hooks/useAdminAuth.ts:1-51` expõe `adminProfile: AdminUser | null`.
- **Tipo:** `AdminUser.role: EnliteRole` em `enlite-frontend/src/domain/entities/AdminUser.ts:3-12`. O enum `EnliteRole` em `enlite-frontend/src/domain/entities/EnliteRole.ts:10-14` tem `ADMIN='admin'`, `RECRUITER='recruiter'`, `COMMUNITY_MANAGER='community_manager'`.
- **Padrão de gate em uso (canônico, copiar este):** `enlite-frontend/src/presentation/pages/admin/AdminUsersPage.tsx:91-92` — `const { adminProfile } = useAdminAuth(); const isAdmin = adminProfile?.role === EnliteRole.ADMIN;` e render condicional `{isAdmin && (...)}` em `:178-182` e `:225-233`. Mesmo padrão em `AdminWorkersPage.tsx:25`.
- **`PermissionGate` (ABAC fino, Cerbos):** `enlite-frontend/src/presentation/components/features/auth/PermissionGate.tsx:1-28` via `usePermissions(resourceType)` — porém Cerbos está em standby (`VITE_CERBOS_URL` ausente, memória `project_cerbos_not_in_use`). **NÃO usar `PermissionGate` aqui** — é para resource+action, não para "é admin?", e depende de Cerbos ligado. Para "só admin vê", usar o check de role direto (`adminProfile?.role === EnliteRole.ADMIN`), que é o padrão já adotado nas páginas admin.
- **Decisão de gate (lowest-risk):** passar `isAdmin` como prop de `WorkerDetailPage`/`VacancyMatchPage` (onde o hook já roda) para `WorkerDetailContent`, e dentro do `WorkerDetailContent` renderizar o checkbox só com `{isAdmin && (...)}`. Evita o `WorkerDetailContent` virar acoplado a auth — recebe `isAdmin` por prop, igual aos cards recebem props primitivas (§4.2). A página/modal já têm acesso ao `useAdminAuth`.
- **Nota:** a `WorkerDetailPage` está atrás de `AdminProtectedRoute` (qualquer staff logado chega), então o gate por role é necessário para esconder de recruiter/community_manager — não basta a proteção de rota.

---

## 5. Mudanças propostas

Reuso máximo: **perfil = `WorkerDetailContent` INTEIRO extraído da `WorkerDetailPage`**; **modal = padrão hand-rolled dos modais do Match** (sem atom genérico — §9.2); **dados = `useWorkerDetail`/`getWorkerById` existentes** (**zero backend/schema** — §9.5).

| Arquivo | Ação | Nota |
|---|---|---|
| `presentation/pages/admin/WorkerDetailPage.tsx` | **Editar** | Extrair miolo (~78-176) para `WorkerDetailContent`; página passa a renderizar shell (header voltar + loading/erro) + `<WorkerDetailContent id={id} isAdmin={isAdmin} />`. Obtém `isAdmin` via `useAdminAuth()` (`adminProfile?.role === EnliteRole.ADMIN`, §4.6). Reduz a página e habilita reuso. |
| `presentation/components/features/admin/WorkerDetail/WorkerDetailContent.tsx` | **Criar** | Conteúdo **INTEIRO** do perfil (miolo completo da página, §9.4 — sem versão enxuta) parametrizado por `{ id, isAdmin }`. Carrega via `useWorkerDetail(id)` + hooks de docs. Sem `useParams`/`useNavigate` dentro. Renderiza o checkbox "Conta de teste" **só** com `{isAdmin && (...)}`. ≤400 linhas (se estourar, manter abas como já são subcomponentes). |
| `presentation/components/features/admin/WorkerDetail/WorkerTestFlagToggle.tsx` (ou inline no `WorkerDetailContent`) | **Criar** | Checkbox controlado "Conta de teste" ligado a `worker.isTest`; `onChange` chama `useWorkerTestFlag().toggle(workerId, next)`; estado otimista + erro i18n. Renderizado só quando `isAdmin`. |
| `presentation/hooks/admin/useWorkerTestFlag.ts` | **Criar** | Hook que chama `AdminApiService.setWorkerTestFlag(id, isTest)` → `PATCH /api/admin/workers/:id/test-flag`; expõe `{ toggle, isPending, error }`. |
| `infrastructure/http/AdminApiService.ts` | **Editar** | Adicionar `setWorkerTestFlag(id, isTest): Promise<void>` → `PATCH /api/admin/workers/:id/test-flag` (vizinho de `getWorkerById` :255-257). |
| `domain/entities/Worker.ts` | **Editar** | Adicionar `isTest: boolean` ao tipo `WorkerDetail` (:67-118), espelhando a coluna `workers.is_test` da #5. |
| `worker-functions` — `AdminWorkersController` + rota + use case | **Editar/Criar** | Endpoint `PATCH /api/admin/workers/:id/test-flag` **gated por admin** (ver nota abaixo), body `{ isTest: boolean }` (Zod), use case que faz `UPDATE workers SET is_test=$1 WHERE id=$2`. Builder do `getWorkerById` (`AdminWorkersDetailBuilder.ts:150-195`) passa a expor `is_test` no shape. |
| `presentation/components/features/admin/VacancyMatch/WorkerProfileModal.tsx` | **Criar** | Overlay `fixed inset-0 ... bg-black/40` + painel `bg-white rounded-2xl shadow-xl max-w-3xl/4xl`, header com `Heading` + `<X>` (`aria-label` `common.close`). Renderiza `<WorkerDetailContent id={workerId} isAdmin={isAdmin} />`. Props: `{ workerId, isAdmin, onClose }`. **Fecha por backdrop-click** (onClick no overlay externo, com `stopPropagation` no painel) **+ ESC** (listener `keydown` em `useEffect`) além do `<X>` (§9.3). |
| `presentation/components/features/admin/VacancyMatch/MatchCandidateRow.tsx` | **Editar** | **MANTER** o clique do nome navegando (`:44-49,85-95` intactos) e **adicionar** um ícone/link "ver perfil" na **coluna de ações** (`:137-160`) que dispara novo callback `onOpenProfile(workerId)` via prop, sem fetch direto no row (§9.1 opção b). |
| `presentation/pages/admin/VacancyMatchPage.tsx` | **Editar** | State `profileWorkerId: string \| null`; obter `isAdmin` via `useAdminAuth()` (§4.6) e passar pro `<WorkerProfileModal isAdmin={isAdmin} />`; renderizar o modal inline (padrão dos modais :240-257); passar `onOpenProfile` para `MatchCandidateRow`. |
| `infrastructure/i18n/locales/es.json` + `pt-BR.json` | **Editar** | Novas chaves (ex.: `admin.match.viewProfile`, `admin.match.profileModalTitle`, `common.close`). es-AR principal. Enums no perfil já renderizados via i18n nos cards existentes — manter (memória `feedback_enum_i18n_frontend`). |
| `docs/FOLLOWUPS.md` | **Editar** | Registrar um **TD** novo: extrair atom `Modal` genérico do design system (~20 overlays hand-rolled + os 2 modais do Match + este `WorkerProfileModal`). Decisão TRAVADA §9.2 — esta task **não** cria o atom. |
| `e2e/...VacancyMatch...e2e.ts` (+ screenshot ref) | **Criar/Editar** | Abrir o modal e `toHaveScreenshot()` (ver §7). |

**Limite de linhas:** ao tocar `WorkerDetailPage.tsx` (187) e `MatchCandidateRow.tsx` (174) ficam folgados; `WorkerDetailContent` é o risco de >400 — manter cards como subcomponentes (já são) garante conformidade.

**Endpoint de toggle proposto — `PATCH /api/admin/workers/:id/test-flag`:**
- **Gate de backend:** **admin-only**, mais estrito que o `staffOnly`/`requireStaff` usado no `GET /api/admin/workers/:id` (`worker-functions/src/index.ts:304`, middleware `AuthMiddleware.ts:220-232` libera `admin`/`recruiter`/`community_manager`). O toggle de `is_test` é operação de limpeza de base → exige um middleware **`adminOnly`/`requireAdmin`** (só role `admin`), coerente com o gate do front (§4.6) e com o precedente de endpoints admin-only do dedup (`POST /analytics/dedup/run` = `requireAdmin`, ver doc #5 §4.5). Defesa em profundidade: esconder no front **não basta**; o backend rejeita não-admin.
- **Body:** `{ isTest: boolean }` validado com Zod (regra do projeto). Use case faz `UPDATE workers SET is_test = $1, updated_at = NOW() WHERE id = $2`.
- **Resposta:** 200 com o novo estado (ou 204). O `getWorkerById` passa a retornar `is_test` no shape (`AdminWorkersDetailBuilder.ts:150-195`) para o checkbox refletir o estado atual ao abrir o perfil/modal.
- **Dependência de schema:** a coluna `workers.is_test` é criada na **#5** (migration 221). Esta task **consome**, não cria. Se a #5 ainda não rodou, o endpoint não tem onde gravar — ordem: #5 (coluna) antes do go-live da #2.

---

## 6. Schema / migrations

**Nenhuma migration nesta task.** A coluna `workers.is_test` consumida pelo checkbox/endpoint é criada na **#5** (migration 221, `05-merge-perfis-duplicados.md` §6/§9.7). Aqui só se **consome** a coluna (toggle + leitura). O endpoint de leitura existente (`GET /api/admin/workers/:id`, §4.4) é reusado; o único acréscimo de backend é o `PATCH .../test-flag` (sem schema novo).

---

## 7. Critérios de aceite (verificáveis)

1. Na Lista de Match (`/admin/vacancies/:id/match`), o clique no **nome** continua navegando para `/admin/workers/:id` (intacto) E existe um **ícone/link "ver perfil" na coluna de ações** (`MatchCandidateRow.tsx:137-160`) que **abre um modal** com o perfil do prestador — **sem navegar para fora da página** (a URL não muda; a seleção/filtro em curso é preservada).
2. O modal carrega via `GET /api/admin/workers/:id` (reusando `useWorkerDetail`/`getWorkerById`) e exibe os mesmos cards de perfil da `WorkerDetailPage` (contato, pessoal, endereço, profissional, abas docs/encuadres/disponibilidade) — read-only.
3. O modal fecha por botão `<X>`, **clique no backdrop e tecla ESC** (§9.3), retornando à Lista de Match com seleção intacta.
4. Estados de loading e erro do fetch são tratados dentro do modal (skeleton/spinner + mensagem de erro i18n).
5. Todas as labels novas via i18n, es-AR como principal; nenhum texto hardcoded; enums via `t(..., { defaultValue })`.
6. `WorkerDetailContent` é consumido **tanto** pela `WorkerDetailPage` **quanto** pelo modal (provar com grep dos 2 importadores) — sem duplicar markup do perfil.
7. `pnpm lint`, `pnpm type-check`, `pnpm validate:lines`, `pnpm validate:architecture` passam; nenhum arquivo >400 linhas.
8. **Checkbox "Conta de teste" admin-only:** aparece no perfil (página E modal) **somente** quando `adminProfile?.role === EnliteRole.ADMIN` (§4.6); para recruiter/community_manager o checkbox **não** é renderizado (teste cobrindo admin vê / não-admin não vê).
9. **Toggle persiste `is_test`:** marcar/desmarcar chama `PATCH /api/admin/workers/:id/test-flag` e o estado reflete no `getWorkerById` ao reabrir (teste de integração: toggle → `is_test` muda no banco → reload mostra o novo estado).
10. **Gate de backend:** o `PATCH .../test-flag` é **admin-only** — chamada por staff não-admin (recruiter/community_manager) é rejeitada (403), mesmo que o front esconda o checkbox (teste de backend cobrindo não-admin negado).
11. **Teste E2E com `toHaveScreenshot()`** (obrigatório, CLAUDE.md): abre a Lista de Match (mock dos resultados), aciona o gatilho de perfil, espera o modal renderizar e captura screenshot do modal aberto. O screenshot do estado **admin** deve mostrar o checkbox "Conta de teste". Sem screenshot assertion o teste é considerado incompleto.

---

## 8. Riscos & armadilhas

- **PII em claro num modal mais "casual":** o modal facilita exibir antecedentes penais, documento de identidade, endereço/geo e `patientName` de encuadres a qualquer staff. Não há mascaramento field-level hoje (§4.5). Esta task **não** introduz mascaramento (fora de escopo / RBAC futuro), mas a maior exposição visual deve ser sinalizada ao PO/segurança (memórias `project_rbac_pii_visibility`, `project_pii_scrub_relies_on_human_review`).
- **Payload pesado por linha:** abrir o modal dispara URLs assinadas de todos os docs + ~15 descriptografias KMS (§4.4). Para uso de "consulta rápida" repetida, latência pode incomodar — considerar cache/`useWorkerDetail` por id ou endpoint leve **se** medir lento (não bloqueante).
- **Cards legados duplicados:** `WorkerPersonalCard`/`WorkerLocationCard`/`WorkerStatusCard` existem mas não são usados; não consumir por engano (§4.2).
- **Não há atom Modal:** copiar markup pela 3ª/4ª vez aumenta a dívida. Decisão TRAVADA (§9.2): **não** criar o atom agora (vira refactor cross-feature ~20 callers); registrar como TD em `docs/FOLLOWUPS.md` e seguir o padrão hand-rolled.
- **Tabela como atom:** `WorkerDetailContent` deve respeitar a regra de só usar o atom `Table` (sem `<table>` raw) — herdado dos cards existentes, baixo risco.
- **Risco de regressão na `WorkerDetailPage`:** a extração do miolo não pode alterar o comportamento da página (abas, docs patch). Cobrir com os testes existentes (`WorkerDetailPage.test.tsx`, `WorkerDetailPage.deleteRegression.test.tsx`) verdes pós-refactor.

---

## 9. Decisões TRAVADAS (2026-06-19, Gabriel)

Nenhuma pergunta em aberto — a task é **executável sem confirmação**.

1. **Gatilho — opção (b):** **MANTER o clique no nome** navegando para a página de detalhe (`/admin/workers/:id`, `MatchCandidateRow.tsx:44-49,85-95` intactos) **E adicionar** um ícone/link "ver perfil" na **coluna de ações** (`MatchCandidateRow.tsx:137-160`) que abre o modal. Não remove o comportamento existente.
2. **NÃO criar o atom `Modal` genérico agora:** seguir o **padrão hand-rolled** dos modais do Match (`InviteProgressModal.tsx:62-77`, `ScheduleInterviewModal.tsx:337-353`). A extração do atom (~20 overlays `fixed inset-0`) é registrada como **follow-up TD em `docs/FOLLOWUPS.md`** nesta task (apenas o registro; o refactor cross-feature não é feito aqui).
3. **Fechar por backdrop-click + ESC:** o `WorkerProfileModal` fecha por **clique no backdrop** (overlay externo com `stopPropagation` no painel) **+ ESC** (listener `keydown`), além do `<X>`. Difere dos modais atuais do Match (só `<X>`) — é melhoria local intencional.
4. **Reusar o `WorkerDetailContent` INTEIRO:** extrair o miolo completo da `WorkerDetailPage` (todos os cards + todas as abas encuadres/docs/disponibilidade) — **sem versão enxuta**. Mesmo conteúdo na página e no modal (fix-once).
5. **Backend/schema mínimos (atualizado por §9.6):** para a **leitura** do perfil, zero backend/schema — reusa `GET /api/admin/workers/:id` + `useWorkerDetail`/`getWorkerById` tal qual (§4.4). A **única exceção** é o toggle de `is_test`: **um** endpoint novo (`PATCH .../test-flag`) e a exposição de `is_test` no shape de leitura. **Nenhuma migration** nesta task — a coluna nasce na #5.
6. **Checkbox "Conta de teste" admin-only (TRAVADO — limpeza de base):** adicionar ao `WorkerDetailContent` (logo página + modal, fix-once) um checkbox que marca/desmarca `workers.is_test`. **Visível só para admin** via check de role direto `adminProfile?.role === EnliteRole.ADMIN` (padrão de `AdminUsersPage.tsx:91-92`, §4.6) — **não** usar `PermissionGate`/Cerbos (standby). Persiste via `PATCH /api/admin/workers/:id/test-flag` **gated por admin no backend** (`requireAdmin`, não `requireStaff`) — esconder no front não basta, defesa em profundidade. A coluna `is_test` é criada na **#5** (migration 221); aqui só se consome. O consumo no predicado de elegibilidade do espelho fica na **#6**/#7.

---

## 10. Estimativa & dependências

- **Tamanho:** S–M. Trabalho é: extração `WorkerDetailContent` (refactor de baixo risco) + novo `WorkerProfileModal` (markup já padronizado) + fiação no row/página + i18n + 1 E2E visual + **checkbox admin-only `is_test` + endpoint `PATCH .../test-flag` (admin gated) + hook/client**.
- **Dependências:** o checkbox depende da coluna `workers.is_test` da **#5** (migration 221) existir antes do go-live. Fora isso, reusa endpoint de leitura, hook, tipos e cards já existentes. O gate admin usa `useAdminAuth`/`EnliteRole` já existentes (§4.6) — não depende do RBAC/ABAC em discovery (memória `project_permissions_abac_feature`).
- **Bloqueio:** nenhum. Todas as decisões estão TRAVADAS (§9); a task é executável sem confirmação.
- **Validação visual:** rodar com conta de teste `gabriel.g.stein@gmail.com` (memória `project_e2e_test_account`); screenshot do modal aberto é gate de DONE.
