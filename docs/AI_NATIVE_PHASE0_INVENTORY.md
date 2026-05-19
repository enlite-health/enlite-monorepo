# AI Native — Fase 0: Inventário de Sistemas de IA

**Data:** 2026-05-11
**Escopo:** Mapear todo uso atual de LLM no `worker-functions`, classificar dados expostos, jurisdições afetadas e gaps regulatórios.
**Status:** Insumo para Catálogo `compliance.ai_systems` (Fase 1) e migração para AI Gateway (Fase 2).

---

## 1. Sumário executivo

- **5 serviços de produção chamam LLM hoje**, distribuídos entre **2 providers sem confirmação de BAA**:
  - Groq (`api.groq.com/openai/v1`) — 2 serviços
  - Gemini API público / Google AI Studio (`generativelanguage.googleapis.com/v1beta`) — 3 serviços
- **Nenhum dos 5 usa Vertex AI** (`aiplatform.googleapis.com`). A migração "Groq → Gemini" alegada anteriormente foi para o produto **errado** do ponto de vista regulatório (Gemini API público não está sob BAA do Google Cloud — Vertex AI está).
- **PHI e PII identificáveis vão em todos os prompts**: diagnóstico, dependency level, nome do paciente em PDFs, telefone, email, CUIT, casos ativos, histórico de rejeição.
- **Audit log de inferência = inexistente.** Apenas `console.log` com tags. Violação direta de HIPAA 45 CFR 164.312(b).
- **Regra interna `LLM nunca no path síncrono` (worker-functions/CLAUDE.md) é violada por 3 dos 5 serviços** — chamados dentro de request handlers HTTP.
- **Consent `AI_PROCESSING` não modelado.** Sem base legal específica para o tratamento via LLM.

**Decisão executiva tomada (TDR):** Manter operação atual com risco documentado, focando energia em terminar Fases 1+2 rápido. **EU AI Act não aplicável nos próximos 12 meses** (sem usuários UE planejados).

---

## 2. Inventário detalhado por serviço

### AI-001 — WorkerDeduplicationService (mesclagem de workers duplicados)

| Atributo | Valor |
|---|---|
| **Arquivo** | `worker-functions/src/infrastructure/services/WorkerDeduplicationService.ts` |
| **Endpoint LLM** | `https://api.groq.com/openai/v1/chat/completions` |
| **Provider** | Groq Cloud |
| **Modelo** | `process.env.GROQ_MODEL` (default `llama-3.3-70b-versatile`) |
| **BAA** | **❌ Não confirmado.** Groq Cloud não oferece BAA publicamente. |
| **Auth** | `Authorization: Bearer ${GROQ_API_KEY}` (env var, sem Secret Manager) |
| **Endpoint HTTP que dispara** | `POST /analytics/dedup/run` (`requireAdmin()`) + `runDeduplicationForWorkers()` pós-import |
| **Tipo de execução** | Síncrono via endpoint admin + síncrono inline pós-import (`runDeduplicationForWorkers`) |
| **Volume estimado** | Limit padrão 20 candidatos/run, 150ms sleep entre chamadas (≤ 30 req/min) |
| **Jurisdição** | Argentina (Ley 25.326) — workers só argentinos hoje |

**Dados enviados no prompt** (sistema + user):
- Nome (firstname + lastname) — descriptografado via KMS antes do prompt
- Telefone (10 ou 13 dígitos)
- Email
- CUIT/CUIL (identidade fiscal argentina = sensível, equivalente a CPF)
- `data_sources` (origem: Ana Care, Talentum, Planilla Operativa, Talent Search CSV)
- Motivo da detecção SQL (fuzzy match)

**Sanitização pré-prompt:** Nenhuma.
**Guardrails de output:** Parsing JSON com type guards, clamp confidence [0,1]. Sem detecção de PII no output. Sem hallucination check.
**Audit:** `console.log` com tag `[Dedup]`. Não persistido em BD.

**Gaps:**
- **GAP-HIPAA-1:** PII identificável saindo para provider sem BAA.
- **GAP-LGPD-1:** Sem consentimento específico para processamento via IA.
- **GAP-AUDIT-1:** Sem log persistido da operação no nível exigido (timestamp + agent + data accessed + outcome).

---

### AI-002 — MatchmakingLLMScorer (score AT × vaga)

| Atributo | Valor |
|---|---|
| **Arquivo** | `worker-functions/src/modules/matching/infrastructure/MatchmakingLLMScorer.ts` |
| **Orquestrador** | `worker-functions/src/modules/matching/infrastructure/MatchmakingService.ts` |
| **Endpoint LLM** | `https://api.groq.com/openai/v1/chat/completions` |
| **Provider** | Groq Cloud |
| **Modelo** | `process.env.GROQ_MODEL` (default `llama-3.3-70b-versatile`) |
| **BAA** | **❌ Não confirmado.** |
| **Auth** | `Authorization: Bearer ${GROQ_API_KEY}` |
| **Endpoint HTTP que dispara** | `POST /vacancies/:id/match` (via `VacancyMatchController`) |
| **Tipo de execução** | **Síncrono dentro do request handler** (response handler), top N workers, 100ms sleep entre chamadas |
| **Volume estimado** | topN default = 20 chamadas LLM por run de matching |
| **Jurisdição** | Argentina; pacientes argentinos |

**Dados enviados no prompt:**
- `job.diagnosis` (diagnóstico do paciente — **PHI clínico explícito**)
- `job.pathology_types` (diagnóstico vinda da tabela `patients`)
- `job.patientZone` (zoneamento — quasi-identificador geográfico)
- `job.scheduleDaysHours` (horários)
- `job.requiredSex`
- `worker.occupation`, `worker.workZone`, `worker.workerAddress`, `worker.interestZone`
- `distanceKm`
- `activeCases[]` — array de **case_number** + schedule_text de cada caso ativo do worker
- `worker.diagnosticPreferences` (preferências de diagnóstico declaradas)
- `worker.rejectionHistory` (mapa categoria → contagem de rejeições)
- `worker.avgQualityRating`
- Sexo do worker (descriptografado via KMS antes do prompt)

**Sanitização pré-prompt:** Parcial — nome do worker e do paciente **não estão** no prompt; `schedule_text` truncado em 80 chars. Mas case_number + diagnóstico + zona + horários combinados são re-identificáveis.
**Guardrails de output:** Clamp score [0,100], filter arrays para strings. Sem detecção de PII em `reasoning`, `strengths`, `red_flags`. **Risco real**: `reasoning` retornado pelo LLM é persistido em `worker_job_applications.internal_notes` — então um vazamento de PII pelo LLM vai direto pro DB.
**Audit:** `console.log` upstream em `MatchmakingService`. Não persistido.

**Gaps:**
- **GAP-HIPAA-2:** PHI clínico (diagnosis, pathology_types) saindo para provider sem BAA.
- **GAP-LGPD-2:** Decisão automatizada com efeito significativo (Art. 20 LGPD) — direito de revisão humana não exposto em API/UI.
- **GAP-CLAUDEMD-1:** Viola regra interna `LLM nunca no path síncrono — sempre background` (`worker-functions/CLAUDE.md` linha "Regras que nunca mudam"). Cada `POST /vacancies/:id/match` faz 20 chamadas Groq síncronas.
- **GAP-AUDIT-2:** Sem trail.
- **GAP-LEAK-1:** Resposta livre do LLM vai pro DB sem PII scan.

---

### AI-003 — GeminiVacancyParserService (texto/PDF livre → JSON estruturado)

| Atributo | Valor |
|---|---|
| **Arquivo** | `worker-functions/src/modules/integration/infrastructure/GeminiVacancyParserService.ts` |
| **Helpers** | `GeminiVacancyParserHelpers.ts`, `gemini-fetch.ts`, `gemini-vacancy-constants.ts` |
| **Endpoint LLM** | `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` |
| **Provider** | **Google AI Studio / Gemini API público** (NÃO Vertex AI) |
| **Modelo** | `process.env.GEMINI_MODEL` (default `gemini-2.5-pro`) |
| **BAA** | **❌ Não aplicável** — Gemini API público não está sob o BAA do GCP. Para BAA é preciso usar `aiplatform.googleapis.com` (Vertex AI). |
| **Auth** | `?key=${GEMINI_API_KEY}` na query string (env var) |
| **Endpoint HTTP que dispara** | `POST /admin/vacancies/parse` e `POST /admin/vacancies/parse-pdf` (via `VacancyTalentumController`); também síncrono no fluxo de criação manual via `generateFromVacancyData` |
| **Tipo de execução** | **Síncrono dentro do request handler** |
| **Volume estimado** | 1 chamada por vaga parsada (8192 maxOutputTokens) + 1 chamada retry se faltarem campos |
| **Jurisdição** | Argentina; coordenadora cola PDF/texto livre |

**Dados enviados no prompt:**
- **Modo `parseFromPdf`**: PDF inteiro em base64 — **PDF tipicamente contém nome do paciente, DNI, endereço, diagnóstico**. Tudo vai cru pra API público.
- **Modo `parseFromText`**: texto livre digitado/colado da coordenadora — pode conter qualquer coisa.
- **Modo `generateFromVacancyData`**: dados estruturados — diagnosis, dependency_level, service_type, city, state, horários, salário, observações.
- **System prompt** carregado do Google Drive (`PROMPT_DOC_ID_AT` / `PROMPT_DOC_ID_CUIDADOR`).

**Sanitização pré-prompt:** **Nenhuma.** O PDF inteiro vai em base64.
**Guardrails de output:** JSON schema validation forte (`VACANCY_RESPONSE_SCHEMA`). Sem PII scan.
**Audit:** `console.log` com tag `[GeminiParser]`. Tokens logados.

**Gaps:**
- **GAP-HIPAA-3 (CRÍTICO):** PDFs com PHI completo (nome, DNI, endereço, diagnóstico) saindo para endpoint público da Google sem BAA. É a maior exposição de PHI bruto no sistema hoje.
- **GAP-LGPD-3:** Tratamento de dado sensível (Art. 11 LGPD) sem consentimento granular nem RIPD documentado.
- **GAP-CLAUDEMD-2:** Viola regra `LLM nunca no path síncrono`.
- **GAP-PRESCREEN-1:** Output cru do LLM (prescreening questions, FAQ) vai pro DB e depois para Talentum (terceiro) sem revisão humana obrigatória.
- **GAP-RETENTION-1:** Sem política de retenção de prompts/respostas; Gemini API público pode usar dados para melhorar serviços (depende da policy de cada tenant).

---

### AI-004 — TalentumDescriptionService (descrição da vaga p/ publicar no Talentum)

| Atributo | Valor |
|---|---|
| **Arquivo** | `worker-functions/src/modules/integration/infrastructure/TalentumDescriptionService.ts` |
| **Endpoint LLM** | `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` |
| **Provider** | **Google AI Studio / Gemini API público** |
| **Modelo** | `process.env.GEMINI_MODEL` (default `gemini-2.5-pro`) |
| **BAA** | **❌ Não aplicável** (mesmo endpoint do AI-003) |
| **Auth** | `?key=${GEMINI_API_KEY}` |
| **Endpoint HTTP que dispara** | `POST /admin/vacancies/:id/talentum-description` (via `VacancyTalentumController`) + preview endpoint |
| **Tipo de execução** | **Síncrono dentro do request handler**; e também invocado por `PublishVacancyToTalentumUseCase` (publicação a terceiro) |
| **Volume estimado** | 1 chamada por publicação + 1 por preview |
| **Jurisdição** | Argentina; resultado vai para Talentum (terceiro) |

**Dados enviados no prompt:**
- `caseNumber`, `title`
- Diagnosis → variável `pathologyTypes` no prompt
- `dependencyLevel`
- `serviceDeviceTypes` (`patients.service_type`)
- `city`, `state` (sem street)
- `schedule`, `workSchedule`
- `requiredSex`, `requiredExperience`, `workerAttributes`
- `ageRangeMin`/`Max`, `providersNeeded`, `salaryText`, `paymentDay`

**Sanitização pré-prompt:** Parcial via instrução no system prompt ("NUNCA incluyas datos personales identificables del paciente"). **Defesa fraca** — prompt injection pode contornar. case_number + diagnóstico + cidade combinados re-identificam.
**Guardrails de output:** REFUSAL_MARKER detection (substring "generar una vacante para cuidador en otro chat") para evitar salvar refusal do Regla #7. JSON schema validation. **Sem PII scan no output** — texto livre gerado pelo LLM vai direto para `job_postings.talentum_description` e depois para Talentum (terceiro).
**Audit:** `console.log` com tag `[TalentumDesc]`. Tokens logados. Não persistido.

**Gaps:**
- **GAP-HIPAA-4:** PHI clínico em provider sem BAA.
- **GAP-LGPD-4:** Tratamento de dado sensível + compartilhamento com terceiro (Talentum) sem mapeamento RIPD.
- **GAP-CLAUDEMD-3:** Viola regra `LLM nunca no path síncrono`.
- **GAP-LEAK-2:** Output do LLM vai diretamente para sistema externo (Talentum) — se LLM alucinar dados do paciente, vazamento é para fora do perímetro Enlite.

---

### AI-005 — GeminiVacancyParser helper `parseFromTalentumDescription` (retry e reverse-parse)

| Atributo | Valor |
|---|---|
| **Arquivo** | `worker-functions/src/modules/integration/infrastructure/GeminiVacancyParserHelpers.ts` |
| **Endpoint LLM** | `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` |
| **Provider** | **Google AI Studio / Gemini API público** |
| **Modelo** | `process.env.GEMINI_MODEL` |
| **BAA** | **❌ Não aplicável** |
| **Auth** | `?key=${GEMINI_API_KEY}` |
| **Endpoint HTTP que dispara** | Indireto — invocado por AI-003 quando faltam campos (retry) e por fluxos de reverse-parse de descrição Talentum |
| **Tipo de execução** | Síncrono dentro do request handler do AI-003 |
| **Volume estimado** | 0-1 retry por chamada do AI-003 |
| **Jurisdição** | Argentina |

**Dados enviados:** Mesma classe de AI-003 (texto da descrição Talentum, faltantes apontados).
**Sanitização:** Nenhuma.
**Guardrails:** JSON schema validation.
**Audit:** `console.log`.

**Gaps:** Mesmos do AI-003 (CRÍTICO). Contabilizar separadamente porque tem call site independente e amplifica volume de chamadas ao endpoint público.

---

## 3. Matriz consolidada (visão rápida)

| ID | Serviço | Provider | BAA? | PHI no prompt? | Sync? | Audit DB? | Consent específico? | EU exposure? | Risco |
|---|---|---|---|---|---|---|---|---|---|
| AI-001 | WorkerDeduplication | Groq | ❌ | PII (nome, telefone, email, CUIT) | Background + admin sync | ❌ | ❌ | Não | Alto |
| AI-002 | Matchmaking LLM Score | Groq | ❌ | PHI (diagnosis, casos ativos) + PII | **Sync** | ❌ | ❌ | Não | **Crítico** (Art. 20 LGPD) |
| AI-003 | Vacancy Parser (PDF/texto) | Gemini API público | ❌ | **PHI bruto via PDF** | **Sync** | ❌ | ❌ | Não | **Crítico** |
| AI-004 | Talentum Description | Gemini API público | ❌ | PHI (diagnosis) + saída a terceiro | **Sync** | ❌ | ❌ | Não | **Crítico** (compartilhamento) |
| AI-005 | Vacancy Parser retry | Gemini API público | ❌ | Mesmo de AI-003 | **Sync** | ❌ | ❌ | Não | Crítico (amplifica AI-003) |

---

## 4. Mapa de gaps consolidados

### HIPAA Security Rule 45 CFR 164.312
- **164.312(a)(2)(iv) Encryption:** PII/PHI descriptografada em memória vai para provider externo sem BAA — quebra do controle de proteção.
- **164.312(b) Audit controls:** Nenhuma das 5 inferências tem log persistido com a granularidade exigida.
- **164.312(e)(1) Transmission security:** TLS existe, mas o requisito vai além — exige integridade do dado em trânsito sob controles de BA. Sem BAA, este controle não está vivo.

### LGPD (Brasil) — não diretamente aplicável hoje (operação Argentina), mas convergente
- **Art. 11** Dado sensível (saúde): exige consentimento específico ou hipótese legal.
- **Art. 20** Decisão automatizada: AI-002 (matching) toma decisão com efeito significativo; direito de revisão humana **não exposto**.
- **Art. 7º/Art. 14º** Base legal para tratamento: hoje genérica via `lgpd_consent_at`, sem AI processing como finalidade declarada.

### Ley 25.326 (Argentina)
- **Art. 5** Consentimento informado: hoje sem AI como finalidade explícita.
- **Art. 8** Dados sensíveis: idem ao LGPD Art. 11.
- **Art. 11/12** Cesión: AI-004 + AI-002 enviam dados para fora; sem mapeamento documentado.

### Regras internas Enlite
- **GAP-CLAUDEMD-1/2/3:** "LLM nunca no path síncrono — sempre background" violado em AI-002, AI-003, AI-004 (e AI-005 por derivação).

### Operacionais
- **Sem rate limit por tenant** — `MatchmakingService` faz 20 chamadas Groq por request.
- **Sem cost cap** — chave compartilhada por todos os fluxos.
- **Sem versionamento de prompt** — prompts mudam ao longo do tempo sem trilha auditável (exceto via Google Drive doc para AI-003).
- **Sem fallback / circuit breaker** — se Groq cair, matching falha; se Gemini API cair, parsing falha.

---

## 5. Casos de uso planejados (não implementados ainda)

| ID | Caso de uso | Status doc interno | Provider preferido |
|---|---|---|---|
| AI-P-001 | Análise de `Obs. ENCUADRE` (9.031 registros) | `ANALISE_PLANILLA_OPERATIVA.md` | A definir |
| AI-P-002 | Mineração LLM Wave 5 — qualidade de matching | `ROADMAP_RECRUITMENT_SYSTEM.md` | A definir |
| AI-P-003 | Triagem clínica inicial assistida | (não documentado) | Vertex AI / MedLM |
| AI-P-004 | Documentação assistida para AT (relatório diário) | (não documentado) | Vertex AI |
| AI-P-005 | Análise de relatórios diários (detecção precoce de risco) | (não documentado) | Vertex AI |
| AI-P-006 | Crisis detection / risk scoring | (não documentado) | Dedicado (AI-Safety) |

**Decisão necessária Fase 1:** Política que define que AI-P-003 a AI-P-006 **só** podem usar Vertex AI sob BAA.

---

## 6. Próximos passos imediatos

1. **TDR (Termo de Decisão Registrado)** — documentar formalmente a decisão executiva de operar com risco até Fases 1+2. Anexar este inventário. Responsável: AI Risk Officer (a ser nomeado).
2. **Confirmação BAA Google Cloud existente** — pedir ao jurídico cópia do BAA atual com Google Cloud e validar se inclui `aiplatform.googleapis.com`. Sem isso, a Fase 2 não destranca.
3. **Iniciar Fase 1 — Schema `compliance.ai_systems`** — modelar tabela e popular com as 5 linhas AI-001 a AI-005 deste inventário como ground truth inicial.
4. **Iniciar Fase 1 — Tópico Pub/Sub `ai.inference.completed`** — schema + consumer no `audit-service` para que **toda nova chamada LLM** (a partir da Fase 2) já entre auditada.
5. **Iniciar Fase 2 — Skeleton do `ai-gateway`** — microsserviço NestJS isolado em GKE+Istio com interface OpenAI-compatible, mesmo sem DLP ainda — só pra ter o caminho único pronto.

---

## 7. Decisões que precisam de input humano antes da Fase 1 começar

- **Quem é o AI Risk Officer?** Sem essa pessoa nomeada, a função GOVERN do NIST AI RMF não funciona.
- **Operação Brasil entra no roadmap?** Se sim, LGPD vira aplicável diretamente e o inventário ganha mais uma coluna de jurisdição.
- **Workers brasileiros já existem no banco?** Se houver workers cadastrados com endereço/CPF brasileiro, LGPD é aplicável agora, não no futuro.
- **Pacientes brasileiros já existem no banco?** Idem, com peso maior porque é dado sensível (Art. 11).

---

**Documento mantido como source of truth do estado AI atual. Atualizar a cada novo serviço LLM adicionado e a cada migração concluída.**
