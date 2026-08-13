# EnLite Health Solutions — Arquitetura e Implementação: Do Zero à Produção

**Plataforma de saúde mental multi-jurisdicional**
**Cloud:** Google Cloud Platform (GCP) | **Arquitetura:** Microserviços NestJS
**Jurisdições:** Brasil (LGPD), Estados Unidos (HIPAA), União Europeia (GDPR), Argentina (Ley 25.326)

**Fontes de compliance consultadas:**
- HIPAA: hhs.gov/hipaa — Security Rule (45 CFR 164.308-316), Privacy Rule, Breach Notification Rule (45 CFR 164.404-410), Mental Health Special Topics, Cybersecurity Guidance, BAA Provisions, NIST CSF Crosswalk
- LGPD: Guia de Boas Práticas LGPD (Gov.BR), Lei 13.709/2018
- GDPR: Arts. 3, 4, 5, 6, 7, 9, 17, 20, 25, 28, 30, 32, 33, 35, 37, 44-49
- Argentina: Ley 25.326 de Protección de Datos Personales, Ley 26.529 (Derechos del Paciente)

---
---

# BLOCO 0 — DECISÕES ESTRUTURAIS ANTES DE ESCREVER UMA LINHA DE CÓDIGO

Antes de abrir o console do GCP, existem decisões jurídicas e organizacionais que determinam toda a arquitetura. Estas decisões não são opcionais — são pré-requisitos legais. Pular esta etapa expõe a empresa a multas, processos, e inviabiliza operação em mercados regulados.

---

## 0.1 — Classificar a EnLite sob a HIPAA (Estados Unidos)

**Por que isso é necessário:**

A HIPAA (Health Insurance Portability and Accountability Act) é a lei federal dos EUA que protege informações de saúde. Ela se aplica a dois tipos de entidade: "covered entities" (planos de saúde, clearinghouses, e provedores que transmitem eletronicamente) e "business associates" (qualquer entidade que processa informações de saúde protegidas — PHI — em nome de uma covered entity). Conforme publicado em hhs.gov/hipaa, a seção 13401 do HITECH Act estende as mesmas obrigações de segurança aos business associates, que são diretamente responsáveis civil e criminalmente por violações.

A EnLite conecta pacientes a prestadores de saúde mental, coleta diagnósticos (que são PHI), e gerencia informações clínicas. A classificação determina quais obrigações legais se aplicam.

**O que fazer na prática:**

Se a EnLite processar PHI em nome de clínicas ou prestadores que são covered entities, ela é um **Business Associate**. Se a EnLite prestar serviços de saúde diretamente e faturar planos de saúde nos EUA, ela é uma **Covered Entity**. Quando um plano de saúde (payer) usar a plataforma, o payer é Covered Entity e a EnLite precisa de um contrato BAA (Business Associate Agreement) com ele.

A classificação mais provável é **Business Associate** dos prestadores e clínicas, com possibilidade de ser **Covered Entity** futuramente.

**Entregável:** Parecer jurídico de advogado americano especializado em health law classificando a EnLite.

---

## 0.2 — Classificar a EnLite sob a LGPD (Brasil)

**Por que isso é necessário:**

A LGPD (Lei Geral de Proteção de Dados, Lei 13.709/2018) classifica dados de saúde como "dados pessoais sensíveis" (Art. 5, II). O tratamento desses dados requer base legal específica (Art. 11). O Guia de Boas Práticas LGPD do governo federal define que o tratamento para tutela da saúde só é permitido quando realizado por profissionais de saúde, serviços de saúde ou autoridade sanitária. A EnLite precisa definir se atua como **Controlador** (quem decide a finalidade do tratamento) ou **Operador** (quem trata dados em nome do controlador).

**O que fazer na prática:**

A EnLite é **Controlador** quando coleta dados dos pacientes diretamente via app (fluxos de cadastro F03/F04). É **Operador** quando processa dados em nome de clínicas que usam o produto "Clinic". Quando um plano de saúde participa da plataforma, pode haver **Controlador conjunto** (Art. 5 VI) se o payer determina quais dados coletar para autorização de procedimentos.

Como Controlador, a EnLite deve: indicar um Encarregado de Dados (DPO) conforme Art. 41, elaborar Relatório de Impacto à Proteção de Dados (RIPD) conforme Art. 38, e garantir todos os direitos do titular (Art. 18 — acesso, correção, exclusão, portabilidade, etc.).

**Entregável:** Mapeamento de tratamento de dados para cada fluxo do app, com base legal documentada.

---

## 0.3 — Classificar a EnLite sob o GDPR (União Europeia)

**Por que isso é necessário:**

O GDPR se aplica sempre que a EnLite processar dados de residentes da UE, mesmo que a empresa não esteja sediada na Europa (Art. 3(2)). Dados de saúde são "special category data" (Art. 9) e requerem consentimento explícito ou outra base legal restrita. É obrigatório nomear um Data Protection Officer (DPO) quando se processam dados sensíveis em larga escala (Art. 37). É obrigatório realizar Data Protection Impact Assessment (DPIA) antes de qualquer processamento de alto risco com dados de saúde (Art. 35). A transferência de dados para fora da EEA (Espaço Econômico Europeu) requer mecanismos legais específicos: Standard Contractual Clauses (SCCs), adequacy decisions, ou Binding Corporate Rules (Arts. 44-49).

**O que fazer na prática:**

Para tenants localizados na UE: o consentimento precisa ser explícito, granular, e documentado (um checkbox genérico "aceito tudo" não é suficiente); o DPO deve ser nomeado antes de iniciar operações; se os dados forem armazenados em servidores fora da EEA (ex: us-east1 no GCP), SCCs são obrigatórios — o Google oferece SCCs em seus termos de serviço, mas isso precisa ser verificado e documentado formalmente; o DPIA deve ser elaborado e aprovado antes do lançamento.

**Entregável:** Nomeação de DPO, DPIA elaborado, modelo de consentimento granular para tenants EU, documentação de SCCs com Google Cloud.

---

## 0.4 — Classificar a EnLite sob a Ley 25.326 (Argentina)

**Por que isso é necessário:**

A EnLite opera na Argentina (RIAT Argentina). A Ley 25.326 de Protección de Datos Personales regula o tratamento de dados pessoais. Dados de saúde são dados sensíveis (Art. 2) que só podem ser tratados por estabelecimentos sanitários ou profissionais de saúde com sigilo profissional (Art. 7). A autoridade de enforcement é a AAIP (Agencia de Acceso a la Información Pública). Toda base de dados pessoais deve ser registrada perante a AAIP. A Ley 26.529 (Derechos del Paciente) complementa com requisitos específicos para prontuários médicos.

**O que fazer na prática:**

Para tenants com região `ar`: registrar as bases de dados (FHIR store e PostgreSQL) na AAIP; consentimento informado obrigatório para dados sensíveis; transferências internacionais para países sem adequação (como EUA) requerem consentimento expresso do titular ou cláusulas contratuais de proteção (Art. 12); prazo de 10 dias corridos para responder requisições de acesso do titular (Art. 14). A Argentina possui adequacy decision da UE, o que facilita transferências com a Europa.

**Entregável:** Registro na AAIP, modelo de consentimento informado em espanhol.

---

## 0.5 — Designar o Security Official / Encarregado / DPO

**Por que isso é necessário:**

A HIPAA Security Rule (45 CFR 164.308(a)(2)) exige que a entidade regulada designe formalmente um security official responsável por desenvolver e implementar políticas de segurança. A LGPD Art. 41 exige um Encarregado de Dados. O GDPR Art. 37 exige um DPO. Essas funções podem ser exercidas pela mesma pessoa, mas a designação precisa ser formal e documentada ANTES de implementar qualquer sistema.

**O que fazer na prática:**

1. Definir quem na equipe assume o papel (pode ser um dos fundadores inicialmente)
2. Documentar a nomeação em ata ou documento assinado
3. Publicar as informações de contato do Encarregado/DPO (exigido pela LGPD Art. 41 §1 e GDPR Art. 37(7))
4. Esta pessoa aprovará todas as decisões de arquitetura que envolvam dados sensíveis

**Entregável:** Documento de nomeação assinado pela diretoria.

---

## 0.6 — Treinar toda a equipe em segurança (HIPAA obrigatório)

**Por que isso é necessário:**

A HIPAA Security Rule (45 CFR 164.308(a)(5)(i)) exige que a entidade regulada treine TODOS os membros da equipe em políticas e procedimentos de segurança. Isso não é opcional e não se limita a quem acessa PHI diretamente — inclui desenvolvedores, designers, gestores, comercial. O treinamento deve ser documentado.

**O que fazer na prática:**

1. Desenvolver material de treinamento cobrindo: o que é PHI/PII, como são protegidos na plataforma, políticas de senha e MFA, política de dispositivos (nunca armazenar PHI em laptops pessoais), o que fazer ao detectar um incidente de segurança, e quais são as sanções por violação
2. Todos completam o treinamento ANTES de receber acesso a qualquer sistema de produção
3. Reciclar o treinamento anualmente e sempre que políticas mudarem
4. Registrar: quem foi treinado, quando, qual conteúdo, confirmação do participante

**Entregável:** Material de treinamento + registro de completude por funcionário.

---

## 0.7 — Política de Sanções por violação de segurança (HIPAA obrigatório)

**Por que isso é necessário:**

A HIPAA Security Rule (45 CFR 164.308(a)(1)(ii)(C)) exige que a entidade aplique sanções apropriadas contra membros da equipe que violem políticas de segurança. Sem uma sanction policy documentada, a entidade está em violação da HIPAA mesmo que nunca tenha um incidente real.

**O que fazer na prática:**

1. Documentar graduação de sanções: advertência verbal → advertência escrita → suspensão de acesso → desligamento
2. Listar exemplos de violações: compartilhar credenciais, acessar PHI sem justificativa, não reportar incidentes, desabilitar controles de segurança, copiar dados para dispositivos pessoais
3. Estabelecer procedimento de investigação com due process
4. Toda aplicação de sanção é registrada e arquivada

**Entregável:** Sanction Policy escrita, aprovada pelo Security Official, comunicada a toda equipe com confirmação de leitura.

---

## 0.8 — Assinar o BAA com o Google Cloud

**Por que isso é necessário:**

A HIPAA (45 CFR 164.308(b)(1)) exige que um Business Associate Agreement (BAA) esteja assinado antes que qualquer business associate crie, receba, mantenha, ou transmita ePHI. Conforme publicado em hhs.gov, o BAA deve incluir: que o BA cumprirá a Security Rule, reportará incidentes, garantirá que subcontratados sigam as mesmas restrições, e ao término do contrato devolverá ou destruirá todo PHI.

O Google Cloud oferece BAA para seus serviços, mas ele NÃO é automático — precisa ser aceito explicitamente no console. Além disso, o BAA cobre APENAS os serviços listados na documentação do Google. Usar um serviço GCP fora dessa lista para armazenar ou processar PHI é uma violação direta da HIPAA.

**O que fazer na prática:**

1. Acessar console.cloud.google.com → Organization Settings → Legal
2. Aceitar o Google Cloud BAA (HIPAA Business Associate Addendum)
3. Documentar quais serviços estão cobertos. Para a EnLite, usaremos: Cloud SQL, Cloud Healthcare API, Cloud Storage, Cloud KMS, Google Cloud Identity Platform, Cloud Logging, Cloud Pub/Sub, GKE, Cloud Run, Secret Manager, Cloud Armor
4. Verificar a lista atualizada em: https://cloud.google.com/security/compliance/hipaa-compliance
5. Regra absoluta: NUNCA colocar PHI em um serviço GCP que não esteja na lista do BAA

**Entregável:** BAA assinado com Google Cloud + planilha interna de serviços autorizados para PHI.

---

## 0.9 — Inventário de Dados e Registro de Atividades de Tratamento

**Por que isso é necessário:**

A LGPD Art. 37 exige que controlador e operador mantenham registro das operações de tratamento. O GDPR Art. 30 exige Records of Processing Activities (RoPA) documentando finalidades, categorias de dados, destinatários, transferências internacionais, prazos de retenção, e medidas de segurança. O Guia LGPD detalha que o inventário deve cobrir todas as fases do ciclo de vida: coleta, retenção, processamento, compartilhamento e eliminação. Esse inventário é a primeira coisa que uma autoridade reguladora pede numa fiscalização.

**O que fazer na prática — inventário por fluxo do app:**

| Campo | F03 (Cadastro) | F04 (Paciente) | F05 (Provider) | Payer Onboarding |
|---|---|---|---|---|
| **Finalidade** | Criar conta na plataforma | Registrar paciente e diagnóstico | Qualificar profissional | Registrar plano e rede credenciada |
| **Base legal LGPD** | Consentimento (Art. 7 I) | Tutela da saúde (Art. 11 II f) | Execução de contrato (Art. 7 V) | Execução de contrato (Art. 7 V) |
| **Base legal HIPAA** | N/A | Treatment/Operations (TPO) | Operations | Payment/Operations |
| **Base legal GDPR** | Consentimento explícito (Art. 9(2)(a)) | Necessidade médica (Art. 9(2)(h)) | Contrato (Art. 6(1)(b)) | Contrato (Art. 6(1)(b)) |
| **Base legal Ley 25.326** | Consentimento informado (Art. 5) | Profissional de saúde (Art. 7.3) | Contrato | Contrato |
| **Dados coletados** | Nome, email | Nome, CPF, diagnóstico, endereço | Nome, CPF, registro profissional | CNPJ/EIN, planos, coberturas |
| **Classificação** | PII | PII + PHI | PII | PII organizacional |
| **Onde é armazenado** | PostgreSQL (schemas iam, business) | PostgreSQL + Cloud Healthcare API (FHIR) | PostgreSQL + Cloud Storage | PostgreSQL + Cloud Healthcare API |
| **Criptografia** | At-rest (CMEK) | At-rest + Column-level (KMS) + FHIR CMEK | At-rest + Column-level (KMS) | At-rest + Column-level (KMS) |
| **Quem acessa** | Apenas o titular | Provider atribuído; payer (se elegibilidade ativa e consentimento) | Pacientes (via matching) | Providers da rede |
| **Retenção HIPAA** | Enquanto conta ativa | 6 anos (45 CFR 164.316) | Enquanto ativo + 6 anos | Duração do contrato + 6 anos |
| **Retenção LGPD** | Enquanto conta ativa | 20 anos (CFM Resolução 1821/2007) | Enquanto ativo + legal | Duração do contrato |
| **Retenção GDPR** | Enquanto conta ativa | 10 anos (conservador, varia por país) | Enquanto ativo + legal | Duração do contrato |
| **Retenção Ley 25.326** | Enquanto conta ativa | 10 anos (Ley 26.529 Art. 18) | Enquanto ativo | Duração do contrato |
| **Transferência internacional** | Dados em us-east1 | SCCs se tenant EU; consentimento se tenant AR→US | SCCs se tenant EU | SCCs se tenant EU |

**Entregável:** Inventário/RoPA completo, revisado anualmente e a cada novo tipo de tratamento.

---

## 0.10 — Risk Analysis Inicial (HIPAA obrigatório)

**Por que isso é necessário:**

A HIPAA Security Rule (45 CFR 164.308(a)(1)(ii)(A)) exige que entidades reguladas realizem uma avaliação precisa e completa dos riscos e vulnerabilidades potenciais à confidencialidade, integridade e disponibilidade do ePHI. O NIST Cybersecurity Framework tem um crosswalk oficial com a HIPAA Security Rule publicado pela OCR. Este NÃO é um checkbox burocrático — é um documento vivo que será revisado a cada mudança significativa na infraestrutura e no mínimo anualmente (45 CFR 164.306(e)).

**O que fazer na prática:**

O Risk Analysis inicial documenta 7 componentes:

1. **Inventário de ePHI:** Quais dados de saúde serão coletados — diagnósticos (FHIR Condition), dados de paciente (FHIR Patient), códigos ICD-10, e futuramente notas clínicas
2. **Fluxo de dados:** Como o ePHI se move — app móvel → API Gateway → phi-service → Cloud Healthcare API. O ePHI NUNCA passa pelo PostgreSQL
3. **Ameaças identificadas:** Acesso não autorizado, intercepção em trânsito, insider threats, ransomware, perda de dados, falha de infraestrutura, engenharia social
4. **Vulnerabilidades potenciais:** Cada ameaça combinada com cada ponto do fluxo de dados
5. **Probabilidade e impacto:** Classificar cada combinação ameaça × vulnerabilidade em uma matriz de risco
6. **Medidas de mitigação:** O que será implementado — criptografia CMEK, mTLS entre serviços, Row-Level Security no banco, audit logs, backup de 365 dias, isolamento de rede VPC, MFA
7. **Risco residual:** O que sobra após as mitigações — aceitar formalmente e documentar

**Procedimentos adicionais que devem constar no Risk Analysis:**

- **Emergency Access Procedure (45 CFR 164.312(a)(2)(ii)):** Se o sistema de permissões estiver indisponível, o Security Official pode ativar acesso emergencial temporário via flag no Identity Platform custom claims. Toda ação durante emergency access é logada com flag `is_emergency_access = true` e revisada obrigatoriamente em 24h
- **Automatic Logoff (45 CFR 164.312(a)(2)(iii)):** Sessões JWT expiram em 1 hora; refresh tokens em 24 horas; sessões do backoffice expiram em 15 minutos de inatividade para qualquer acesso a PHI
- **MFA (autenticação multifator):** Obrigatório para: todo acesso ao backoffice administrativo, todo acesso a PHI, todo acesso de usuários payer, todos os roles admin/manager/compliance_officer/security_officer. Implementado via Google Identity Platform MFA (TOTP ou SMS)

**Entregável:** Documento de Risk Analysis completo. A OCR disponibiliza ferramenta oficial de SRA (Security Risk Assessment) em: https://www.healthit.gov/topic/privacy-security-and-hipaa/security-risk-assessment-tool

---

## 0.11 — Procedimentos de Notificação de Breach

**Por que isso é necessário:**

Cada jurisdição tem regras diferentes para notificação de incidentes de segurança envolvendo dados pessoais/de saúde:

- **HIPAA** (Breach Notification Rule, 45 CFR 164.404-410): notificação a indivíduos afetados sem delay injustificado e no máximo em 60 dias após a descoberta; notificação ao HHS (Department of Health and Human Services); se 500 ou mais registros forem afetados numa única jurisdição geográfica, a mídia também deve ser notificada
- **GDPR** (Art. 33-34): notificação à Data Protection Authority (DPA) do país em até 72 horas após tomar conhecimento; notificação aos titulares se houver alto risco para seus direitos
- **LGPD** (Art. 48): comunicação à ANPD e ao titular em prazo razoável; deve descrever a natureza dos dados afetados, riscos, e medidas adotadas
- **Ley 25.326** (Argentina): sem prazo definido na lei, mas boa prática é seguir o padrão GDPR de 72h

**Importante:** Se o PHI estava criptografado com Cloud KMS e a chave não foi comprometida, pode não configurar "breach" sob a HIPAA (dados são considerados "secured" se criptografados conforme padrão NIST). Essa avaliação deve ser feita caso a caso pelo Security Official e documentada.

**O que fazer na prática — workflow automatizado:**

```
1. Incidente detectado (alerta automatizado ou report manual)
   → Registrado na tabela compliance.security_incidents
   → Evento Pub/Sub: breach.detected
   → Security Official notificado imediatamente (PagerDuty/Opsgenie)

2. Avaliação: é breach de unsecured PHI?
   → Se PHI estava criptografado (Cloud KMS) e chave não comprometida = NÃO é breach sob HIPAA
   → Se SIM: prosseguir para notificação

3. Determinar escopo e calcular deadlines:
   → Quantos registros afetados
   → Quais tipos de dados
   → Qual jurisdição de cada titular afetado
   → Calcular: HIPAA = descoberta + 60 dias; GDPR = descoberta + 72h; LGPD = prazo razoável

4. Executar notificações e documentar:
   → Notificar autoridades (HHS, DPA, ANPD) dentro dos deadlines
   → Notificar titulares afetados
   → Se ≥500 em uma jurisdição: notificar mídia (HIPAA)
   → Registrar datas de cada notificação na tabela de incidentes

5. Pós-incidente:
   → Root cause analysis
   → Implementar remediação
   → Atualizar o Risk Analysis
   → Conduzir tabletop exercise anual para testar o procedimento
```

**Entregável:** Procedimento de Breach Notification escrito, testado em tabletop exercise pelo menos uma vez ao ano.

---

## 0.12 — Política de Descarte de Mídias

**Por que isso é necessário:**

A HIPAA Security Rule (45 CFR 164.310(d)(2)) exige procedimentos para remoção de ePHI de mídias eletrônicas antes de reutilização e para descarte final de mídias. Mesmo em infraestrutura 100% cloud, a equipe pode ter dados em dispositivos locais.

**O que fazer na prática:**

Como toda a infraestrutura de produção está no GCP, o descarte físico de servidores é responsabilidade do Google (coberto pelo BAA). Mas a equipe da EnLite deve seguir estas regras:

1. NUNCA armazenar PHI ou PII em laptops, celulares, ou dispositivos pessoais
2. Se dados de desenvolvimento forem copiados localmente, usar volumes criptografados e apagar imediatamente após uso
3. Quando um funcionário sair da empresa: wipe completo de todos os dispositivos que tiveram acesso a sistemas da EnLite, documentado e assinado
4. Para exercer direito ao esquecimento (GDPR Art. 17, LGPD Art. 18 VI): destruir as chaves Cloud KMS associadas aos dados torna-os irrecuperáveis

**Entregável:** Media Disposal Policy documentada e incluída no treinamento de segurança (seção 0.6).

---
---

# BLOCO 1 — SETUP DA ORGANIZAÇÃO GCP E REDE

Tudo que segue assume que o Bloco 0 está 100% completo — classificações jurídicas definidas, DPO nomeado, equipe treinada, BAA assinado, Risk Analysis elaborado.

---

## 1.1 — Organização e Hierarquia de Projetos GCP

**Por que separar em múltiplos projetos:**

Cada projeto GCP é um boundary de permissões. Ao separar os projetos, garantimos que um desenvolvedor com acesso ao projeto de deploy de código NÃO consiga acessar o banco de dados de produção. Isso atende diretamente ao princípio de least privilege exigido pela HIPAA (access control, 45 CFR 164.312(a)) e ao princípio da necessidade da LGPD (Art. 6 III). Também facilita a auditoria — os logs de cada projeto são separados e podem ter políticas de retenção diferentes.

**Estrutura de projetos:**

```
enlite-org (GCP Organization — vinculada ao Google Workspace)
│
├── Folder: shared
│   └── enlite-shared
│       → VPC host, Cloud DNS, Cloud KMS keyrings, Artifact Registry
│
├── Folder: production
│   ├── enlite-prod-services
│   │   → GKE cluster, Cloud Run, API Gateway (código dos microserviços)
│   ├── enlite-prod-data
│   │   → Cloud SQL, Cloud Healthcare API, Cloud Storage (todos os dados)
│   └── enlite-prod-audit
│       → Sink de Cloud Logging, BigQuery para audit logs, dashboards compliance
│
├── Folder: staging
│   ├── enlite-staging-services
│   └── enlite-staging-data
│
└── Folder: development
    └── enlite-dev
        → Tudo junto em dev (simplicidade); dados SEMPRE fake/anonimizados
```

**Por que `prod-data` é separado de `prod-services`:** O time de backend precisa fazer deploy de código, mas deploy NÃO requer acesso ao banco de produção. Com projetos separados, o IAM de `prod-services` (onde roda o código) não inclui permissões no Cloud SQL ou Cloud Healthcare API (que ficam em `prod-data`). Os serviços acessam o banco via service accounts com escopo mínimo.

**Comandos:**

```bash
gcloud resource-manager folders create --display-name="shared" --organization=ORG_ID
gcloud resource-manager folders create --display-name="production" --organization=ORG_ID
gcloud resource-manager folders create --display-name="staging" --organization=ORG_ID
gcloud resource-manager folders create --display-name="development" --organization=ORG_ID

gcloud projects create enlite-prod-services --folder=PROD_FOLDER_ID
gcloud projects create enlite-prod-data --folder=PROD_FOLDER_ID
gcloud projects create enlite-prod-audit --folder=PROD_FOLDER_ID
gcloud projects create enlite-staging-services --folder=STAGING_FOLDER_ID
gcloud projects create enlite-staging-data --folder=STAGING_FOLDER_ID
gcloud projects create enlite-dev --folder=DEV_FOLDER_ID
gcloud projects create enlite-shared --folder=SHARED_FOLDER_ID

for p in enlite-prod-services enlite-prod-data enlite-prod-audit \
         enlite-staging-services enlite-staging-data enlite-dev enlite-shared; do
  gcloud billing projects link $p --billing-account=BILLING_ACCOUNT_ID
done
```

**Entregável:** Organização GCP criada com 7 projetos em 4 folders, billing vinculado.

---

## 1.2 — Habilitar APIs em Cada Projeto

**Por que habilitar apenas o necessário:** Cada API habilitada é uma superfície de ataque. Habilitamos APENAS as APIs que cada projeto precisa.

```bash
# enlite-prod-data (dados):
gcloud services enable sqladmin.googleapis.com healthcare.googleapis.com \
  storage.googleapis.com cloudkms.googleapis.com secretmanager.googleapis.com \
  --project=enlite-prod-data

# enlite-prod-services (código):
gcloud services enable container.googleapis.com run.googleapis.com \
  pubsub.googleapis.com cloudtrace.googleapis.com monitoring.googleapis.com \
  logging.googleapis.com artifactregistry.googleapis.com redis.googleapis.com \
  identitytoolkit.googleapis.com --project=enlite-prod-services

# enlite-prod-audit (auditoria):
gcloud services enable bigquery.googleapis.com logging.googleapis.com \
  --project=enlite-prod-audit

# enlite-shared (infra compartilhada):
gcloud services enable compute.googleapis.com dns.googleapis.com \
  cloudkms.googleapis.com artifactregistry.googleapis.com --project=enlite-shared
```

**Entregável:** APIs habilitadas apenas nos projetos que precisam delas.

---

## 1.3 — VPC e Subnets (Isolamento de Rede)

**Por que a rede é dividida em subnets:**

A HIPAA Security Rule (45 CFR 164.312(e)(1)) exige proteção técnica contra acesso não autorizado a ePHI transmitido pela rede. A LGPD Art. 46 exige medidas técnicas de proteção. Separar a rede em subnets com firewall rules específicas implementa isolamento: mesmo que um microserviço seja comprometido, o atacante não consegue alcançar a subnet onde estão os dados de saúde.

Usamos **Shared VPC** — a VPC é criada no projeto `enlite-shared` e compartilhada com os demais projetos. Isso centraliza o controle de rede.

**3 subnets isoladas:**

- **svc-subnet** (10.10.0.0/20): onde rodam os microserviços (GKE). Flow logs com sampling de 50%
- **data-subnet** (10.30.0.0/24): onde ficam Cloud SQL e Redis. Flow logs com sampling de 100% (auditoria completa)
- **phi-subnet** (10.40.0.0/24): onde fica a Cloud Healthcare API (dados de saúde). Flow logs com sampling de 100%

**Por que flow logs 100% na data-subnet e phi-subnet:** A HIPAA exige audit controls (45 CFR 164.312(b)). Esses logs são evidência forense de quem acessou a rede de dados, quando, e de onde. Retenção mínima: 6 anos (45 CFR 164.316(b)(2)(i)). Os logs são enviados para BigQuery no projeto de audit.

```bash
gcloud compute shared-vpc enable enlite-shared

gcloud compute networks create enlite-vpc --subnet-mode=custom --project=enlite-shared

gcloud compute networks subnets create svc-subnet \
  --network=enlite-vpc --region=us-east1 --range=10.10.0.0/20 \
  --secondary-range=pods=10.20.0.0/14,services=10.24.0.0/20 \
  --enable-private-ip-google-access --enable-flow-logs \
  --logging-flow-sampling=0.5 --logging-metadata=INCLUDE_ALL_METADATA \
  --project=enlite-shared

gcloud compute networks subnets create data-subnet \
  --network=enlite-vpc --region=us-east1 --range=10.30.0.0/24 \
  --enable-private-ip-google-access --enable-flow-logs \
  --logging-flow-sampling=1.0 --logging-metadata=INCLUDE_ALL_METADATA \
  --project=enlite-shared

gcloud compute networks subnets create phi-subnet \
  --network=enlite-vpc --region=us-east1 --range=10.40.0.0/24 \
  --enable-private-ip-google-access --enable-flow-logs \
  --logging-flow-sampling=1.0 --logging-metadata=INCLUDE_ALL_METADATA \
  --project=enlite-shared

gcloud compute shared-vpc associated-projects add enlite-prod-services --host-project=enlite-shared
gcloud compute shared-vpc associated-projects add enlite-prod-data --host-project=enlite-shared
```

**Entregável:** VPC com 3 subnets, flow logs habilitados, Shared VPC configurada.

---

## 1.4 — Firewall Rules (Quem fala com quem)

**Por que regras de firewall granulares:** Implementam "minimum necessary" (HIPAA 45 CFR 164.514(d)) na camada de rede.

```bash
# Negar tudo por padrão
gcloud compute firewall-rules create deny-all-internal --network=enlite-vpc \
  --action=DENY --direction=INGRESS --priority=65534 --rules=all \
  --source-ranges=0.0.0.0/0 --project=enlite-shared

# Serviços → Banco de dados (PostgreSQL 5432, Redis 6379)
gcloud compute firewall-rules create allow-svc-to-data --network=enlite-vpc \
  --action=ALLOW --direction=INGRESS --priority=1000 --rules=tcp:5432,tcp:6379 \
  --source-ranges=10.10.0.0/20 --target-tags=data-access --project=enlite-shared

# Serviços → PHI (Healthcare API via HTTPS 443)
gcloud compute firewall-rules create allow-svc-to-phi --network=enlite-vpc \
  --action=ALLOW --direction=INGRESS --priority=1000 --rules=tcp:443 \
  --source-ranges=10.10.0.0/20 --target-tags=phi-access --project=enlite-shared

# BLOQUEAR: Data subnet NÃO acessa PHI subnet
gcloud compute firewall-rules create deny-data-to-phi --network=enlite-vpc \
  --action=DENY --direction=INGRESS --priority=900 --rules=all \
  --source-ranges=10.30.0.0/24 --target-tags=phi-access --project=enlite-shared

# BLOQUEAR: PHI subnet NÃO acessa Data subnet
gcloud compute firewall-rules create deny-phi-to-data --network=enlite-vpc \
  --action=DENY --direction=INGRESS --priority=900 --rules=all \
  --source-ranges=10.40.0.0/24 --target-tags=data-access --project=enlite-shared

# Health checks do Load Balancer (ranges do Google)
gcloud compute firewall-rules create allow-health-checks --network=enlite-vpc \
  --action=ALLOW --direction=INGRESS --priority=1000 --rules=tcp:80,tcp:443,tcp:8080 \
  --source-ranges=130.211.0.0/22,35.191.0.0/16 --project=enlite-shared

# Comunicação interna GKE (pods entre si)
gcloud compute firewall-rules create allow-gke-internal --network=enlite-vpc \
  --action=ALLOW --direction=INGRESS --priority=1000 --rules=all \
  --source-ranges=10.20.0.0/14,10.24.0.0/20 --target-tags=gke-node --project=enlite-shared
```

**O que essas regras garantem na prática:**

Se o `provider-service` for comprometido, o atacante acessa a svc-subnet e a data-subnet (Cloud SQL), mas NÃO a phi-subnet — somente o `phi-service` (com service account específica) tem acesso via IAM. Se o Cloud SQL for comprometido, o atacante NÃO alcança a Cloud Healthcare API (phi-subnet totalmente isolada). Todo tráfego entre subnets é logado via VPC Flow Logs.

**Entregável:** 7 firewall rules implementando isolamento de rede completo.

---

## 1.5 — Cloud KMS (Chaves de Criptografia)

**Por que usar CMEK (Customer-Managed Encryption Keys):**

A HIPAA Security Rule (45 CFR 164.312(a)(2)(iv)) trata criptografia como implementação addressable — a entidade avalia se é razoável e apropriada (para healthtechs, sempre é). A LGPD Art. 46 exige medidas técnicas de segurança. O GDPR Art. 32(1)(a) cita explicitamente pseudonymisation e encriptação.

Com CMEK, a EnLite controla o ciclo de vida das chaves. Se decidir sair do Google Cloud, pode destruir as chaves e tornar todos os dados irrecuperáveis. Isso é relevante para o direito ao esquecimento (GDPR Art. 17, LGPD Art. 18 VI). Com chaves gerenciadas pelo Google, a EnLite não tem esse controle.

**4 chaves, cada uma para um propósito:**

```bash
gcloud kms keyrings create enlite-keys --location=us-east1 --project=enlite-shared

# 1. Criptografia do banco de dados inteiro (Cloud SQL)
gcloud kms keys create cloudsql-key --keyring=enlite-keys --location=us-east1 \
  --purpose=encryption --rotation-period=90d --project=enlite-shared

# 2. Criptografia de colunas PII no PostgreSQL (CPF, documentos profissionais)
gcloud kms keys create pii-column-key --keyring=enlite-keys --location=us-east1 \
  --purpose=encryption --rotation-period=365d --project=enlite-shared

# 3. Criptografia do FHIR store (dados de saúde na Cloud Healthcare API)
gcloud kms keys create healthcare-key --keyring=enlite-keys --location=us-east1 \
  --purpose=encryption --rotation-period=90d --project=enlite-shared

# 4. Criptografia de arquivos no Cloud Storage (fotos, documentos)
gcloud kms keys create storage-key --keyring=enlite-keys --location=us-east1 \
  --purpose=encryption --rotation-period=365d --project=enlite-shared

# Autorizar o Cloud SQL service agent a usar a chave
gcloud kms keys add-iam-policy-binding cloudsql-key --keyring=enlite-keys \
  --location=us-east1 \
  --member="serviceAccount:service-PROJECT_NUMBER@gcp-sa-cloud-sql.iam.gserviceaccount.com" \
  --role="roles/cloudkms.cryptoKeyEncrypterDecrypter" --project=enlite-shared
```

**Política de rotação:** `cloudsql-key` e `healthcare-key` rotam a cada 90 dias (automático). `pii-column-key` rota anualmente (requer re-criptografia dos dados no application layer). `storage-key` rota anualmente. Documentar no Risk Analysis.

**Entregável:** 4 chaves CMEK com rotação automática + autorização para Cloud SQL.

---
---

# BLOCO 2 — ESTRATÉGIA DE DADOS E RESIDÊNCIA POR JURISDIÇÃO

## 2.1 — Por que um banco de dados único em vez de um banco por país

**Esta é uma decisão arquitetural fundamental que precisa ser justificada:**

A EnLite opera em 4 jurisdições (BR, US, EU, AR) com leis de proteção de dados diferentes. Existem duas abordagens possíveis:

**Opção A — Banco separado por região:** Uma instância Cloud SQL no Brasil (southamerica-east1), outra nos EUA (us-east1), outra na Europa (europe-west1). Cada uma armazena apenas dados dos tenants daquela região. Garante data residency nativa.

**Opção B — Banco único com isolamento lógico:** Uma instância Cloud SQL centralizada com Row-Level Security (RLS) isolando dados por tenant. Multi-tenancy no nível da aplicação, não da infraestrutura.

**Decisão: começar com Opção B (banco único), com arquitetura preparada para migrar para Opção A quando necessário.**

**Justificativa:**

Na fase inicial (centenas de usuários, poucos tenants), a complexidade operacional de múltiplos bancos não se justifica — cada banco precisa de backups, monitoring, failover, e migrations separados. Com RLS + criptografia CMEK + a campo `iam.tenants.region` determinando a lei aplicável, o isolamento lógico atende os requisitos de compliance.

**Quando migrar para múltiplos bancos:** Quando um tenant EU exigir que os dados residam fisicamente na Europa (GDPR não exige isso se SCCs estão em vigor, mas alguns clientes enterprise exigem por contrato). Quando atingir escala que justifique bancos dedicados por região. Quando a legislação de algum país exigir explicitamente data residency local.

**Como a arquitetura está preparada para a migração:** A coluna `iam.tenants.region` determina o roteamento. Cada microserviço já injeta o `tenant_id` em toda query. A migração consistiria em: criar instância Cloud SQL na região alvo, migrar os tenants daquela região, e atualizar o service de roteamento para direcionar queries ao banco correto. O schema permanece idêntico.

**Para GDPR (tenants EU) na fase inicial:** Usamos SCCs (Standard Contractual Clauses) que o Google oferece em seus termos de serviço. Os dados ficam em us-east1 mas são protegidos contratualmente. Quando houver demanda, criamos a instância em europe-west1.

---

## 2.2 — Criar a Instância Cloud SQL (PostgreSQL)

**Por que PostgreSQL 16:** Suporta SCRAM-SHA-256 para autenticação segura, Row-Level Security nativo para multi-tenancy, PostGIS para queries geográficas (matching de providers por área de cobertura), e pgAudit para audit logging granular.

**Por que cada configuração existe — explicação de compliance por flag:**

| Configuração | Valor | Motivo regulatório |
|---|---|---|
| `availability-type=REGIONAL` | Failover automático na mesma região | HIPAA 45 CFR 164.308(a)(7): contingency plan — o banco continua operando se a zona primária falhar |
| `retained-backups-count=365` | Um ano de backups diários | Excede o mínimo HIPAA (6 anos para documentação, mas backups diários de 1 ano cobrem disaster recovery) |
| `enable-point-in-time-recovery` | Restaurar a qualquer segundo dos últimos 7 dias | HIPAA: disaster recovery. Permite reverter corrupção de dados acidental ou maliciosa |
| `no-assign-ip` | Sem IP público, acesso APENAS via IP privado dentro da VPC | HIPAA 45 CFR 164.312(a): access control — o banco não é acessível pela internet |
| `disk-encryption-key` (CMEK) | Criptografia com chave controlada pela EnLite | HIPAA 45 CFR 164.312(a)(2)(iv): criptografia; GDPR Art. 17: pode destruir chave para right to erasure |
| `pgaudit.log=read,write,ddl` | Registra toda leitura, escrita e alteração de schema | HIPAA 45 CFR 164.312(b): audit controls — evidência de quem acessou o quê |
| `ssl_min_protocol_version=TLSv1.3` | Criptografia em trânsito mais moderna disponível | HIPAA 45 CFR 164.312(e)(1): transmission security |
| `log_connections=on` | Registra toda conexão ao banco | Auditoria de acesso — quem conectou, quando, de onde |

```bash
gcloud sql instances create enlite-db-prod \
  --database-version=POSTGRES_16 \
  --tier=db-custom-4-16384 \
  --region=us-east1 \
  --availability-type=REGIONAL \
  --storage-type=SSD \
  --storage-size=50GB \
  --storage-auto-increase \
  --backup-start-time=03:00 \
  --retained-backups-count=365 \
  --retained-transaction-log-days=7 \
  --enable-point-in-time-recovery \
  --network=projects/enlite-shared/global/networks/enlite-vpc \
  --no-assign-ip \
  --disk-encryption-key=projects/enlite-shared/locations/us-east1/keyRings/enlite-keys/cryptoKeys/cloudsql-key \
  --database-flags=\
pgaudit.log=read,write,ddl,\
pgaudit.log_relation=on,\
pgaudit.log_statement_once=on,\
log_checkpoints=on,\
log_connections=on,\
log_disconnections=on,\
log_lock_waits=on,\
log_min_duration_statement=1000,\
ssl_min_protocol_version=TLSv1.3 \
  --maintenance-window-day=SUN \
  --maintenance-window-hour=5 \
  --insights-config-query-insights-enabled \
  --project=enlite-prod-data

gcloud sql databases create enlite --instance=enlite-db-prod --project=enlite-prod-data

# Usuário da aplicação (senha gerada, armazenada no Secret Manager, nunca em código)
APP_DB_PASSWORD=$(openssl rand -base64 32)
gcloud sql users create app_service --instance=enlite-db-prod \
  --password="$APP_DB_PASSWORD" --project=enlite-prod-data
echo -n "$APP_DB_PASSWORD" | gcloud secrets create db-app-password \
  --data-file=- --project=enlite-prod-data

# Usuário read-only para auditoria (acessa apenas schema compliance)
READONLY_PASSWORD=$(openssl rand -base64 32)
gcloud sql users create audit_reader --instance=enlite-db-prod \
  --password="$READONLY_PASSWORD" --project=enlite-prod-data
echo -n "$READONLY_PASSWORD" | gcloud secrets create db-audit-password \
  --data-file=- --project=enlite-prod-data

# Usuário dedicado para gerenciamento de permissões (usado apenas pelo permission-service)
PERM_PASSWORD=$(openssl rand -base64 32)
gcloud sql users create permission_admin_sa --instance=enlite-db-prod \
  --password="$PERM_PASSWORD" --project=enlite-prod-data
echo -n "$PERM_PASSWORD" | gcloud secrets create db-permission-admin-password \
  --data-file=- --project=enlite-prod-data
```

**Entregável:** Instância Cloud SQL criada com HA, CMEK, pgAudit, TLS 1.3, IP privado, 3 usuários com diferentes níveis de acesso.

---

## 2.3 — Estrutura do Banco de Dados: 3 Schemas, por quê

**O banco é dividido em 3 schemas com propósitos e permissões diferentes:**

**Schema `iam` (Identity and Access Management):** Contém autenticação, autorização, roles, e o sistema de permissões dinâmicas. É o "quem pode fazer o quê". O `app_service` pode LER as permissões mas NÃO pode MODIFICÁ-LAS — modificações só são possíveis via o usuário `permission_admin_sa`, usado exclusivamente pelo permission-service e backoffice. Isso impede que um serviço comprometido altere suas próprias permissões.

**Schema `business` (Dados de Negócio):** Contém todos os dados funcionais: perfis, onboarding de pacientes e providers, organizações (payers, clínicas), planos de saúde, contratos, elegibilidade, endereços, preferências. Dados PII sensíveis (CPF, documentos profissionais) são criptografados com Cloud KMS antes de serem armazenados. Este schema NÃO contém nenhum dado de saúde (PHI) — diagnósticos e condições clínicas ficam exclusivamente na Cloud Healthcare API (FHIR).

**Schema `compliance` (Auditoria e Conformidade):** Contém consentimentos, logs de acesso, requisições de titulares, incidentes de segurança, contratos BAA/DPA, e políticas de retenção. As tabelas de audit log são **append-only** — o `app_service` pode inserir registros mas NUNCA pode editá-los ou deletá-los. Isso garante integridade forense dos logs de auditoria (HIPAA 45 CFR 164.312(b)).

**Por que PHI fica FORA do PostgreSQL:** Diagnósticos e condições clínicas são Protected Health Information (PHI) sob HIPAA, dados sensíveis de saúde sob LGPD Art. 11, e special category data sob GDPR Art. 9. A Cloud Healthcare API (FHIR R4) é um serviço gerenciado do GCP que oferece: criptografia CMEK, auditoria nativa via Cloud Audit Logs, conformidade HIPAA com BAA, de-identification automática para analytics, e consent enforcement nativo. O PostgreSQL armazena apenas o ponteiro (`fhir_patient_id`). Quando um serviço precisa do diagnóstico, usa esse ponteiro para buscar na Cloud Healthcare API. Essa separação é o pilar central da arquitetura de compliance.

---

## 2.4 — Script SQL Completo

O script abaixo cria TODAS as tabelas, índices, functions, Row-Level Security, permissões, triggers, e dados iniciais. A ordem de criação respeita as dependências de foreign keys.

O script SQL completo (~900 linhas) está no arquivo técnico acompanhante `EnLite_SQL_Schema_Completo.sql` e cria:

**Schema `iam` — 8 tabelas:** tenants (multi-tenancy por região/jurisdição), users (vinculados ao Google Identity Platform), roles (15 roles pré-definidos incluindo provider, patient, family_member, 7 roles de payer, compliance_officer, security_officer), user_roles (mapeamento N:N), resources (registro de todas as telas/componentes/campos protegíveis), actions (12 tipos de ação: view, edit, create, delete, export, print, full_view, mask_view, approve, reject, assign, bulk_action), role_permissions (matriz role × recurso × ação — gerenciada pelo backoffice), org_permission_overrides e user_permission_overrides (exceções temporárias com aprovação obrigatória para recursos restritos).

**Schema `business` — 17 tabelas:** profiles, user_context, addresses (com suporte a endereço de pessoa, paciente, e organização), organizations (payers, clínicas, hospitais), organization_members (funcionários da org com 7 roles internos), patient_onboardings, patient_proxies, scheduling_preferences, providers, provider_specialties, provider_education, provider_patient_preferences, provider_age_preferences, provider_coverage_areas (com PostGIS para matching geográfico), insurance_plans, payer_provider_contracts (credenciamento), platform_contracts (contrato payer ↔ EnLite com campo baa_signed obrigatório), patient_eligibility.

**Schema `compliance` — 7 tabelas:** consents (8 tipos granulares de consentimento por jurisdição, com hash SHA-256 do documento aceito), access_logs (append-only — a aplicação pode inserir mas NUNCA editar ou deletar), data_subject_requests (LGPD Art. 18, GDPR Arts. 15-22, HIPAA 164.528, com deadlines por jurisdição e formato de exportação para portabilidade), security_incidents (com campos de deadline para cada jurisdição: HIPAA 60 dias, GDPR 72h, LGPD razoável), vendor_agreements (BAA com Google e outros vendors), entity_agreements (BAA/DPA com payers e clínicas), retention_policies (políticas de retenção por tipo de dado e jurisdição — HIPAA 6 anos, LGPD 20 anos para prontuários, GDPR 10 anos, Ley 25.326 10 anos), permission_audit_log (append-only — toda mudança de permissão é registrada).

**Functions:** `resolve_permission` (resolve a permissão de um usuário para um recurso em 8 passos de precedência, com proteção contra recursão infinita e sanitização de inputs), `get_screen_permissions` (retorna todas as permissões de uma tela e seus filhos em uma única query para o frontend), `set_request_context` (define o tenant atual para isolamento via RLS), `grant_permission` (helper para seed de permissões).

**Row-Level Security:** 27 policies de RLS garantindo que um tenant NUNCA vê dados de outro tenant, em TODAS as tabelas dos 3 schemas.

**Permissões de banco (GRANTs):** `app_service` pode ler e escrever dados de negócio mas NÃO pode modificar permissões (prevenção de privilege escalation); `permission_admin_sa` é o único que pode alterar permissões; `audit_reader` tem acesso read-only ao schema de compliance; tabelas de audit log são append-only com REVOKE explícito de DELETE/UPDATE/TRUNCATE.

**Dados iniciais (seeds):** tenant Brasil, 15 roles, 12 ações, políticas de retenção para 4 jurisdições, registro do BAA com Google Cloud.

**Documentação de Privacy by Design (GDPR Art. 25):**

| Decisão de Design | Princípio | Referência GDPR |
|---|---|---|
| PHI isolado na Cloud Healthcare API, nunca no PostgreSQL | Data minimization — cada sistema só tem os dados que precisa | Art. 25(1), Art. 5(1)(c) |
| Criptografia CMEK com chaves controladas pela EnLite | Pseudonymization + encryption | Art. 25(1), Art. 32(1)(a) |
| RLS multi-tenant em 27 tabelas | Access control by default | Art. 25(2) |
| Consent granular com 8 tipos específicos | Purpose limitation — consentimento por finalidade | Art. 25(1), Art. 5(1)(b) |
| Field-level masking (CPF, email, phone) | Data minimization — mostrar apenas o necessário | Art. 25(2) |
| Audit logs append-only (app não pode editar) | Accountability + integrity | Art. 5(2), Art. 32(1)(b) |
| Retention policies por jurisdição com deletion programada | Storage limitation | Art. 5(1)(e) |
| FHIR de-identification para analytics | Data protection by design | Art. 25(1), Art. 89 |
| VPC isolation com phi-subnet separada | Security by design | Art. 25(1), Art. 32 |
| app_service não pode modificar próprias permissões | Privilege separation | Art. 32(1)(b) |

---

## 2.5 — Cloud Healthcare API (FHIR R4) — Dados de Saúde

**Por que usar a Cloud Healthcare API em vez de guardar diagnósticos no PostgreSQL:**

Diagnósticos, condições clínicas, e dados de tratamento são o tipo de dado mais protegido em todas as jurisdições. A Cloud Healthcare API fornece isolamento nativo: os dados de saúde ficam em um serviço separado, com seu próprio sistema de criptografia, auditoria, e controle de acesso. Mesmo que o PostgreSQL seja completamente comprometido, o atacante NÃO tem acesso aos dados clínicos — ele só veria ponteiros opacos (`fhir_patient_id`) sem sentido.

**Configuração completa:**

```bash
# Criar dataset FHIR
gcloud healthcare datasets create enlite-health-prod \
  --location=us-east1 --project=enlite-prod-data

# Criar FHIR store para dados de pacientes
gcloud healthcare fhir-stores create patient-records \
  --dataset=enlite-health-prod --location=us-east1 --version=R4 \
  --enable-update-create --disable-referential-integrity=false \
  --project=enlite-prod-data

# Aplicar criptografia CMEK
gcloud healthcare datasets update enlite-health-prod --location=us-east1 \
  --crypto-key=projects/enlite-shared/locations/us-east1/keyRings/enlite-keys/cryptoKeys/healthcare-key \
  --project=enlite-prod-data

# Habilitar audit logging completo (toda leitura e escrita de PHI é logada)
# Configurar via IAM policy do projeto:
# auditLogConfigs: ADMIN_READ, DATA_READ, DATA_WRITE para healthcare.googleapis.com

# FHIR store de-identified para analytics (dados anonimizados → BigQuery)
gcloud healthcare fhir-stores create deidentified-records \
  --dataset=enlite-health-prod --location=us-east1 --version=R4 \
  --project=enlite-prod-data

# Streaming automático para BigQuery (analytics)
gcloud healthcare fhir-stores update patient-records \
  --dataset=enlite-health-prod --location=us-east1 \
  --stream-configs='[{"bigqueryDestination":{"datasetUri":"bq://enlite-prod-audit.fhir_analytics","schemaConfig":{"schemaType":"ANALYTICS_V2"}}}]' \
  --project=enlite-prod-data
```

**Service account dedicado — APENAS o phi-service acessa FHIR:**

```bash
gcloud iam service-accounts create phi-service-sa \
  --display-name="PHI Service - FHIR Access Only" --project=enlite-prod-services

gcloud healthcare datasets add-iam-policy-binding enlite-health-prod --location=us-east1 \
  --member="serviceAccount:phi-service-sa@enlite-prod-services.iam.gserviceaccount.com" \
  --role="roles/healthcare.fhirResourceEditor" --project=enlite-prod-data
```

NENHUM outro service account tem essa permissão. Se o auth-service, provider-service, ou patient-service forem comprometidos, eles NÃO conseguem acessar o FHIR.

**Recursos FHIR utilizados:**

**Patient** (dados do paciente):
```json
{
  "resourceType": "Patient",
  "name": [{"given": ["João"], "family": "Silva"}],
  "birthDate": "1990-05-15",
  "identifier": [{"system": "https://cnpj.info/cpf", "value": "123.456.789-00"}]
}
```

**Condition** (diagnóstico — PHI mais sensível):
```json
{
  "resourceType": "Condition",
  "subject": {"reference": "Patient/{fhir_patient_id}"},
  "code": {"text": "Transtorno de ansiedade generalizada", "coding": [{"system": "http://hl7.org/fhir/sid/icd-10", "code": "F41.1"}]},
  "clinicalStatus": {"coding": [{"code": "active"}]},
  "recordedDate": "2026-04-12"
}
```

**Organization** (representar payer/clínica no FHIR):
```json
{
  "resourceType": "Organization",
  "type": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/organization-type", "code": "pay"}]}],
  "name": "Unimed Grande Manaus",
  "identifier": [{"system": "https://ans.gov.br", "value": "123456"}]
}
```

**Coverage** (vínculo paciente ↔ plano de saúde):
```json
{
  "resourceType": "Coverage",
  "status": "active",
  "beneficiary": {"reference": "Patient/{fhir_patient_id}"},
  "payor": [{"reference": "Organization/{org_fhir_id}"}],
  "class": [{"type": {"coding": [{"code": "plan"}]}, "value": "mental_health_premium"}],
  "period": {"start": "2026-01-01"}
}
```

**Entregável:** FHIR store criado com CMEK, audit logging, de-identification, streaming para BigQuery, e service account isolado.

---
---

# BLOCO 3 — POR QUE PLANOS DE SAÚDE SÃO ORGANIZAÇÕES, NÃO ROLES

**Um plano de saúde (payer) é fundamentalmente diferente de um paciente ou provider.**

Hoje a plataforma tem 3 tipos de pessoa física: `patient`, `family_member`, `provider`. Todos são indivíduos vinculados a um tenant via `iam.users`. Um plano de saúde é uma **organização** — tem CNPJ/EIN, múltiplos funcionários com permissões diferentes (analista de sinistros, diretor médico, gestor de rede), e contratos comerciais com a EnLite e com os providers.

**Implicações de compliance:**

Sob HIPAA, planos de saúde são **Covered Entities**. Conforme publicado em hhs.gov, a definição de covered entity inclui explicitamente "health plans". Quando um payer usa a plataforma EnLite, a EnLite precisa de um BAA com esse payer. O payer também pode exigir BAA da EnLite.

Sob LGPD, o payer pode ser **Controlador conjunto** (Art. 5 VI) se determinar quais dados de paciente coletar para autorização. O consentimento do paciente para compartilhar dados com o payer precisa ser específico e separado (não basta o consentimento genérico da plataforma).

**O que o payer vê vs. o que o provider vê:**

O HIPAA Privacy Rule (45 CFR 164.514(d)) exige "minimum necessary" — cada ator só vê o que é estritamente necessário para sua função. Um provider vê o prontuário clínico completo (diagnóstico detalhado, notas clínicas, plano de tratamento). Um payer vê dados de elegibilidade, autorização, e claims — um subconjunto filtrado. O diretor médico do payer pode ver o código ICD-10 do diagnóstico (necessário para autorizar um procedimento), mas NÃO as notas clínicas do terapeuta.

**Modelo de dados:** A tabela `business.organizations` (genérica para payers, clínicas, hospitais, etc.) e suas tabelas filhas (`organization_members`, `insurance_plans`, `payer_provider_contracts`, `platform_contracts`, `patient_eligibility`) estão no SQL unificado do Bloco 2. A tabela `compliance.entity_agreements` rastreia os BAAs entre a EnLite e cada organização.

**Contrato payer ↔ EnLite:** A tabela `business.platform_contracts` inclui campo `baa_signed` (boolean). O sistema NÃO libera acesso a nenhum PHI para o payer enquanto `baa_signed = false`. Isso implementa o requisito HIPAA de BAA antes de qualquer acesso a ePHI (45 CFR 164.308(b)(1)).

---
---

# BLOCO 4 — SISTEMA DE PERMISSÕES DINÂMICAS (RBAC + ABAC)

## 4.1 — Por que permissões estáticas não funcionam para saúde

Em um SaaS comum, RBAC com roles fixas (admin/editor/viewer) é suficiente. Em um sistema de saúde multi-ator, isso falha porque:

- O mesmo dado (diagnóstico) precisa ser visível para o provider mas invisível para o claims_analyst do payer
- O mesmo campo (CPF) precisa aparecer completo para o provider mas mascarado para o payer
- Quando o time de produto cria uma nova tela, as permissões precisam ser configuráveis pelo backoffice sem deploy de código
- Permissões dependem de contexto (ABAC): um claims_analyst só vê pacientes com elegibilidade ativa no plano do seu payer

## 4.2 — As 4 camadas de controle

O sistema opera em 4 camadas complementares:

```
Camada 1: SCREEN (tela inteira)
  "O payer_claims_analyst pode VER a tela de Pacientes?"
  → Sim ou Não. Se não, a rota nem carrega e o item não aparece no menu.

Camada 2: COMPONENT (seção dentro da tela)
  "Dentro da tela de Pacientes, ele pode ver a seção 'Diagnóstico'?"
  → O provider vê. O claims_analyst NÃO vê.

Camada 3: FIELD (campo específico)
  "O campo CPF aparece completo ou mascarado?"
  → Provider: 123.456.789-00 (full_view)
  → Claims analyst: ***.***789-00 (mask_view, pattern: partial_end)

Camada 4: DATA (registro específico — ABAC)
  "Ele pode ver ESTE paciente em particular?"
  → Sim, porque o paciente tem elegibilidade ativa no plano deste payer
  → Não, porque o paciente é de outro tenant ou não tem vínculo com este payer
```

A Camada 4 é ABAC (Attribute-Based Access Control) — a decisão depende de atributos do contexto, não apenas do role.

## 4.3 — Como funciona na prática (banco de dados → frontend)

**Todas as permissões são gerenciadas via banco de dados (tabelas `iam.resources`, `iam.actions`, `iam.role_permissions`), não via arquivos YAML estáticos.** Quando um admin muda uma permissão no backoffice, a mudança é propagada para o Cerbos (engine de enforcement) via Admin API em ~100ms.

**Ordem de precedência (mais específico ganha, DENY sempre vence):**

```
1. user_permission_overrides (deny)     ← MAIS ESPECÍFICO — ganha sobre tudo
2. user_permission_overrides (allow)
3. org_permission_overrides (deny)
4. org_permission_overrides (allow)
5. role_permissions (deny)
6. role_permissions (allow)
7. Herança do recurso pai (screen → component → field)
8. DEFAULT: DENY                        ← Se nada foi definido, acesso negado
```

**Guardrail de segurança:** Um org_permission_override que tente liberar acesso a um recurso marcado como `sensitivity_level = 'restricted'` (PHI) é bloqueado automaticamente se o campo `approved_by` não estiver preenchido. Isso impede que um payer auto-libere acesso a dados clínicos sem aprovação do compliance officer.

**O que o frontend recebe:** Ao carregar uma tela, o frontend faz UMA request:

```
GET /api/v1/permissions/screen/patient_detail
```

E recebe um JSON com todas as permissões daquela tela de uma vez:

```json
{
  "screen": "patient_detail",
  "permissions": {
    "patient_detail": {"view": true, "create": false, "delete": false, "export": false},
    "patient_detail.personal_info": {"view": true, "edit": false},
    "patient_detail.personal_info.full_name": {"view": true, "full_view": true, "mask_view": false},
    "patient_detail.personal_info.tax_id": {"view": true, "full_view": false, "mask_view": true, "mask_pattern": "partial_end"},
    "patient_detail.diagnosis": {"view": false, "edit": false},
    "patient_detail.eligibility": {"view": true, "edit": true},
    "patient_detail.billing": {"view": true, "edit": true, "approve": true}
  }
}
```

O frontend usa esse JSON para: renderizar ou esconder seções, aplicar máscaras, habilitar ou desabilitar campos de edição.

**Performance:** Os resultados são cacheados em Redis com TTL de 5 minutos. Quando uma permissão muda, o Pub/Sub event `permission.updated` invalida o cache dos usuários afetados.

## 4.4 — Fluxo: "O time criou uma nova tela, como adicionar permissões?"

```
1. Dev cria a rota /patients/:id/timeline no frontend

2. Dev registra o recurso no banco (via migration SQL ou via backoffice):
   INSERT INTO iam.resources (resource_key, resource_type, display_name, module, route_path)
   VALUES ('patient_timeline', 'screen', 'Patient Timeline', 'patient_management',
           '/patients/:id/timeline');

3. Dev registra os componentes e campos da tela (mesmo processo)

4. Admin abre o backoffice → Settings → Permissions
   → Vê a nova tela "Patient Timeline" listada automaticamente
   → Configura quais roles podem ver, editar, etc.
   → Salva

5. permission-sync-service publica nova policy no Cerbos via Admin API (~100ms)

6. Próximo acesso: a tela aparece (ou não) no menu conforme a permissão do role

Zero deploy. Zero código. Tudo via backoffice.
```

---
---

# BLOCO 5 — DIAGRAMA DE RELACIONAMENTOS COMPLETO

```
iam.tenants
  │
  ├── iam.users (tenant_id)
  │     ├── iam.user_roles (user_id)
  │     ├── iam.user_permission_overrides (user_id)
  │     │
  │     ├── business.profiles (user_id)
  │     │     └── business.addresses (profile_id)
  │     │
  │     ├── business.user_context (user_id, organization_id?)
  │     │
  │     ├── business.patient_onboardings (user_id)
  │     │     ├── business.patient_proxies (onboarding_id)
  │     │     ├── business.scheduling_preferences (onboarding_id)
  │     │     ├── business.addresses (onboarding_id)
  │     │     └── business.patient_eligibility (patient_onboarding_id)
  │     │           └── ← business.insurance_plans (plan_id)
  │     │
  │     ├── business.providers (user_id)
  │     │     ├── business.provider_specialties (provider_id)
  │     │     ├── business.provider_education (provider_id)
  │     │     ├── business.provider_patient_preferences (provider_id)
  │     │     ├── business.provider_age_preferences (provider_id)
  │     │     ├── business.provider_coverage_areas (provider_id)
  │     │     └── business.payer_provider_contracts (provider_id)
  │     │
  │     └── business.organization_members (user_id)
  │
  ├── iam.roles (tenant_id)
  │     ├── iam.user_roles (role_id)
  │     └── iam.role_permissions (role_id)
  │           ├── iam.resources (resource_id)
  │           └── iam.actions (action_id)
  │
  └── business.organizations (tenant_id)
        ├── business.organization_members (organization_id)
        ├── business.addresses (organization_id)
        ├── business.insurance_plans (organization_id)
        │     ├── business.patient_eligibility (plan_id)
        │     └── business.payer_provider_contracts (plan_id)
        ├── business.payer_provider_contracts (organization_id)
        ├── business.platform_contracts (organization_id)
        ├── iam.org_permission_overrides (organization_id)
        ├── compliance.entity_agreements (organization_id)
        └── compliance.consents (related_organization_id)

compliance.access_logs ← APPEND-ONLY (todo acesso a PHI/PII é logado aqui)
compliance.security_incidents ← Incidentes + breach notification tracking
compliance.data_subject_requests ← LGPD Art. 18 / GDPR Arts. 15-22 / HIPAA 164.528
compliance.vendor_agreements ← BAA com Google Cloud e outros vendors
compliance.retention_policies ← Políticas de retenção por jurisdição
compliance.permission_audit_log ← APPEND-ONLY (toda mudança de permissão)

Cloud Healthcare API (FHIR R4) — FORA do PostgreSQL:
  ├── Patient resource ← referenciado por business.patient_onboardings.fhir_patient_id
  ├── Condition resource ← diagnóstico (PHI mais sensível)
  ├── RelatedPerson resource ← vínculo familiar ↔ paciente
  ├── Organization resource ← referenciado por business.organizations.fhir_organization_id
  ├── Coverage resource ← vínculo paciente ↔ plano
  └── Consent resource ← enforcement de consentimento nativo FHIR
```

---
---

# BLOCOS 6-12 — PRÓXIMAS ETAPAS (a serem detalhados)

| Bloco | Conteúdo | Status |
|---|---|---|
| 6 | Microserviços: decomposição, Dockerfiles, Helm charts, service accounts por serviço (auth, profile, patient, provider, phi, payer, permission, audit, notification, media, backoffice-bff) | Próxima iteração |
| 7 | Comunicação: API Gateway, gRPC inter-serviço, Pub/Sub events (consent.revoked, data.deletion.requested, permission.updated, breach.detected, etc.), circuit breakers | Próxima iteração |
| 8 | Autenticação: Identity Platform, JWT flow, MFA, emergency access, auto logoff | Próxima iteração |
| 9 | Cloud Storage: buckets, media service, signed URLs, CDN | Próxima iteração |
| 10 | Observability: Cloud Logging → BigQuery, pgAudit sink, Cloud Trace, alerting, SLOs | Próxima iteração |
| 11 | CI/CD: Cloud Build, Artifact Registry, security scanning (SAST/DAST), deploy pipeline | Próxima iteração |
| 12 | Backoffice: permission management UI, compliance dashboards, audit viewer, payer network management | Próxima iteração |
| 13 | Hardening: penetration testing, disaster recovery drill, breach tabletop exercise, go-live checklist | Próxima iteração |

---

*EnLite Health Solutions — Arquitetura e Implementação*
*Jurisdições: LGPD (BR), HIPAA (US), GDPR (EU), Ley 25.326 (AR)*
*Abril 2026*
