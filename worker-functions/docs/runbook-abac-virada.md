# Runbook — virada da RLS de país (QA → PRD)

Change `abac-pais-fase1` (D108). **Este documento é a ordem de execução.** Cada fase tem
gate GO/NO-GO e rollback próprio. Regra de ouro: **nada acontece em PRD que não tenha
rodado inteiro em QA antes** — e desligar a RLS depois de ligada é **evento de
segurança** (lex C5): registrar quem/quando/por quê no diário + log estruturado.

## Princípios (o porquê de cada regra está no link)

1. **Owner ignora policy.** `enlite_app` é dono das tabelas; enquanto o app conectar como
   ele, a RLS não vale (por isso a virada é trocar a IDENTIDADE da conexão, não ligar flag
   no banco). Ver header da migration 271.
2. **Config de serviço vive no WORKFLOW, não no `gcloud update`.** Os workflows
   (`backend-stg.yml`, `backend-prd.yml`, `backend-mcp-*.yml`) reescrevem `env_vars` a
   cada deploy — um `gcloud run services update` manual é **desfeito no push seguinte**.
   Toda mudança de `DB_USER`/flag entra no YAML do branch certo (memória
   [[flip-de-flag-nao-deploya-sozinho]]).
3. **Fail-closed parece quebrado.** Staff sem claim de país = painel vazio; conexão sem
   contexto = zero linhas. Antes de debugar "sumiu tudo", conferir claim e contexto.
4. **Terraform: desarmar → importar → alinhar → plan limpo** (D104/D106). Ambos os
   ambientes já estão em "No changes" (13/08) — manter assim: recurso novo criado à mão
   é importado no mesmo bloco.
5. **Comportamento de role só vale medido no Cloud SQL** (não no Postgres local — ele nem
   tem `cloudsqlsuperuser`). Ver memória [[role-de-banco-so-vale-medida-no-cloud-sql]].

## Estado de partida (feito e provado, 13/08)

- [x] Migrations 268-272 (grupos, roles, audit log, RLS ENABLE sem FORCE, índices) — **QA
      only** (branch `stage`, rev stg 00051). Prod está na 267.
- [x] Migration 273 (GRANT membership) — aplicada + registrada em `schema_migrations` no stg.
- [x] Código do grupo 3 (contexto por request, claim, trilha de leitura, guard UX) — na
      branch `feat/abac-pais-migrations`, **inerte** com `COUNTRY_RLS_ENABLED` ausente.
- [x] Usuários `enlite_runtime`/`enlite_system` criados em **stg e prd**, senhas em
      `enlite-{runtime,system}-db-password`, importados no terraform (plan limpo nos 2).
      Em prd são **inertes** (sem grants — `permission denied` provado).
- [x] Provas ao vivo no Cloud SQL stg: 0 linhas sem contexto · país confinado · forjar
      contexto de sistema como runtime = 0 linhas.

## FASE 1 — QA completo (task 4.1)

### 1.0 Pré-requisito: o gap "1 processo, 2 identidades"
O `worker-functions` atende staff + cron + webhook no MESMO processo, com UM `DB_USER`.
> **[DECISÃO DO MECANISMO — preenchida após a pesquisa de mercado]**
> Opção A: um login user membro das 2 roles + `SET ROLE` por classe de request no client
> fixado (padrão PostgREST/authenticator). Opção B: dois pools no processo (runtime/system),
> a borda escolhe. O serviço `worker-functions-mcp` é 100% sistema → ele simplesmente vira
> `DB_USER=enlite_system`, sem mecanismo nenhum.
Gate: e2e novo cobrindo **conexão única** (o e2e de 13/08 usou dois pools separados e não
cobre este caso) + prova de que staff não escala para sistema.

### 1.1 Merge do PR na `stage` (= deploy automático de QA)
- PR `feat/abac-pais-migrations` → `stage`. Merge é **ação isolada com confirmação na
  hora** (memória [[merge-e-deploy-sao-a-mesma-acao]]).
- Pós-deploy: health 200; migration 273 NÃO re-roda (registrada); comportamento idêntico
  (flags off). `gcloud run revisions list` para anotar a revisão.

### 1.2 Claims de país no Identity Platform de stg
```bash
cd worker-functions
FIREBASE_PROJECT_ID=enlite-stg DATABASE_URL=<via proxy 5434> npm run claims:country:dry
FIREBASE_PROJECT_ID=enlite-stg DATABASE_URL=<via proxy 5434> npm run claims:country   # default AR
```
- Anotar: quantos staff receberam claim, quantos sem conta no IdP.
- Quem estiver logado só enxerga após refresh do token (≤1h) — avisar se houver gente
  testando QA na hora.

### 1.3 Trocar a identidade da conexão — **no YAML, branch `stage`**
Editar `.github/workflows/backend-stg.yml` (e `backend-mcp-stg.yml`):
- `DB_USER=enlite_app` → `enlite_runtime` (mcp → `enlite_system`)
- `DB_PASSWORD=enlite-ar-db-password:latest` → `enlite-runtime-db-password:latest`
  (mcp → `enlite-system-db-password:latest`)
- `COUNTRY_RLS_ENABLED=true` nas env_vars
- ⚠️ conferir IAM: a SA do serviço (`enlite-functions-sa@enlite-stg`) precisa de
  `secretAccessor` nos 2 secrets novos — conceder e **importar no terraform** no mesmo bloco.
- Push na `stage` → deploy. **Este é o momento da virada em QA.**

### 1.4 Verificação em QA (gate GO/NO-GO da fase)
| # | prova | esperado |
|---|---|---|
| 1 | login staff com claim AR → lista pacientes | só AR, contadores idem |
| 2 | staff SEM claim (criar um de teste) | painel vazio + log `[abac] staff sem claim` |
| 3 | detalhe de paciente BR por id, staff AR | 404 (indistinguível de inexistente) |
| 4 | cron check-in / `/api/internal/events/health` | 200, processa os 2 países |
| 5 | webhook ClickUp de teste | processa normal |
| 6 | MCP `tools/list` + uma capability | funciona (via enlite_system) |
| 7 | trilha: abrir dossiê → `resource_access_log` | 1 linha, origem certa |
| 8 | suíte e2e completa contra QA | verde |
| 9 | **EXPLAIN ANALYZE das listagens quentes vs `baseline-1.4.md`** | **p95 +≤5%** |
| 10 | logs 24-48h: `request consultou o banco sem contexto declarado` | investigar CADA um |
- NO-GO em qualquer linha → rollback 1.R e diagnosticar. O item 9 tem fallback
  pré-aprovado no design.md (policy sargável por `app.allowed_countries`).

### 1.R Rollback QA
Reverter o commit do YAML na `stage` (volta `enlite_app` + flag off) → push → deploy.
Nada no banco precisa mudar (ENABLE sem FORCE é inerte para o owner).

## FASE 2 — promover as migrations 268-273 para o `main`
Só depois do gate 1.4 inteiro verde + janela de observação em QA (mínimo 48h úteis).
- PR `feat/abac-pais-migrations` → `main`. ⚠️ **Merge no main = deploy automático de PRD**
  (sem gate manual). As migrations rodam no boot — mas em prd `enlite_app` precisa
  conseguir rodá-las: conferir ANTES, no banco de prd, `rolcreaterole` (269 cria roles) e
  ownership (271 faz ALTER TABLE — precisa ser owner: é).
- Pós-deploy prd: health 200 · `schema_migrations` com 268-273 · **comportamento
  inalterado** (app segue `enlite_app`, owner, sem FORCE — as policies existem e não
  valem) · rodar a migration 273 concede membership aos usuários que já existem.
- Smoke de não-regressão: kanban, lista de workers, dossiê, 1 cron.

## FASE 3 — PRD em modo relatório (task 4.2, 1 semana)
Sem mudar identidade nenhuma. Ligar SÓ o log comparativo (query paralela conta quantas
linhas cada listagem staff perderia com o filtro de país) e o aviso de caminho
não-classificado. Revisar o log **diariamente**; cada caminho esquecido vira fix antes da
fase 4. Saída da fase: 7 dias com zero caminho novo no log.

## FASE 4 — PRD: a virada (tasks 4.3-4.5)
Espelho exato da FASE 1, no `backend-prd.yml`/`backend-mcp-prd.yml` (branch `main`):
1. Claims no IdP de **prd** (`FIREBASE_PROJECT_ID=enlite-prd npm run claims:country`) —
   staff é 100% AR hoje; conferir a lista com o time antes.
2. IAM `secretAccessor` nos 2 secrets de prd para a SA do serviço + import no terraform.
3. Trocar `DB_USER`/`DB_PASSWORD`/flag no YAML → merge (ação isolada, confirmação na hora).
4. Ordem por tabela (design decisão 5): `patients`+satélites → **observar 48h** →
   `workers`+satélites de PII. `FORCE` só aqui, se decidido, e tabela a tabela.
5. Task 4.4: `ALTER TABLE patients ALTER COLUMN country DROP DEFAULT` + corrigir os ~30
   seeds de e2e que inserem sem country (grep `INSERT INTO patients` em tests/) — SÓ
   depois da virada estável.
6. Task 4.5: smoke e2e-prod com paciente BR de teste (ler [[teste-nunca-toca-canal-real]]
   e [[monitor-que-escreve-em-prod]] — marca+purga) + conferir `resource_access_log`.
7. Medição pós-virada (6.2): p95 vs baseline publicado antes/depois; acessos cross-país
   da 1ª semana.

### 4.R Rollback PRD (= evento de segurança, lex C5)
Reverter o YAML no main (volta `enlite_app`) → merge → deploy. **Obrigatório**: registro
no diário (quem/quando/por quê), log estruturado, e re-abrir a change. As policies ficam
no banco (inertes de novo) — não dropar nada no rollback.

## Checklist de "não errar em PRD" (colar no PR da fase 4)
- [ ] FASE 1 inteira verde em QA, com evidência linkada
- [ ] FASE 3: 7 dias de relatório sem caminho novo
- [ ] claims atribuídos em prd ANTES do merge da virada
- [ ] IAM dos secrets concedido E importado no terraform (plan segue "No changes")
- [ ] YAML certo no branch certo (main), nunca `gcloud update` manual
- [ ] janela combinada com o time (painel pisca no deploy) + quem monitora a 1ª hora
- [ ] rollback ensaiado em QA pelo menos 1 vez (1.R executado de verdade)
- [ ] lex re-rodado sobre o estado final (task 6.1)
