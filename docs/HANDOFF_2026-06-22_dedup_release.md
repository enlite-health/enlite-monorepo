# Handoff 2026-06-22 — Release: Centro de Duplicados + dedup em prod

Sessão grande. Resumo do que **subiu pra produção**, o que o **operador/time precisa fazer**, e o que **ficou pendente**.

---

## 1. EM PRODUÇÃO agora (deployado via PR #69 → main → enlite-prd)

| Feature | Onde | Estado |
|---|---|---|
| **Centro de Duplicados** | `/admin/dedup` (só ADMIN) | ✅ live: fila + comparar/mergear + histórico + **desfazer** (reversível via snapshot/undo) + aba **Importados** (grupos por nome) |
| **Prevenção de duplicados** | `WorkerRepository.create` normaliza phone; merge service por tiers (FK discovery runtime) | ✅ live |
| **#2 Modal de perfil** + **is_test** | lista de match + checkbox admin | ✅ live |
| **#8 Rotinas de enquadre** (código) | lembretes 24h/5min + transição no-show | ✅ código live · ⏸️ **Cloud Scheduler PAUSED** (ativar quando validar) |

- Deploy: backend revisão `worker-functions-00318`, frontend success, `/health` → 200.
- Migrations aplicadas em prod e registradas: **219, 220, 221, 223, 224, 225, 226**. Qualidade: backend 2455 + frontend 3527 unit + E2E sem mocks; cobertura 100% na lógica nova.

## 2. Limpeza de dados já feita em prod (antes do release)
- **54 grupos de duplicados por telefone eliminados** (auto-merge por login Firebase real), auditado em `worker_merge_audit`, reversível. Backup do Cloud SQL tirado antes.
- Bug do `restoreFkRows` (undo) achado pelo E2E de persistência e corrigido.

## 3. O QUE O OPERADOR/TIME PRECISA FAZER (na ferramenta nova)
- **49 conflitos** (duas contas reais no mesmo telefone) → resolver na fila `/admin/dedup`.
- **~750 importados por nome** (142 importado↔conta-real + 608 importado↔importado) → aba **Importados** (toggle "só com conta real" mostra os 142 prioritários). Aviso de "match por nome — revisar bem".
- **2.885 importados sem par**: NÃO são duplicados (registros únicos) — não há o que mesclar; decisão separada se for fazer limpeza.
- Excels de apoio (caso prefira fora do app): `docs/tasks/dedup-preview/Revision_cuentas_duplicadas.xlsx` (49) e `Cuentas_importadas_para_revisar.xlsx` (3.635).

## 4. PENDÊNCIAS TÉCNICAS (deste release)
- **Cloud Scheduler `reminders-sweep`**: PAUSED em `southamerica-east1`. Ativar com:
  `gcloud scheduler jobs resume reminders-sweep --project=enlite-prd --location=southamerica-east1`
  ⚠️ Envia WhatsApp real + muda estado do funil — validar (ex.: 1 run manual + conferir) antes de ligar.
- **Migration 222 (índice ÚNICO de `phone_normalized`)**: **deferida** — quebra enquanto os 49 conflitos existirem. Aplicar como **migration nova** DEPOIS que os conflitos forem resolvidos. Ela é o que impede novos duplicados a nível de banco.
- **Transição final do schema do phone**: a coluna gerada `phone_normalized` (mig 219) ainda existe. A decisão do user (2026-06-21) foi **normalizar `phone` in-place + dropar a coluna gerada**; isso é a fase final, junto da 222 — **bloqueada** até os 49 conflitos saírem.

## 5. NÃO INICIADO (board APP Recrutamento)
- **Track B — espelho HubSpot/AnaCare** + guard anti-colisão (só sobe grupo resolvido). Depende de: OAuth HubSpot sandbox, API key AnaCare, e a pergunta da **baja** pro Javier (AnaCare não tem endpoint de baixa — workaround via PATCH a confirmar). Specs perdidos no acidente de docs untracked, mas decisões na conversa/RAG.
- **#3 Desabilitar prestador** (Super Admin allowlist: gabriel.stein + diego.trevisan).
- **#4 Eventos de contato AT×Vaga** (timeline; ~80% da infra já existe — `WorkerTimelineController` + `wja_contact_notes`).

## 6. Estado de branches / worktrees
- `main` = release (`6e34ae5`). Branches `feat/dedup-admin`, `feat/worker-dedup`, `feat/match-ui-cluster`, `feat/encuadre-rotinas`, `integration/all-features` → **mergeadas**.
- Worktrees em `.claude/worktrees/` (wt-dedup, wt-dedup-admin, wt-match, wt-enquadre, wt-integration) podem ser **removidos** (`git worktree remove`).
- Docs desta sessão: `docs/features/dedup-admin/screen-plan.md` (pesquisa + mockups + decisões), `docs/tasks/IMPORT_GHOSTS_FINDING.md`, `docs/tasks/dedup-preview/` (Excels + CSVs).
