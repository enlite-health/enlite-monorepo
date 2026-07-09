# Enlite Monorepo — Guia para Claude

## Sobre o Projeto

A **Enlite** é uma plataforma de saúde que gerencia o ciclo de vida completo de **Acompanhantes Terapêuticos (ATs)** — desde a captação e seleção até a supervisão diária da atuação com pacientes.

### Estrutura do Monorepo

```
enlite-monorepo/
  enlite-frontend/   → Painel administrativo da Enlite (React + Vite + TypeScript + Tailwind)
  worker-functions/  → Backend de recrutamento e operação (Node.js + Express + TypeScript + PostgreSQL + Firebase)
  terraform/         → IaC (apenas stg — prd ainda manual via gcloud)
  docs/              → Sprints, roadmaps, runbooks, FOLLOWUPS (TDs)
```

Cada projeto tem seu próprio `CLAUDE.md` com regras específicas. **Sempre leia o CLAUDE.md do projeto-alvo antes de modificar qualquer código.**

### Serviços em repos separados (FORA deste monorepo)

A Enlite adota estratégia **multi-repo** pra microservices com ciclo de vida/deploy independentes. Quando precisar mexer em algum dos serviços abaixo, **NÃO procure aqui** — vá pro repo correto:

| Serviço | Path local | Repo GitHub | Stack | O que é |
|---|---|---|---|---|
| **triage-service** | `/Users/gabrielstein-dev/projects/enlite/triage-service/` | `enlite-health/triage-service` | NestJS 11 + Vertex AI (Gemini) + Chatwoot + Twilio | Microservice de triagem de mensagens WhatsApp. Consome `worker-functions` via MCP (preferencial) ou HTTP (legado). |

**Integração `triage-service` ↔ `worker-functions`:**
- Canal preferencial: **MCP** (Model Context Protocol) em `/mcp/v1` no service `worker-functions-mcp` (Cloud Run, ingress=internal)
- Canal legado: HTTP em `/api/admin/workers/:id/{current-interview,available-vacancies,documents/ingest-from-url}` (marcado `@deprecated`, será removido após PR 7 estável em prod ≥7 dias — ver `docs/FOLLOWUPS.md` TD-033)
- Feature flag no triage: `USE_MCP_GATEWAY=true` ativa o canal MCP

Detalhes completos em `docs/SPRINT_MCP_INTERNAL_SERVER.md`.

### Política multi-repo

Decisão arquitetural: cada novo microservice nasce em repo próprio na org `enlite-health`. Não estender o monorepo com novos serviços. Detalhes em `docs/FOLLOWUPS.md` TD-034.

---

## Regras de Negócio — Fluxo Worker (AT)

### 1. Postulação e Pré-Seleção
- Documentação obrigatória: Currículo, certificados, RG/CPF, Antecedentes Penais, comprovante MEI.
- Seguro de Responsabilidade Civil quando disponível.
- Cadastro via plataforma ou canais de captação para triagem inicial.

### 2. Seleção e Contratação
- Entrevista por Valores: foco em honestidade, integridade e compromisso (técnica se ensina, valores não).
- Termo de Confidencialidade e Não Divulgação de Dados obrigatório pós-aprovação.
- Vínculo formalizado via contrato MEI.

### 3. Formação e Capacitação (Onboarding)
- Formação teórica e prática (remota síncrona e assíncrona) com casos clínicos e dinâmicas vivenciais.
- Critério de conclusão: mínimo 75% de frequência + trabalho final integrador.

### 4. Matching (Alocação AT ↔ Paciente)
- Entrevista de Matching: garantir que o AT é o mais indicado para o paciente (patologia + perfil pessoal).
- Critérios: disponibilidade, zoneamento (proximidade geográfica), hotspots de atendimento.

### 5. Operação Diária
- **Comunicação**: Grupos de WhatsApp por caso (AT + supervisores + coordenadores; sem paciente/familiar).
- **Check-in/Check-out GPS**: Registro de jornada via app para automação de folha de ponto e transparência de localização.
- **Relatórios Diários**: Obrigatório via plataforma. Alimentam gráficos de evolução do paciente e são revisados pela estrutura clínica.
- **Supervisão 24h**: Estrutura de supervisão em tempo real disponível para emergências ou dúvidas técnicas.

---

## Arquitetura Compartilhada

Ambos os projetos seguem **Clean Architecture**:

| Camada | Backend (worker-functions) | Frontend (enlite-frontend) |
|---|---|---|
| Domain | `src/domain/` — entidades, interfaces | `src/domain/` — entidades, interfaces |
| Application | `src/application/` — use cases | `src/application/` — use cases |
| Infrastructure | `src/infrastructure/` — repos, services | `src/infrastructure/` — API clients, Firebase |
| Interface | `src/interfaces/` — controllers, rotas | `src/presentation/` — pages, components |

### Regras Universais
- **Máximo 400 linhas por arquivo** de implementação.
- Controllers/pages não contêm lógica de negócio.
- Validação com **Zod** em ambos os projetos.
- **TypeScript strict** em ambos.
- Nunca commitar `.env` — usar `.env.example` como referência.
- **Testes visuais obrigatórios**: todo teste de frontend DEVE incluir screenshot assertion via Playwright (`toHaveScreenshot()`) para garantir e validar a mudança visual. Testes sem validação visual são considerados incompletos.

---

## Migrations

Arquivos SQL ficam em `worker-functions/migrations/` com prefixo numérico sequencial (ex: `104_recreate_worker_availability.sql`). Migrações são **aditivas** — nunca dropar tabela/coluna sem deprecação.

### Produção (Cloud SQL)

```bash
./scripts/run-migration-prod.sh worker-functions/migrations/104_recreate_worker_availability.sql
```

Requer: `gcloud` autenticado no projeto `enlite-prd`, `cloud-sql-proxy` e `psql` instalados, e acesso ao secret `enlite-ar-db-password` no Secret Manager. O script conecta via Cloud SQL Proxy na porta 5435, executa o SQL e encerra o proxy automaticamente.

### Local / Docker (E2E)

```bash
cd worker-functions && node scripts/run-migrations-docker.js
```

Usa `DATABASE_URL` (default: `postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e`). Runner idempotente com tabela `schema_migrations` — migrations já aplicadas são puladas.

---

## Base de Conhecimento (RAG Local)

O monorepo possui um MCP de RAG local (`local-rag`) que indexa documentos grandes em `docs/` e permite busca semântica por trechos relevantes. Isso evita carregar documentos inteiros no contexto.

### Como usar

1. **Indexar documento**: Use a tool `ingest_file` do MCP `local-rag` passando o caminho do arquivo (PDF, DOCX, TXT, MD) dentro de `docs/`.
2. **Buscar informação**: Use `query_documents` com a pergunta em linguagem natural. Retorna chunks relevantes com arquivo fonte e score.
3. **Listar documentos**: Use `list_files` para ver o que já foi indexado.

### Regras para agentes

- **Antes de responder sobre regras de negócio, documentação clínica, contratos ou processos operacionais**, consulte o RAG com `query_documents`.
- **Responda SOMENTE com base nos trechos retornados**. Se não encontrar informação suficiente, diga explicitamente: _"Não encontrei essa informação na documentação indexada."_
- **Sempre cite o arquivo fonte** ao usar informação do RAG (ex: "Conforme docs/manual-operacional.pdf").
- **Nunca invente informações** que não estejam nos trechos retornados.
- Documentos grandes (manuais, contratos, políticas) devem ser colocados em `docs/` e indexados via `ingest_file` — nunca cole o conteúdo inteiro no contexto.

### Documentos para indexar

Coloque na pasta `docs/` qualquer documento de referência:
- Manuais operacionais
- Políticas e regras de negócio
- Contratos e termos padrão
- Documentação clínica e protocolos
- Guias de formação/onboarding

---

## Orquestração de Agentes

Este monorepo usa subagentes especializados em `.claude/agents/`. O fluxo padrão para features cross-project é:

```
1. PO analisa requisito + regras de negócio → refina e decompõe
2. Architect valida viabilidade arquitetural → parecer de schema e código (reuso vs criação)
3. Backend Dev implementa (respeitando worker-functions/CLAUDE.md + parecer do Architect)  → skill: bug-shield
4. Frontend Dev implementa (respeitando enlite-frontend/CLAUDE.md + parecer do Architect) → skills: bug-shield (+ pixel-loop se houver Figma)
5. QA valida (testes E2E + unitários + lint + type-check + critérios de aceite)            → skill: flow-guard
6. PO revisa o diff final contra as regras de negócio e critérios de aceite
```

As skills abaixo NÃO são opcionais nem "chamadas se der" — cada etapa TEM uma skill associada. Ver "Skills obrigatórias por etapa".

### Etapa 2 — Parecer do Architect (obrigatória para mudanças de schema ou novos domínios)

Antes de implementar, o Architect analisa o schema do banco e o código existente para:
- Confirmar que não há duplicação de tabelas/colunas/lógica
- Propor reuso máximo da arquitetura existente
- Vetar criações desnecessárias com justificativa
- Indicar quais arquivos modificar vs criar

Só após o parecer do Architect a implementação deve começar. Se o Architect vetar, o PO reavalia.

### Etapa 6 — Revisão Final do PO (obrigatória)

Após o QA aprovar, o PO **sempre** faz uma revisão final antes de considerar a tarefa concluída:
- Verifica se o diff implementado atende **todos** os critérios de aceite do plano original
- Confere se nenhuma regra de negócio foi violada ou esquecida
- Valida que a arquitetura foi respeitada (Clean Architecture, limites de camada)
- Se encontrar problemas, devolve ao dev responsável com descrição clara do gap
- Só após essa revisão a tarefa é considerada **DONE**

### Quando usar cada agente

| Situação | Agente |
|---|---|
| Feature nova que impacta regras de negócio | Começar pelo PO |
| Feature que altera schema ou cria tabela/domínio | PO → **Architect** → Dev |
| Dúvida se algo já existe no banco/código | **Architect** direto |
| Bug isolado no backend | Backend Dev direto |
| Bug isolado no frontend | Frontend Dev direto |
| Validação de qualidade pós-implementação | QA |
| Feature cross-project (API + tela) | PO → **Architect** → Backend Dev → Frontend Dev → QA → PO (revisão final) |

### Skills obrigatórias por etapa (chamar SEM ambiguidade)

Regra dura: **skill se invoca pela ferramenta Skill, pelo NOME EXATO abaixo.** Nunca "achar" qual serve pela vibe, nunca inventar nome. Se o gatilho da linha bateu, a skill é obrigatória — não é sugestão. Se nenhuma linha bate, não force skill nenhuma.

| Gatilho objetivo (quando é verdade) | Skill EXATA | Momento |
|---|---|---|
| Vou escrever/alterar lógica de implementação (feature ou bugfix, back ou front) | `bug-shield` | ANTES de escrever o código |
| Bugfix a partir de um report/sintoma | `bug-shield` | ANTES do fix (força grep de callers = causa-raiz) |
| Componente/tela nova ou alterada QUE TEM design no Figma | `pixel-loop` | DEPOIS de implementar o visual, antes do QA |
| Vou dar uma feature/PR como pronta, ou o user pediu "garantir que funciona"/"sem bugs"/"testar o fluxo" | `flow-guard` | ANTES de declarar DONE / abrir PR |
| Sessão longa (~70% de contexto), antes de /clear ou /compact, ou "salva o contexto"/"handoff" | `context-keeper` | ANTES de compactar/limpar |

Precedência quando mais de um gatilho bate numa feature completa: `bug-shield` (durante) → `pixel-loop` (se Figma) → `flow-guard` (gate final). `context-keeper` é ortogonal, dispara por tamanho de sessão.

**Quem invoca:** o **Claude orquestrador (principal)**, sempre. Os subagentes (`frontend-dev`, `backend-dev`, `qa` etc.) NÃO têm a ferramenta Skill — não conseguem chamar skill. Logo o padrão é:

1. Orquestrador invoca a skill da etapa (ex: `bug-shield`) → a skill injeta o protocolo no contexto.
2. Orquestrador dispatcha o subagente **carregando esse protocolo no prompt do dispatch** (ex: "siga o red-first e o grep de callers do bug-shield: …").
3. O subagente devolve a evidência estruturada que a skill exige; o orquestrador confere.

**Certeiro = determinístico:** a linha da tabela decide, não o julgamento do modelo. Se o gatilho bateu e a skill não rodou (orquestrador esqueceu de invocar, ou dispatchou o dev sem o protocolo), a etapa está em violação — reabrir e rodar. Skills não substituem os agentes (PO/Architect/QA continuam); elas padronizam O QUE cada etapa executa e QUAL evidência volta.
