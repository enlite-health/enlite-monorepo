# EnLite Health Solutions — Arquitetura de Infraestrutura Escalável

**Versão:** 2.0 | Abril 2026  
**Escopo:** Infraestrutura GCP, Microserviços, Banco de Dados, Compliance Multi-Jurisdicional  
**Regulamentações:** LGPD (Brasil), HIPAA (EUA), GDPR (UE), Ley 25.326 (Argentina)  
**Fontes de Compliance:** HHS.gov/HIPAA (Security Rule, Privacy Rule, Mental Health Special Topics), Guia LGPD (Gov.BR), GDPR Arts. 4, 9, 25, 32, 35

---

## 1. Análise do Estado Atual e Gaps Identificados

### 1.1 O que já existe (documentado nos fluxos F03/F04/F05)

A arquitetura de banco de dados atual cobre os fluxos de cadastro com 5 sistemas de storage bem definidos: Google Cloud Identity Platform para autenticação, PostgreSQL com schemas `iam` e `negocio`, Cloud Healthcare API (FHIR R4) para PHI, Cloud Storage para mídia, e Cloud KMS para criptografia de colunas PII. O multi-tenancy por região (BR/US/EU/AR) via `iam.tenants.region` já está projetado para determinar a lei aplicável.

### 1.2 Gaps críticos para uma infraestrutura de produção escalável

**Infraestrutura e Rede:**
- Não há definição de VPC, subnets, e isolamento de rede
- Falta configuração de WAF, DDoS protection, e egress controls
- Não há estratégia de multi-region ou disaster recovery documentada
- Falta definição de ambientes (dev/staging/prod) e CI/CD

**Microserviços:**
- Toda a lógica está descrita como "NestJS" monolítico sem decomposição em serviços
- Não há definição de API Gateway, service mesh, ou comunicação inter-serviço
- Falta estratégia de event-driven architecture para operações assíncronas
- Não há circuit breakers, retries, ou resiliência definidos

**Compliance e Auditoria:**
- HIPAA Security Rule exige risk analysis documentada, incident response plan, contingency plan, e avaliação periódica — nenhum está implementado
- HIPAA exige Business Associate Agreements (BAA) com todos os subprocessadores — não há tracking
- LGPD exige Relatório de Impacto à Proteção de Dados (RIPD) — não há template
- GDPR exige Data Protection Impact Assessment (DPIA), Data Protection Officer (DPO), e Records of Processing Activities (RoPA) — não estão previstos
- Não há sistema de consent management para diferentes jurisdições
- Falta auditoria de acesso granular (quem acessou o quê, quando)
- Não há mecanismo de data retention/deletion por jurisdição
- Breach notification workflow não está definido (72h GDPR, "without unreasonable delay" HIPAA)

**Backoffice:**
- Não há estrutura para o painel administrativo mencionado
- Falta RBAC granular para operações administrativas
- Não há sistema de logs de auditoria acessível para compliance officers

---

## 2. Arquitetura de Infraestrutura GCP — Visão Geral

### 2.1 Organização de Projetos GCP

```
enlite-org (Organization)
├── enlite-shared-infra        ← VPC compartilhada, DNS, KMS, Secret Manager
├── enlite-prod                ← Workloads de produção
├── enlite-staging             ← Espelho de prod para validação
├── enlite-dev                 ← Desenvolvimento
├── enlite-data-prod           ← Cloud SQL, Cloud Healthcare API, BigQuery
├── enlite-data-staging        ← Dados de staging (anonimizados)
└── enlite-audit               ← Logs de auditoria, SIEM, compliance reports
```

**Por quê separar projetos?** O HIPAA Security Rule (45 CFR 164.312) exige controle de acesso técnico granular. Separar projetos GCP permite aplicar IAM policies distintas: a equipe de dev nunca acessa dados de produção, e o projeto de auditoria tem acesso read-only com retenção estendida de logs.

### 2.2 Rede e Isolamento (VPC)

```
Shared VPC (enlite-shared-infra)
│
├── Subnet: public (10.0.1.0/24)
│   └── Cloud Load Balancer + Cloud Armor (WAF)
│
├── Subnet: services (10.0.2.0/24)
│   └── GKE Cluster (microserviços)
│   └── Cloud Run (serviços stateless)
│
├── Subnet: data (10.0.3.0/24)
│   └── Cloud SQL (PostgreSQL 16)
│   └── Memorystore (Redis)
│
├── Subnet: phi (10.0.4.0/24)   ← ISOLADA
│   └── Cloud Healthcare API
│   └── FHIR Proxy Service
│
└── Subnet: mgmt (10.0.5.0/24)
    └── Bastion Host
    └── Cloud Build agents
```

**Regras de firewall críticas:**
- Subnet `phi` aceita conexões APENAS da subnet `services` via Private Service Connect, porta 443 com mTLS
- Subnet `data` aceita conexões APENAS da subnet `services`
- Subnet `public` expõe APENAS o Load Balancer (portas 80/443)
- Todo tráfego entre subnets é logado via VPC Flow Logs (retenção: 6 anos — requisito HIPAA 45 CFR 164.316)
- Egress filtrado: serviços só podem acessar APIs externas whitelistadas

### 2.3 Segurança de Perímetro

| Camada | Serviço GCP | Função |
|--------|-------------|--------|
| DDoS | Cloud Armor | Proteção L3/L4/L7, rate limiting |
| WAF | Cloud Armor Rules | OWASP Top 10, SQLi, XSS |
| TLS | Certificate Manager | Certificados gerenciados, TLS 1.3 obrigatório |
| API Gateway | Apigee ou Kong (GKE) | Rate limiting, auth, throttling, API versioning |
| Service Mesh | Istio (Anthos) | mTLS entre serviços, observability, traffic policies |
| Secrets | Secret Manager | Rotação automática de credenciais |
| Encryption | Cloud KMS | CMEK para todos os serviços (Cloud SQL, GCS, Healthcare API) |

---

## 3. Arquitetura de Microserviços

### 3.1 Decomposição de Domínio

A decomposição segue Domain-Driven Design (DDD) com bounded contexts alinhados aos fluxos existentes:

| Microserviço | Responsabilidade | Stack | Dados Acessados |
|-------------|-----------------|-------|-----------------|
| `auth-service` | Autenticação, sync Identity Platform, JWT validation | NestJS | Schema `iam` |
| `profile-service` | CRUD de perfis, onboarding F03, consent management | NestJS | Schema `negocio` (profiles, user_context) |
| `patient-service` | Onboarding F04, proxy management, scheduling | NestJS | Schema `negocio` (patient_*) |
| `provider-service` | Onboarding F05, quiz, coverage areas, matching | NestJS | Schema `negocio` (provider_*) |
| `phi-service` | Proxy para Cloud Healthcare API, de-identification | NestJS | Cloud Healthcare API (FHIR R4) EXCLUSIVAMENTE |
| `media-service` | Upload/download de mídia, signed URLs | NestJS | Cloud Storage (GCS) |
| `notification-service` | Email, push, SMS | NestJS | Redis (fila), templates |
| `audit-service` | Logs de compliance, relatórios RIPD/DPIA | NestJS | BigQuery, Cloud Logging |
| `consent-service` | Gerenciamento de consentimentos por jurisdição | NestJS | Schema `compliance` (NOVO) |
| `backoffice-bff` | Backend-for-Frontend do painel administrativo | NestJS | Agrega dados de todos os serviços |
| `scheduler-service` | Matching paciente-prestador, agendamento | NestJS | Schemas `negocio`, Redis |
| `analytics-service` | BI, métricas ICHOM, dashboards | Python/FastAPI | BigQuery (dados de-identified) |

### 3.2 Comunicação Entre Serviços

**Padrão Primário: Síncrono via gRPC (intra-cluster)**
- Comunicação service-to-service dentro do GKE usa gRPC com mTLS via Istio
- Timeout padrão: 5s, retry: 3x com exponential backoff
- Circuit breaker: Istio DestinationRule (5 falhas consecutivas = open por 30s)

**Padrão Secundário: Assíncrono via Pub/Sub**
- Eventos de domínio publicados em topics do Cloud Pub/Sub
- Dead-letter topics para mensagens que falharam 5x
- Mensagens retidas por 7 dias

```
Eventos Pub/Sub:
├── user.created           → notification-service, audit-service
├── user.consent.updated   → consent-service, audit-service
├── patient.onboarded      → phi-service, scheduler-service
├── provider.onboarded     → scheduler-service, notification-service
├── phi.accessed           → audit-service (OBRIGATÓRIO - HIPAA)
├── phi.modified           → audit-service (OBRIGATÓRIO - HIPAA)
├── data.deletion.requested → todos os serviços (LGPD/GDPR)
├── breach.detected        → audit-service, notification-service (72h GDPR)
└── consent.revoked        → todos os serviços relevantes
```

**Padrão Terciário: API REST (externo)**
- Apenas o API Gateway expõe REST para clientes (mobile app, web app, backoffice)
- Versionamento via URL path: `/api/v1/...`
- Rate limiting: 100 req/min por usuário, 1000 req/min por tenant

### 3.3 Fluxo de Request Típico

```
Mobile App
    │ HTTPS/TLS 1.3
    ▼
Cloud Load Balancer + Cloud Armor (WAF)
    │
    ▼
API Gateway (Apigee/Kong)
    │ JWT validation, rate limit, routing
    ▼
Istio Ingress Gateway
    │ mTLS
    ▼
[Microserviço Target]
    │ gRPC (mTLS) ──→ [Outro Microserviço]
    │ Pub/Sub      ──→ [Evento Assíncrono]
    │
    ▼
[Data Layer] ← Cloud SQL / Healthcare API / GCS
```

---

## 4. Banco de Dados — Evolução para Produção

### 4.1 Cloud SQL (PostgreSQL 16) — Configuração de Produção

| Configuração | Valor | Justificativa Compliance |
|-------------|-------|-------------------------|
| Versão | PostgreSQL 16 | Suporte a SCRAM-SHA-256, Row-Level Security nativo |
| Instância | `db-custom-8-32768` | 8 vCPUs, 32GB RAM — sizing para ~10K usuários iniciais |
| Storage | SSD, 100GB, auto-resize | Performance de I/O para queries geográficas (PostGIS) |
| High Availability | Regional (failover automático) | HIPAA: contingency plan (45 CFR 164.308(a)(7)) |
| Backups | Automáticos, retenção 365 dias | HIPAA: backup plan; LGPD: retenção documentada |
| Point-in-Time Recovery | Habilitado, 7 dias de logs | HIPAA: disaster recovery |
| Encryption at rest | CMEK via Cloud KMS | HIPAA: technical safeguards (45 CFR 164.312) |
| Encryption in transit | TLS 1.3 obrigatório, SSL mode `verify-full` | HIPAA: transmission security |
| Private IP | Sim, sem IP público | HIPAA: access control |
| Audit Logs | pgAudit habilitado, todos schemas | HIPAA: audit controls (45 CFR 164.312(b)) |
| Connection | Cloud SQL Auth Proxy (IAM-based) | Zero passwords em código |

### 4.2 Novo Schema: `compliance` — Consent & Audit

```sql
-- Schema dedicado para dados de compliance
CREATE SCHEMA compliance;

-- Gerenciamento de consentimentos por jurisdição
CREATE TABLE compliance.consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES iam.users(id),
    tenant_id UUID NOT NULL REFERENCES iam.tenants(id),
    consent_type TEXT NOT NULL,
        -- 'terms_of_service' | 'privacy_policy' | 'phi_processing'
        -- 'data_sharing' | 'marketing' | 'research_data_use'
    jurisdiction TEXT NOT NULL,
        -- 'lgpd' | 'hipaa' | 'gdpr' | 'ley25326'
    version TEXT NOT NULL,
        -- Versão do documento aceito: 'v1.0', 'v1.1'
    status TEXT NOT NULL DEFAULT 'active',
        -- 'active' | 'revoked' | 'expired'
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    ip_address INET,
    user_agent TEXT,
    document_hash TEXT NOT NULL,
        -- SHA-256 do documento aceito — prova imutável
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_consents_user ON compliance.consents(user_id);
CREATE INDEX idx_consents_type_status ON compliance.consents(consent_type, status);

-- Log de acesso a dados sensíveis (PHI/PII)
CREATE TABLE compliance.access_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID NOT NULL,
    actor_role TEXT NOT NULL,
    resource_type TEXT NOT NULL,
        -- 'fhir_patient' | 'fhir_condition' | 'pii_cpf' | 'profile' | 'provider'
    resource_id TEXT NOT NULL,
    action TEXT NOT NULL,
        -- 'read' | 'create' | 'update' | 'delete' | 'export' | 'de_identify'
    justification TEXT,
        -- Motivo do acesso (exigido para PHI)
    tenant_id UUID NOT NULL,
    ip_address INET,
    service_name TEXT NOT NULL,
        -- Qual microserviço originou
    request_id TEXT,
        -- Correlation ID para tracing
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Particionar por mês para performance
CREATE INDEX idx_access_logs_actor ON compliance.access_logs(actor_user_id, created_at);
CREATE INDEX idx_access_logs_resource ON compliance.access_logs(resource_type, resource_id);

-- Requisições de exercício de direitos (LGPD Art. 18, GDPR Arts. 15-22)
CREATE TABLE compliance.data_subject_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES iam.users(id),
    tenant_id UUID NOT NULL REFERENCES iam.tenants(id),
    request_type TEXT NOT NULL,
        -- 'access' | 'rectification' | 'erasure' | 'portability'
        -- 'restriction' | 'objection' | 'automated_decision_review'
    jurisdiction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
        -- 'pending' | 'in_progress' | 'completed' | 'denied'
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deadline_at TIMESTAMPTZ NOT NULL,
        -- LGPD: 15 dias; GDPR: 30 dias; calcular por jurisdição
    completed_at TIMESTAMPTZ,
    denial_reason TEXT,
    handled_by UUID REFERENCES iam.users(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registro de incidentes de segurança
CREATE TABLE compliance.security_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES iam.tenants(id),
    severity TEXT NOT NULL,
        -- 'low' | 'medium' | 'high' | 'critical'
    incident_type TEXT NOT NULL,
        -- 'unauthorized_access' | 'data_breach' | 'system_compromise'
        -- 'phi_exposure' | 'pii_exposure' | 'service_disruption'
    description TEXT NOT NULL,
    affected_records_count INTEGER,
    affected_data_types TEXT[],
    detected_at TIMESTAMPTZ NOT NULL,
    contained_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    notification_required BOOLEAN,
    authority_notified_at TIMESTAMPTZ,
        -- GDPR: 72h para DPA; HIPAA: 60 dias para HHS;
        -- LGPD: prazo razoável para ANPD
    users_notified_at TIMESTAMPTZ,
    root_cause TEXT,
    remediation_actions TEXT,
    reported_by UUID REFERENCES iam.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Business Associate Agreements tracking (HIPAA)
CREATE TABLE compliance.baa_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_name TEXT NOT NULL,
    service_description TEXT NOT NULL,
    baa_signed_at DATE,
    baa_expires_at DATE,
    data_types_shared TEXT[] NOT NULL,
        -- '{phi, pii, operational}'
    gcp_service BOOLEAN DEFAULT false,
        -- true se for serviço GCP coberto pelo BAA do Google
    review_frequency_months INTEGER DEFAULT 12,
    last_review_at DATE,
    next_review_at DATE,
    status TEXT NOT NULL DEFAULT 'active',
    document_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Data retention policies por jurisdição
CREATE TABLE compliance.retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_category TEXT NOT NULL,
        -- 'medical_records' | 'audit_logs' | 'consent_records'
        -- 'user_profiles' | 'provider_documents' | 'session_data'
    jurisdiction TEXT NOT NULL,
    retention_period_years INTEGER NOT NULL,
    legal_basis TEXT NOT NULL,
        -- Artigo/seção da lei que exige
    deletion_method TEXT NOT NULL,
        -- 'hard_delete' | 'anonymize' | 'pseudonymize'
    requires_approval BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.3 Row-Level Security (RLS) — Multi-Tenancy

```sql
-- Ativar RLS em TODAS as tabelas com dados de tenant
ALTER TABLE negocio.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE negocio.patient_onboardings ENABLE ROW LEVEL SECURITY;
-- ... (todas as tabelas)

-- Policy: usuário só vê dados do seu tenant
CREATE POLICY tenant_isolation ON negocio.profiles
    USING (user_id IN (
        SELECT id FROM iam.users
        WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
    ));

-- O microserviço seta o tenant antes de cada query:
-- SET LOCAL app.current_tenant_id = '<tenant_uuid>';
-- SET LOCAL app.current_user_id = '<user_uuid>';
```

### 4.4 pgAudit — Configuração para HIPAA

```sql
-- postgresql.conf (via Cloud SQL flags)
pgaudit.log = 'read, write, ddl'
pgaudit.log_catalog = off
pgaudit.log_relation = on
pgaudit.log_statement_once = on

-- Audit específico para schemas sensíveis
ALTER ROLE app_service SET pgaudit.log = 'all';

-- Logs exportados automaticamente para Cloud Logging → BigQuery
-- Retenção: 6 anos (HIPAA 45 CFR 164.316(b)(2)(i))
```

---

## 5. Cloud Healthcare API — Configuração de Produção

### 5.1 FHIR Store Configuration

```
Dataset: enlite-health-{env}
├── FHIR Store: patient-records
│   ├── FHIR Version: R4
│   ├── Encryption: CMEK (Cloud KMS)
│   ├── Streaming to BigQuery: habilitado (de-identified)
│   ├── Consent enforcement: habilitado
│   └── Audit Logs: Cloud Audit Logs (Admin + Data Access)
│
└── De-identification Config
    ├── Remove: names, dates of birth, identifiers
    ├── Generalize: dates to year, zip to 3 digits
    └── Output: BigQuery dataset para analytics
```

### 5.2 Consent Enforcement (FHIR Consent Resource)

A Cloud Healthcare API suporta enforcement nativo de consentimento via FHIR Consent resources. Cada paciente terá um Consent resource que controla quem pode acessar seus dados:

```json
{
  "resourceType": "Consent",
  "status": "active",
  "scope": {
    "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/consentscope", "code": "patient-privacy" }]
  },
  "patient": { "reference": "Patient/{fhir_patient_id}" },
  "dateTime": "2026-04-12",
  "policy": [{ "uri": "https://enlite.health/privacy-policy/v1.0" }],
  "provision": {
    "type": "permit",
    "actor": [
      {
        "role": { "coding": [{ "code": "PRCP" }] },
        "reference": { "reference": "Practitioner/{provider_fhir_id}" }
      }
    ],
    "purpose": [
      { "system": "http://terminology.hl7.org/CodeSystem/v3-ActReason", "code": "TREAT" }
    ]
  }
}
```

---

## 6. Mapeamento de Compliance Multi-Jurisdicional

### 6.1 Matriz de Requisitos Técnicos por Regulamentação

| Requisito Técnico | HIPAA (Security Rule) | LGPD | GDPR | Implementação GCP |
|---|---|---|---|---|
| **Criptografia em repouso** | 45 CFR 164.312(a)(2)(iv) - addressable | Art. 46 - medidas de segurança | Art. 32(1)(a) | Cloud KMS CMEK em todos os serviços |
| **Criptografia em trânsito** | 45 CFR 164.312(e)(1) | Art. 46 | Art. 32(1)(a) | TLS 1.3 obrigatório, mTLS inter-serviço |
| **Controle de acesso** | 45 CFR 164.312(a)(1) - required | Art. 46 | Art. 32(1)(b) | IAM + Cerbos + RLS PostgreSQL |
| **Audit trail** | 45 CFR 164.312(b) - required | Art. 37 (RIPD) | Art. 30 (RoPA) | pgAudit + Cloud Audit Logs + BigQuery |
| **Autenticação** | 45 CFR 164.312(d) - required | Implícito (segurança) | Art. 32 | Identity Platform + JWT + MFA |
| **Integridade** | 45 CFR 164.312(c)(1) - required | Art. 46 | Art. 32(1)(b) | Checksums, FHIR versioning |
| **Backup/Recovery** | 45 CFR 164.308(a)(7) - required | Art. 46 | Art. 32(1)(c) | Cloud SQL automated backups, 365 dias |
| **Risk analysis** | 45 CFR 164.308(a)(1)(ii)(A) - required | Art. 50 (RIPD) | Art. 35 (DPIA) | Documento formal + revisão anual |
| **Incident response** | 45 CFR 164.308(a)(6) - required | Art. 48 (72h razoável) | Art. 33 (72h) | Workflow automatizado via Pub/Sub |
| **Breach notification** | 45 CFR 164.404-410 (60 dias) | Art. 48 (prazo razoável ANPD) | Art. 33 (72h DPA), Art. 34 (titulares) | Security incidents table + alertas |
| **Minimum necessary** | 45 CFR 164.514(d) | Art. 6 III (necessidade) | Art. 5(1)(c) (minimização) | RBAC por campo, views filtradas |
| **Data retention/deletion** | 45 CFR 164.316(b)(2)(i) - 6 anos | Art. 16 (eliminação) | Art. 17 (right to erasure) | Retention policies table + jobs programados |
| **Consentimento** | Não primário (treatment exception) | Art. 7-8 (quando aplicável) | Art. 6-9 (explicit para health) | Consent service + FHIR Consent |
| **Portabilidade** | N/A | Art. 18 V | Art. 20 | Export API (JSON/FHIR bundle) |
| **BAA/DPA** | 45 CFR 164.308(b) - required | Art. 39 (operador) | Art. 28 (processor) | BAA registry table + Google BAA |
| **DPO/Privacy Officer** | Security Official (164.308(a)(2)) | Encarregado (Art. 41) | DPO (Art. 37-39) | Cargo designado + acesso ao audit-service |
| **Privacy by Design** | Implícito (Security Rule) | Art. 46 §2 | Art. 25 | Arquitetura de serviços segregados |

### 6.2 Ações por Tenant/Região

| Região do Tenant | Lei Primária | Consentimento PHI | Notificação Breach | Retenção Mínima | Autoridade |
|---|---|---|---|---|---|
| `br` | LGPD | Explícito (Art. 11 - dado sensível de saúde) | Prazo razoável → ANPD | Lei específica do setor | ANPD |
| `us` | HIPAA | Treatment exception (TPO) | 60 dias → HHS OCR + titulares | 6 anos (Security Rule) | HHS OCR |
| `eu` | GDPR | Explícito (Art. 9(2)(a)) | 72h → DPA + titulares se high risk | Conforme lei nacional do estado-membro | DPA local |
| `ar` | Ley 25.326 | Consentimento informado | Sem prazo definido (boa prática: 72h) | Conforme finalidade | AAIP |

### 6.3 HIPAA — Checklist de Implementação Técnica

Baseado na pesquisa realizada em hhs.gov/hipaa:

**Administrative Safeguards (45 CFR 164.308):**
- [ ] Risk Analysis documentada e revisada anualmente
- [ ] Security Official designado
- [ ] Workforce security: background checks, access termination procedures
- [ ] Security awareness training para toda a equipe
- [ ] Security incident procedures documentadas e testadas
- [ ] Contingency plan: backup, disaster recovery, emergency mode operation
- [ ] BAA com Google Cloud (já disponível), Apigee, e qualquer subprocessador
- [ ] Evaluation periódica (anual mínimo)

**Physical Safeguards (45 CFR 164.310):**
- [ ] Facility access controls (GCP data centers — coberto pelo BAA do Google)
- [ ] Workstation use policies para equipe de desenvolvimento
- [ ] Device and media controls para disposal de dados

**Technical Safeguards (45 CFR 164.312):**
- [ ] Access control: unique user ID (Identity Platform), emergency access procedure
- [ ] Audit controls: pgAudit + Cloud Audit Logs + BigQuery retention
- [ ] Integrity controls: FHIR resource versioning, checksums
- [ ] Person authentication: MFA para acesso a PHI (Identity Platform + Authenticator)
- [ ] Transmission security: TLS 1.3, mTLS inter-serviço

**Mental Health Specific (conforme HHS guidance):**
- [ ] PHI de saúde mental segue as mesmas regras do HIPAA Privacy Rule
- [ ] Psychotherapy notes (se implementados futuramente) requerem autorização separada
- [ ] Disclosure para familiares: consent-based ou professional judgment (já modelado no FHIR Consent)
- [ ] Substance use disorder records (42 CFR Part 2): proteções ADICIONAIS se aplicável

---

## 7. Estratégia de Dados — Fluxo Completo

### 7.1 Classificação de Dados

| Classificação | Exemplos | Storage | Criptografia | Acesso | Retenção |
|---|---|---|---|---|---|
| **PHI** (Protected Health Info) | Diagnósticos, condições, tratamentos | Cloud Healthcare API (FHIR) | CMEK + at-rest + in-transit | phi-service APENAS, com justificativa | Conforme jurisdição |
| **PII Sensível** | CPF, documentos profissionais | PostgreSQL (colunas criptografadas) | Cloud KMS envelope encryption | Serviço owner + backoffice com audit | Enquanto conta ativa + retenção legal |
| **PII** | Nome, email, telefone, endereço | PostgreSQL (schema negocio) | At-rest (Cloud SQL default) + in-transit | Serviço owner, filtrado por RLS | Enquanto conta ativa |
| **Operacional** | Preferências, quiz answers, matching | PostgreSQL (schema negocio) | At-rest + in-transit | Serviço owner, filtrado por RLS | Enquanto conta ativa |
| **Mídia** | Fotos, vídeos, documentos | Cloud Storage (GCS) | CMEK + signed URLs | media-service | Enquanto conta ativa |
| **Audit** | Logs de acesso, incidentes | BigQuery + Cloud Logging | At-rest (Google default) | audit-service + compliance officer | 6 anos mínimo |
| **Analytics** | Dados de-identified | BigQuery | At-rest | analytics-service | Indefinido (anonimizado) |

### 7.2 Fluxo de Dados — Onboarding Paciente (F04) como exemplo

```
1. Mobile App → API Gateway → patient-service
   [Dados: nome, nascimento, CPF, diagnóstico, endereço]

2. patient-service:
   a. Valida JWT (tenant_id, user_id, role)
   b. Separa dados por classificação:
      - PHI (diagnóstico) → gRPC → phi-service
      - PII Sensível (CPF) → criptografa com Cloud KMS → PostgreSQL
      - PII (nome, endereço) → PostgreSQL
      - Operacional (insurance, scheduling) → PostgreSQL

3. phi-service:
   a. Cria FHIR Patient resource (se não existe)
   b. Cria FHIR Condition resource (diagnóstico)
   c. Retorna fhir_patient_id → patient-service
   d. Publica evento: phi.created → Pub/Sub

4. patient-service:
   a. Salva fhir_patient_id como ponteiro em negocio.patient_onboardings
   b. Publica evento: patient.onboarded → Pub/Sub

5. audit-service (assíncrono via Pub/Sub):
   a. Registra acesso em compliance.access_logs
   b. Registra consentimento em compliance.consents

6. consent-service:
   a. Cria FHIR Consent resource
   b. Registra em compliance.consents
```

---

## 8. Backoffice — Estrutura para Administração

### 8.1 Módulos do Backoffice

| Módulo | Funcionalidade | Permissão Mínima |
|---|---|---|
| **Dashboard** | Métricas operacionais, KPIs por tenant | `admin`, `manager` |
| **Gestão de Usuários** | CRUD usuários, ativar/suspender, assign roles | `admin` |
| **Gestão de Tenants** | Criar/editar tenants, configurar região/jurisdição | `super_admin` |
| **Gestão de Providers** | Aprovar/rejeitar prestadores, validar documentos | `admin`, `manager` |
| **Compliance Center** | Visualizar audit logs, data subject requests, incidentes | `compliance_officer`, `admin` |
| **Consent Management** | Visualizar/revogar consentimentos, versionar políticas | `compliance_officer` |
| **BAA Registry** | Gerenciar contratos com subprocessadores | `compliance_officer`, `legal` |
| **FHIR Explorer** | Visualizar recursos FHIR (read-only, com audit) | `admin` (com MFA obrigatório) |
| **Reports** | Gerar relatórios RIPD/DPIA, métricas ICHOM | `admin`, `manager` |
| **Incident Response** | Registrar e gerenciar incidentes de segurança | `security_officer`, `admin` |

### 8.2 RBAC do Backoffice

```sql
-- Roles adicionais para backoffice (schema iam.roles)
INSERT INTO iam.roles (name, description) VALUES
('super_admin', 'Acesso total cross-tenant — uso restrito'),
('compliance_officer', 'Acesso a audit logs e compliance tools'),
('security_officer', 'Gestão de incidentes e security reviews'),
('legal', 'Acesso a BAA registry e data subject requests'),
('support', 'Visualização limitada para suporte ao usuário');
```

---

## 9. Observability e Monitoramento

### 9.1 Stack de Observability

| Pilar | Serviço | Configuração |
|---|---|---|
| **Logging** | Cloud Logging → BigQuery | Structured JSON, retenção 6 anos para compliance |
| **Metrics** | Cloud Monitoring + Prometheus (GKE) | Custom metrics por serviço, SLIs/SLOs definidos |
| **Tracing** | Cloud Trace + OpenTelemetry | Distributed tracing, correlation IDs em todos os requests |
| **Alerting** | Cloud Monitoring Alerting Policies | PagerDuty/Opsgenie para P1, Slack para P2-P4 |
| **Dashboards** | Grafana (GKE) + Looker (BigQuery) | Operacional (Grafana) + Compliance (Looker) |

### 9.2 SLOs Recomendados

| Serviço | Availability SLO | Latency P99 | Error Budget |
|---|---|---|---|
| auth-service | 99.95% | 200ms | 21.9 min/mês |
| phi-service | 99.99% | 500ms | 4.38 min/mês |
| patient-service | 99.9% | 300ms | 43.8 min/mês |
| API Gateway | 99.95% | 100ms | 21.9 min/mês |

---

## 10. CI/CD e Ambientes

### 10.1 Pipeline

```
Developer → GitHub PR
    │
    ▼
Cloud Build (CI):
    ├── Lint + Unit Tests
    ├── SAST (SonarQube/Snyk)
    ├── Container scan (Artifact Registry)
    ├── DAST (OWASP ZAP — staging)
    └── Compliance checks (policy-as-code via OPA/Gatekeeper)
    │
    ▼
Artifact Registry (imagens Docker verificadas)
    │
    ▼
Deploy (CD):
    ├── dev  → automático após merge em develop
    ├── staging → automático após merge em main
    └── prod → manual approval (2 approvers) + canary deploy
```

### 10.2 Infrastructure as Code

- **Terraform** para toda infraestrutura GCP (VPC, Cloud SQL, GKE, IAM)
- **Helm Charts** para deployments Kubernetes
- **OPA/Gatekeeper** para policies de segurança no cluster
- Estado do Terraform em Cloud Storage bucket criptografado com versionamento

---

## 11. Disaster Recovery e Business Continuity

| Cenário | RPO | RTO | Estratégia |
|---|---|---|---|
| Falha de instância Cloud SQL | 0 (HA replication) | < 60s | Failover automático regional |
| Perda de região GCP | 24h | 4h | Cross-region read replicas + restore de backup |
| Corrupção de dados | Point-in-time | 1h | PITR do Cloud SQL (7 dias de logs) |
| Ransomware/breach | 24h | 8h | Backups imutáveis em bucket separado + incident response |
| Falha de serviço individual | N/A | < 5min | Kubernetes self-healing + HPA |

---

## 12. Estimativa de Custos GCP (Fase Inicial — ~1000 usuários)

| Serviço | Especificação | Custo Estimado/mês (USD) |
|---|---|---|
| GKE Autopilot | Cluster regional, ~4 pods médios | ~$200 |
| Cloud SQL | db-custom-4-16384, HA, 50GB SSD | ~$350 |
| Cloud Healthcare API | FHIR store, ~5K resources | ~$50 |
| Cloud Storage | 50GB, 2 buckets | ~$5 |
| Cloud KMS | 3 chaves CMEK, ~10K operações/mês | ~$15 |
| Cloud Load Balancer + Armor | 1 LB, basic WAF rules | ~$50 |
| Cloud Pub/Sub | ~100K mensagens/mês | ~$5 |
| Cloud Logging + Monitoring | 10GB logs/mês | ~$25 |
| Secret Manager | ~20 secrets | ~$2 |
| Memorystore (Redis) | Basic, 1GB | ~$35 |
| Artifact Registry | ~5GB images | ~$5 |
| **TOTAL ESTIMADO** | | **~$740/mês** |

*Nota: valores aproximados baseados em pricing público do GCP. O custo escala com uso.*

---

## 13. Roadmap de Implementação Sugerido

**Fase 1 — Fundação (Meses 1-2):**
- Setup de projetos GCP e VPC
- Terraform para infraestrutura base
- Cloud SQL com schemas iam + negocio + compliance
- GKE cluster com auth-service e profile-service
- CI/CD pipeline básico

**Fase 2 — Core Services (Meses 3-4):**
- patient-service, provider-service, phi-service
- Cloud Healthcare API FHIR store
- Consent service com FHIR Consent
- Event-driven architecture (Pub/Sub)
- API Gateway configurado

**Fase 3 — Compliance & Security (Meses 4-5):**
- audit-service com BigQuery
- pgAudit configurado
- Cloud Armor WAF rules
- Istio service mesh com mTLS
- Risk Analysis documentada (HIPAA)
- RIPD/DPIA elaborados

**Fase 4 — Backoffice & Analytics (Meses 5-7):**
- backoffice-bff + frontend administrativo
- Compliance Center
- analytics-service com dados de-identified
- Dashboards operacionais e de compliance

**Fase 5 — Production Hardening (Meses 7-8):**
- Penetration testing
- Disaster recovery drills
- Performance testing
- BAA com Google Cloud assinado
- Security awareness training
- Go-live

---

*EnLite Health Solutions — Documento interno de arquitetura v2.0*  
*Baseado em: db_architecture F03/F04/F05, Teoria da Mudança, Plano de Negócios RIAT, Guia LGPD, HIPAA Security Rule (hhs.gov), GDPR Arts. 4/9/25/32/35*  
*Abril 2026*
