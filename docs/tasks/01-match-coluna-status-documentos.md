# Task: Incluir coluna com Status de Documentos (Lista de Match)
**ClickUp:** https://app.clickup.com/t/86aj3yufg · **Status:** Open→Refinada · **Board:** APP Recrutamento

> **TL;DR — ATENÇÃO:** Esta feature **já está implementada e mergeada em `main`**. A coluna "Documentos" existe na Lista de Match (admin), com backend, frontend, i18n (es/pt-BR), testes unitários e teste E2E de integração com screenshot. Commit `504c6f4` (2026-06-16). O refinamento abaixo documenta o que já existe; o escopo de trabalho restante é **verificação + eventuais ajustes finos**, não construção do zero. Ver §4 (evidência) e §9 (decisões pendentes).

---

## 1. Contexto

A "Lista de Match das Vacantes" é a tela admin onde, para uma vaga, o recrutador roda o matchmaking e vê os candidatos rankeados (nome, status, ocupação, zona/distância, casos ativos, score) para então convidá-los/agendar entrevista. O ticket pede uma coluna mostrando o **status de documentos** de cada candidato, para o recrutador saber de relance quem está com documentação pendente antes de convidar.

Subtask de "Ajustes na Lista de Match das Vacantes" (86aj3yuaj). O ticket **não tem descrição** — só o título.

Durante a investigação descobriu-se que a coluna **já foi construída e mergeada** numa branch de feature anterior (`feat/match-document-status-column`), incluindo backend + frontend + i18n + testes. Portanto este doc serve como registro de refinamento + checklist de verificação, não como spec de implementação nova.

## 2. Objetivo

Garantir que a Lista de Match exibe, por candidato, o status de documentação do worker, com semáforo visual (verde = completo, vermelho = pendente), i18n es/pt-BR, e que o estado servido pelo backend é correto e sem vazamento de PII.

Como a feature já existe, o objetivo operacional vira: **validar a implementação atual contra os critérios de aceite (§7) e fechar o ticket, ou abrir follow-up pontual se algum critério falhar.**

## 3. Escopo (Dentro / Fora)

**Dentro:**
- Coluna "Documentos" na tabela da Lista de Match (`VacancyMatchPage`).
- Badge de status reusando o atom `DocsStatusBadge`.
- Campo `documentStatus` no DTO de match (backend → frontend).
- i18n da label da coluna e dos status (es-AR principal + pt-BR).
- Cobertura de teste (unit + E2E com screenshot).

**Fora:**
- Alterar a **lógica de cálculo** do status de documentos (vem de `worker_documents.documents_status`, ver §4.3). Não recomputar via `workerDocumentPolicy.ts` nem `fn_worker_missing_fields` neste ticket.
- Filtro/ordenação por status de documentos na Lista de Match (não pedido).
- Coluna de docs no **modal** de match (`MatchCandidateRow.match.tsx` / `MatchBucketSection`), que é uma lista visual diferente (card list, não tabela) — não pedido. Ver §9.
- Mascaramento/RBAC do status (status de docs não é PII sensível por si só; nome do worker já é decriptado pelo backend hoje).

## 4. Estado atual do código — EVIDÊNCIA (file:line + greps com contagem)

### 4.1 Tela/lista de Match no frontend (página + componente + colunas)
- **Página:** `enlite-frontend/src/presentation/pages/admin/VacancyMatchPage.tsx`. Monta a tabela (atoms `Table`) com header em **linhas 196-212**. Headers atuais: checkbox, `#`, `colName` (205), **`colDocs` (207)**, `colStatus` (206), `colOccupation` (208), `colZone` (209), `colCases` (210), `colScore` (211).
- **Linha da tabela:** `enlite-frontend/src/presentation/components/features/admin/VacancyMatch/MatchCandidateRow.tsx`. A célula de docs renderiza o badge em **linha 117-119**:
  ```tsx
  <TableCell unwrapped className="whitespace-nowrap">
    <DocsStatusBadge status={candidate.documentStatus} />
  </TableCell>
  ```
  (Arquivo tem 174 linhas — dentro do limite de 400.)
- **Hook de dados:** `enlite-frontend/src/hooks/admin/useVacancyMatch.ts` — chama `AdminApiService.triggerMatch` + `getMatchResults`.
- **Tipo do DTO no FE:** `enlite-frontend/src/types/match.ts:13` — `documentStatus: string | null` já declarado em `SavedCandidate`, com comentário citando os valores crus de `worker_documents.documents_status`.

> NOTA: existe um **segundo** componente de linha, `MatchCandidateRow.match.tsx` (usado por `MatchBucketSection.tsx`, que é a lista do modal de convite, em formato card). Esse **não** mostra status de docs e está **fora de escopo** (ver §3 e §9).

### 4.2 Endpoint backend que alimenta a lista + DTO
- **Controller:** `worker-functions/src/modules/matching/interfaces/controllers/VacancyMatchController.ts`.
  - SQL do `getMatchResults` (linhas 64-105) inclui `wd.documents_status` no SELECT (**linha 77**) via `LEFT JOIN worker_documents wd ON wd.worker_id = w.id` (**linha 98**).
  - O DTO retornado popula `documentStatus: row.documents_status ?? null` (**linha 125**).
- Rotas: `worker-functions/src/modules/matching/interfaces/routes/adminVacanciesRoutes.ts`.
- **Decriptação de PII:** o nome do worker é decriptado server-side via `KMSEncryptionService` (linha 107-114); o `documents_status` é um enum de status, não PII.

### 4.3 Como o status de documentos é computado hoje
- A coluna lê **diretamente** `worker_documents.documents_status` (coluna de status já materializada na tabela). **Não** é recalculado on-the-fly pelo matchmaking.
- Valores crus possíveis: `'pending' | 'incomplete' | 'submitted' | 'under_review' | 'approved' | 'rejected'` (documentado em `DocsStatusBadge.tsx:24-30` e em `types/match.ts:13`).
- **SSOT da política por profissão** (quais docs são obrigatórios por AT/Cuidador): `worker-functions/src/modules/worker/application/workerDocumentPolicy.ts:1-18` — é quem decide se `documents_status` deve virar `approved`/`incomplete` etc. quando recalculado em outro fluxo (review de docs). A Lista de Match **consome** o resultado materializado, **não** chama essa policy.
- `fn_worker_missing_fields` (função SQL, SSOT de campos faltantes) é usada pelo gate de postulação/blocked-attempts, **não** pela Lista de Match. Greps:
  - `grep -rn "fn_worker_missing_fields" worker-functions/src` → usada em `BlockedApplicationRepository.ts` + tests + migrations 209/212/213. **0 ocorrências** no módulo `matching/` controllers (confirma que match não usa essa fn).
  - `grep -rn "documents_status" .../VacancyMatchController.ts` → **2 ocorrências** (linhas 77, 125) — é a única fonte do campo na lista.

### 4.4 Componente de badge reusável já existe
- `enlite-frontend/src/presentation/components/atoms/DocsStatusBadge/DocsStatusBadge.tsx` (98 linhas). Pill verde/vermelha; deriva completude do status cru; renderiza `—` quando `status` é null. i18n via `t('admin.workers.docsStatus.*')`.
- **Contagem de usos (grep, exclui tests):** `grep -rln "DocsStatusBadge" enlite-frontend/src | grep -v .test.` → **4 arquivos**: o próprio componente, seu `index.ts`, `WorkersTable.tsx` e `MatchCandidateRow.tsx`. Ou seja, **componente compartilhado** entre Lista de Workers e Lista de Match — fix-once.
- **i18n já presente:**
  - `es.json:2097` → `"colDocs": "Documentos"`; `es.json:1716` → bloco `docsStatus.*` (complete/rejected/pending/incomplete/submitted/under_review/approved).
  - `pt-BR.json:2018` → `"colDocs"`; `pt-BR.json:1637` → bloco `docsStatus.*`.

### 4.5 Histórico Git (prova de que já está mergeado)
- `git log --oneline -- .../MatchCandidateRow.tsx` → `504c6f4 feat(match): coluna "Status de Documentos" na lista de match` (2026-06-16) + `8b23acd fix(match): integra link-do-perfil + coluna-de-docs`.
- `git merge-base --is-ancestor 504c6f4 main` → **YES** (mergeado em main). Idem `8b23acd` e `e6d72d1`.

### 4.6 Testes já existentes
- Unit: `.../VacancyMatch/__tests__/MatchCandidateRow.test.tsx` — casos `documentStatus: 'approved'` (verde), `'pending'` (vermelho), `null` (em dash). Linhas 53-66.
- Unit: `DocsStatusBadge.test.tsx`.
- **E2E com screenshot:** `enlite-frontend/e2e/integration/match-document-status-column.integration.e2e.ts` + snapshot `match-document-status-column-integration-darwin.png`. Confirma o requisito de **screenshot assertion obrigatório**.

## 5. Mudanças propostas (arquivos a criar/modificar)

Dado que a feature já está em `main`, **não há implementação nova esperada**. As "mudanças" abaixo só se aplicam se a verificação (§7) reprovar algum critério.

**Backend (`worker-functions`):**
- Nenhuma mudança esperada. `VacancyMatchController.ts` já serve `documentStatus`. Tocar apenas se: (a) o `LEFT JOIN worker_documents` produzir duplicação de linhas por worker com múltiplos registros de docs (verificar cardinalidade — ver §8), ou (b) se decidir-se trocar a fonte para um cálculo via policy (fora de escopo).

**Frontend (`enlite-frontend`):**
- Nenhuma mudança esperada. Coluna, badge, DTO e i18n já existem. Tocar apenas se a verificação visual divergir do Figma (não há Figma anexado ao ticket — ver §9) ou se faltar label em algum idioma.

## 6. Schema / migrations

**N/A.** A coluna `worker_documents.documents_status` já existe (criada/refatorada em migrations antigas: `009_create_worker_documents_table.sql`, `026_refactor_worker_status_and_documents.sql`, `096_refactor_worker_status.sql`). A Lista de Match apenas lê via JOIN. Nenhuma migration nova.

## 7. Critérios de aceite (verificáveis)

1. [ ] A Lista de Match (`/admin/vacancies/:id/match`, `VacancyMatchPage`) exibe uma coluna "Documentos" entre Nome e Status. — *Evidência atual: header `colDocs` em VacancyMatchPage.tsx:207.* ✅ já presente.
2. [ ] Cada linha renderiza o `DocsStatusBadge` com o `documentStatus` do candidato. — *MatchCandidateRow.tsx:117-119.* ✅ já presente.
3. [ ] Badge verde para status completos (`approved`/`submitted`/`under_review`), vermelho para pendentes, `—` quando null. — *DocsStatusBadge.tsx:42,57-97 + unit test.* ✅ já presente.
4. [ ] Label e status traduzidos em **es-AR (principal)** e pt-BR via i18n, sem texto hardcoded. — *es.json:2097/1716, pt-BR.json:2018/1637.* ✅ já presente.
5. [ ] Backend serve `documentStatus` no DTO de `getMatchResults`. — *VacancyMatchController.ts:77,125.* ✅ já presente.
6. [ ] Teste E2E Playwright **com `toHaveScreenshot()`** cobrindo a coluna (OBRIGATÓRIO). — *match-document-status-column.integration.e2e.ts + .png snapshot.* ✅ já presente — **rodar e confirmar que o snapshot ainda casa** (`pnpm test:e2e:integration`).
7. [ ] Sem regressão: `pnpm lint`, `pnpm type-check`, `pnpm test:run` (FE) e suite E2E de match passam.
8. [ ] Nenhum arquivo tocado ultrapassa 400 linhas (MatchCandidateRow.tsx=174, DocsStatusBadge.tsx=98 — OK).

**Ação de fechamento:** rodar os checks 6 e 7. Se verdes, mover o ticket para Done com link aos commits `504c6f4`/`8b23acd`. Se algum reprovar, abrir follow-up pontual.

## 8. Riscos & armadilhas

- **Cardinalidade do JOIN:** `LEFT JOIN worker_documents wd ON wd.worker_id = w.id` (sem `LIMIT 1` / sem filtro de "registro ativo"). Se um worker tiver **>1 linha** em `worker_documents`, a query duplica a linha do candidato na lista. **Verificar** se `worker_documents` é 1:1 com worker (provável, mas confirmar com DBA/schema antes de fechar). Se for 1:N, adicionar desambiguação (ex.: `DISTINCT ON` ou subselect do registro mais recente).
- **Fonte materializada vs SSOT:** a coluna mostra `documents_status` **persistido**, que pode estar **stale** se o recálculo via `workerDocumentPolicy`/review não tiver rodado após a última atualização de docs do worker. A Lista de Match não força recálculo. Isso é aceitável para "status de relance", mas o recrutador pode ver um status defasado. Decidir se é aceitável (ver §9).
- **`profession = NULL` (68% dos workers em prod, ver memória):** afeta *quais* docs são obrigatórios no cálculo do `documents_status`, não a *exibição* na lista. Fora de escopo, mas pode fazer um worker AT com profession NULL aparecer "completo" indevidamente — risco herdado da policy, não desta coluna.
- **Snapshot Playwright darwin-specific:** o `.png` é `-darwin`. Em CI Linux o snapshot pode divergir por rendering de fonte; confirmar que o E2E de match roda no ambiente esperado.
- **Dois componentes homônimos:** `MatchCandidateRow.tsx` (tabela, tem docs) vs `MatchCandidateRow.match.tsx` (card do modal, sem docs). Não confundir ao mexer.

## 9. Decisões pendentes / perguntas pro PO

1. **A feature já está em `main` (commit 504c6f4, 2026-06-16). O ticket 86aj3yufg ainda está Open.** Confirmar: é só fechar (verificar e marcar Done), ou há um ajuste específico não capturado no título (o ticket não tem descrição)?
2. **Modal de convite:** a coluna de docs aparece só na tabela da página de Match, **não** no card list do modal (`MatchBucketSection`/`MatchCandidateRow.match.tsx`). O ticket cobre só a Lista (tabela), correto? Ou o recrutador também quer o status no momento de convidar?
3. **Status defasado:** ok exibir `documents_status` materializado mesmo que possa estar stale, ou a lista deve refletir o cálculo atual via policy? (Recomendação: manter materializado — recálculo síncrono é custoso e fora do path de match.)
4. **Figma:** o ticket não tem design anexado. A implementação atual (pill verde/vermelha reusando `DocsStatusBadge`) é a referência visual aceita? Se houver Figma, extrair specs via `get_design_context` antes de qualquer ajuste fino.
5. **Filtro/ordenação por status de docs:** não pedido. Confirmar que está fora de escopo desta subtask (pode ser outra subtask de "Ajustes na Lista de Match").

## 10. Estimativa (P/M/G) & dependências

- **Estimativa: P (Pequena).** A feature já está implementada e mergeada. O trabalho restante é **verificação**: rodar lint/type-check/unit/E2E (com screenshot) e confirmar cardinalidade do JOIN com o DBA. ~0,5 dia.
  - Caso a verificação reprove (ex.: JOIN duplica linhas, ou Figma diverge): sobe para **M**, com ajuste pontual no SQL do controller ou no badge.
- **Dependências:**
  - DBA (read-only) para confirmar cardinalidade `workers` ↔ `worker_documents` (1:1 vs 1:N).
  - Resposta do PO às perguntas §9 (1 e 2 são bloqueantes para fechar o ticket).
  - Ambiente E2E de integração (Docker stack backend + FE dev) para rodar o snapshot — ver `enlite-frontend/CLAUDE.md` §"Testes de integração".
