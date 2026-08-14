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
- [x] Migration 273 (GRANT membership) — registrada em `schema_migrations` no stg. ⚠️ Estar
      registrada **não prova concedido**: a 273 só concede a quem existia quando ela rodou,
      e o runner registra qualquer execução sem erro. A prova é
      `psql -f scripts/assert-abac-membership.sql` (concede + verifica `pg_auth_members` +
      falha se faltar) — **passo autoritativo, e nunca um INSERT manual em
      `schema_migrations`**, que daria conflito de PK.
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
> **DECIDIDO (D112, 14/08): DOIS POOLS no processo — não SET ROLE.** Um login user
> membro das duas roles permitiria escalação via SQL injection (`RESET ROLE; SET ROLE
> app_system`) — classe de vulnerabilidade documentada em postgres-hackers e SEM
> mitigação no core. Com pools separados por credencial (padrão node-postgres #1659), a
> fronteira fica no Postgres: pior caso de injeção no caminho de staff é ficar preso ao
> que `app_runtime` já pode. Envs novas: `DB_SYSTEM_USER`/`DB_SYSTEM_PASSWORD` (ausentes
> = pool único, comportamento de hoje). ⚠️ Dimensionar MEDINDO `max_connections` na
> instância (`SELECT setting FROM pg_settings WHERE name='max_connections'`) — stg
> db-f1-micro ≈ 25! — e multiplicar pools × instâncias Cloud Run (max 3 stg / 10 prd).
> O serviço `worker-functions-mcp` é 100% sistema → só vira `DB_USER=enlite_system`,
> sem mecanismo nenhum.
Gate: e2e novo cobrindo **conexão única** (o e2e de 13/08 usou dois pools separados e não
cobre este caso) + prova de que staff não escala para sistema.

### 1.0b Pré-requisito de banco: membership CONCEDIDA (não só "273 aplicada")
Antes de trocar a identidade da conexão em 1.3, rodar no banco do ambiente:
```bash
psql -f scripts/assert-abac-membership.sql   # concede + verifica pg_auth_members + falha se faltar
```
Este é o **passo autoritativo** em qualquer ambiente onde `enlite_runtime`/`enlite_system`
nasceram DEPOIS do deploy (stg e prd, pelo runbook) — que é o caso normal. A migration 273
só concede a quem já existia quando ela rodou; nesse caminho ela emite
`WARNING: [abac] CONCESSÃO PENDENTE`, o runner a registra em `schema_migrations` por não ter
havido erro, e ela não volta a rodar. **Linha em `schema_migrations` ≠ GRANT feito.**

⚠️ **Nunca "consertar" com INSERT manual em `schema_migrations`**: conflito de chave
primária com a linha que o runner já gravou, e o GRANT continuaria sem existir.

⚠️ Com `COUNTRY_RLS_ENABLED=true` a aplicação **recusa subir** sem a membership (assert de
boot) — o serviço vai a crash-loop em vez de servir sem isolamento. Ordem obrigatória:
assert de membership **antes** do push de 1.3.

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

⚠️ **Silêncio no item 10 NÃO é prova de limpo** (achado do gate 14/08): o detector é cego a
tudo fora de request — handlers de outbox/domain-events abrem ALS próprio sem `dbSession` e
**não aparecem** neste log; e o `sanitizeRoute` colapsa segmento legítimo ≥20 chars em `:id`
(`sync-clickup-patients` etc.), degradando o diagnóstico. Antes do flip: conferir outbox e
processadores de evento À MÃO (rodar um ciclo de cada e olhar o efeito), e tratar esses dois
itens da lista de MEDIUMs abertos do review — eles afetam o INSTRUMENTO da virada.
- NO-GO em qualquer linha → rollback 1.R e diagnosticar. O item 9 tem fallback
  pré-aprovado no design.md (policy sargável por `app.allowed_countries`).

### 1.R Rollback QA — **ENSAIADO em 14/08, com 3 aprendizados que mudam o procedimento**

O ensaio real (flip → rollback → roll-forward, revisões 00053→00056→00057) provou que o
procedimento ingênuo ("reverter o commit e push") **NÃO funciona**, por três razões:

1. **`git revert` sozinho não desliga nada.** O `deploy-cloudrun` fazia MERGE de
   `env_vars`: chave removida do YAML **persistia** da revisão anterior. O revert criou uma
   revisão híbrida (`enlite_app` + flag e `DB_SYSTEM_USER` herdadas) que o assert de boot
   recusou — o tráfego nunca saiu da revisão boa (fail-closed protegendo), mas o rollback
   não rolava. **Consertado na raiz**: os workflows de stg têm
   `env_vars_update_strategy: overwrite` + `secrets_update_strategy: overwrite` — o YAML é
   o conjunto COMPLETO. (⚠️ prd ainda NÃO tem overwrite — adicionar na fase 4, no mesmo
   commit do flip de prd.)
2. **Rollback é commit de VALORES EXPLÍCITOS, não revert cego.** Revert de cadeia dá
   conflito com commits vizinhos; o que funciona é editar o YAML para o estado-alvo
   (`DB_USER=enlite_app`, `DB_PASSWORD=enlite-ar-db-password:latest`, remover
   `DB_SYSTEM_*`/`COUNTRY_RLS_ENABLED`/`*_POOL_MAX`/`ABAC_MAIN_POOL_ROLE`) e commitar.
3. **O commit de rollback DEVE tocar `worker-functions/**`** (ex.: nota neste runbook):
   o workflow tem `paths: worker-functions/**` e o job de deploy tem
   `if: github.event_name == 'push'` — commit só de YAML não dispara, e
   `workflow_dispatch` pula o deploy.

4. **(gate 1.4, 14/08) Valor de env com VÍRGULA não sobrevive ao action.** O
   deploy-cloudrun separa `env_vars` por vírgula sem escapar valores:
   `MCP_PRINCIPAL_NAMES=triage-service,claude-code` virou `…=triage-service` + env
   fantasma `claude-code=` (por isso o bearer do claude-code dava 401 no MCP stg).
   O MESMO estrago está vivo em `ALLOWED_MEDIA_HOSTS` (stg e prd) — hoje só
   `api.twilio.com` vale, `*.twilio.com`/`chatwoot.enlite.health` viraram envs
   fantasmas. Corrigir junto com a fase 4. Regra: valor de env em workflow NUNCA
   leva vírgula.
5. **(gate 1.4, 14/08) O deploy do MCP stg REUSA a imagem do `backend-stg.yml` no
   MESMO SHA.** Commit que não toca `worker-functions/**` não builda imagem → o
   `gh workflow run backend-mcp-stg.yml` falha com `Image not found`. Ordem: commit
   tocando `worker-functions/**` → esperar o build do backend-stg → dispatch do MCP.

Passos provados: editar YAMLs para os valores pré-flip + tocar `worker-functions/**` →
push na `stage` → aguardar deploy → conferir `DB_USER=enlite_app` e ZERO env de
RLS/system na revisão nova + health 200. O MCP tem rollback PRÓPRIO (mesmos valores no
`backend-mcp-stg.yml`) e deploy por `gh workflow run backend-mcp-stg.yml --ref stage`.
Nada no banco precisa mudar (ENABLE sem FORCE é inerte para o owner).
Em PRD, executar isto é **evento de segurança** (lex C5) — registro obrigatório.

## FASE 2 — promover as migrations 268-273 para o `main`
Só depois do gate 1.4 inteiro verde + janela de observação em QA (mínimo 48h úteis).
- PR `feat/abac-pais-migrations` → `main`. ⚠️ **Merge no main = deploy automático de PRD**
  (sem gate manual). As migrations rodam no boot — mas em prd `enlite_app` precisa
  conseguir rodá-las: conferir ANTES, no banco de prd, `rolcreaterole` (269 cria roles) e
  ownership (271 faz ALTER TABLE — precisa ser owner: é).
- Pós-deploy prd: health 200 · `schema_migrations` com 268-273 · **comportamento
  inalterado** (app segue `enlite_app`, owner, sem FORCE — as policies existem e não valem).
- ⚠️ **A membership em prd NÃO sai deste deploy.** Os usuários `enlite_runtime`/
  `enlite_system` de prd foram criados em 13/08, depois do boot que registrar a 273 — a
  migration vai emitir `WARNING: [abac] CONCESSÃO PENDENTE` e seguir. Conceder de verdade é
  passo próprio, autoritativo, executado no banco de prd:
  ```bash
  psql -f scripts/assert-abac-membership.sql
  ```
  Exigência de saída: `membership verificada em pg_auth_members … OK`. Sem isso, a fase 4
  não pode nem começar — o app com `COUNTRY_RLS_ENABLED=true` recusa subir. **Não registrar
  nada à mão em `schema_migrations`** (conflito de PK; a linha já existe).
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
— ROLLBACK DRILL 1.R executado em 14/08/2026 (ver runbook-abac-virada §1.R)
— ROLL-FORWARD do drill executado em 14/08/2026: flip restaurado
