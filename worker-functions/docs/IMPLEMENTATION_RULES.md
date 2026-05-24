# Regras de Implementação — Enlite Worker Functions

> Documento vivo. Toda decisão arquitetural significativa deve gerar uma atualização aqui.
> Regras marcadas com **[AUSENTE]** são o que devemos ter mas ainda não temos.
> Regras marcadas com **[EXISTENTE]** formalizam o que já praticamos corretamente.

---

## ÍNDICE

1. [Pipeline de Importação de Arquivos](#1-pipeline-de-importação-de-arquivos)
2. [Camada de Converters (Fonte → Domínio)](#2-camada-de-converters-fonte--domínio)
3. [Padrão Dual-Use: CLI e HTTP](#3-padrão-dual-use-cli-e-http)
4. [Repositórios](#4-repositórios)
5. [Normalização e Utilitários](#5-normalização-e-utilitários)
6. [Serviços LLM](#6-serviços-llm)
7. [Progresso e Rastreabilidade](#7-progresso-e-rastreabilidade)
8. [Testes](#8-testes)
9. [Organização de Código e Arquivos](#9-organização-de-código-e-arquivos)
10. [Banco de Dados e Migrações](#10-banco-de-dados-e-migrações)

---

## 1. Pipeline de Importação de Arquivos

O sistema recebe arquivos de 4 fontes distintas — **Talentum**, **ClickUp**, **Planilla Operativa** e **Ana Care** — por dois caminhos: CLI e HTTP. As regras abaixo garantem que esses caminhos nunca dupliquem lógica.

---

### IMPORT-001 — Cada fonte de dados tem um Converter dedicado [AUSENTE]

**Regra:** Para cada tipo de arquivo existe exatamente uma classe converter. Essa classe conhece o formato da planilha, as colunas, e transforma linhas brutas em DTOs tipados. Ela não sabe nada sobre banco de dados, repositórios ou progresso.

**Estrutura obrigatória:**
```
src/infrastructure/converters/
  TalentumConverter.ts          ← lê CANDIDATOS.xlsx / Talentum CSV
  ClickUpConverter.ts           ← lê ClickUp Export (auto-detecta header)
  PlanilhaOperativaConverter.ts ← lê abas da Planilla Operativa Encuadre.xlsx (**REMOVIDO 2026-05-23** — planilha operativa descontinuada)
  AnaCareConverter.ts           ← lê Ana Care Control.xlsx
  index.ts                      ← barrel + registry de detecção de tipo
```

**Por que:** Hoje `import-planilhas.ts` tem 1200+ linhas fazendo parse, normalização, upsert e linking num único lugar. Quando o ClickUp muda uma coluna, mexemos num arquivo que também contém lógica do Ana Care e do Talentum — risco alto de regressão.

---

### IMPORT-002 — O `PlanilhaImporter` é apenas um orquestrador [AUSENTE]

**Regra:** O `PlanilhaImporter` (ou seu substituto) só faz três coisas:
1. Recebe o buffer + filename
2. Detecta o tipo → instancia o Converter correto
3. Chama o repositório com o resultado do Converter

Ele nunca parseia colunas, nunca normaliza valores, nunca contém `if (filename.includes('Ana Care'))`.

**Exemplo do fluxo correto:**
```typescript
class PlanilhaImporter {
  async importBuffer(buffer: Buffer, filename: string, jobId: string, onProgress?) {
    const converter = ConverterRegistry.detect(buffer, filename); // IMPORT-003
    const rows = await converter.parse(buffer);                   // IMPORT-001
    await this.persist(rows, jobId, onProgress);                  // repositórios
    await this.postImport(converter.type, jobId);                 // linking, sync
  }
}
```

---

### IMPORT-003 — Interface `IFileConverter` é contrato obrigatório [AUSENTE]

**Regra:** Todo converter implementa `IFileConverter`. Sem essa interface, não é um converter válido.

```typescript
// src/domain/ports/IFileConverter.ts
export interface IFileConverter<TRow> {
  readonly type: ImportFileType;
  canHandle(buffer: Buffer, filename: string): boolean;
  parse(buffer: Buffer): Promise<TRow[]>;
}

export type ImportFileType = 'talentum' | 'clickup' | 'ana_care'; // planilla_operativa removido em 2026-05-23
```

**Registro de detecção (substituir `detectType()` inline):**
```typescript
// src/infrastructure/converters/index.ts
const CONVERTERS: IFileConverter<unknown>[] = [
  new AnaCareConverter(),
  new ClickUpConverter(),
  new PlanilhaOperativaConverter(),
  new TalentumConverter(),
];

export function detectConverter(buffer: Buffer, filename: string): IFileConverter<unknown> {
  const match = CONVERTERS.find(c => c.canHandle(buffer, filename));
  if (!match) throw new Error(`Nenhum converter encontrado para: ${filename}`);
  return match;
}
```

---

### IMPORT-004 — Detecção de tipo é responsabilidade do Converter, não do Importer [AUSENTE]

**Regra:** Cada converter implementa `canHandle()` com suas próprias regras de detecção (nome de arquivo, nomes de abas, presença de colunas-chave). O importer jamais contém lógica de `if/else` para decidir o tipo.

**Exemplos de `canHandle()`:**
```typescript
// AnaCareConverter
canHandle(buffer, filename) {
  return filename.toLowerCase().includes('ana care');
}

// ClickUpConverter
canHandle(buffer, filename) {
  // Detecta pela presença de aba com "Task Type" no header
  const wb = XLSX.read(buffer);
  const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  return (sheet[0] as string[])?.some(h => String(h).includes('Task Type'));
}
```

---

### IMPORT-005 — Scripts CLI são apenas entrypoints, sem lógica de negócio [EXISTENTE → formalizar]

**Regra:** Arquivos em `scripts/` têm no máximo 80 linhas. Eles:
- Leem argumentos CLI
- Instanciam o `PlanilhaImporter` (ou o converter correto)
- Chamam `importBuffer()` ou `importFile()`
- Imprimem resultado e saem

**Nunca em scripts/:** queries SQL, normalização de dados, lógica de detecção de tipo, regras de negócio.

**Estrutura esperada de um script:**
```typescript
// scripts/import-clickup.ts  (~30 linhas)
const filepath = process.argv[2] ?? 'docs/excel/clickup-export.xlsx';
const buffer = fs.readFileSync(filepath);
const importer = new PlanilhaImporter(/* deps via DI */);
const result = await importer.importBuffer(buffer, path.basename(filepath));
console.log(result.summary);
```

---

### IMPORT-006 — Comando `import:all` usa o mesmo Importer que o HTTP [EXISTENTE → formalizar]

**Regra:** `scripts/import-all-excel.ts` itera os arquivos em `docs/excel/` e chama `PlanilhaImporter.importBuffer()` para cada um — o mesmo método usado pelo endpoint HTTP. Nenhuma lógica de importação duplicada entre os dois caminhos.

O único ponto de divergência permitido é o `onProgress`: no CLI, imprime no console; no HTTP, atualiza o banco.

---

## 2. Camada de Converters (Fonte → Domínio)

---

### CONV-001 — Converters retornam DTOs tipados, nunca objetos genéricos [AUSENTE]

**Regra:** O tipo de retorno de `parse()` é sempre um DTO específico, nunca `Record<string, unknown>` ou `any[]`.

```typescript
// Correto
class TalentumConverter implements IFileConverter<TalentumRowDTO> {
  async parse(buffer: Buffer): Promise<TalentumRowDTO[]> { ... }
}

interface TalentumRowDTO {
  rawName: string;
  rawPhone: string;
  email: string | null;
  profession: string | null;
  funnelStageRaw: string | null;
  recruitmentDateRaw: string | null;
  // ...
}
```

**Por que:** DTOs tipados eliminam erros silenciosos quando colunas mudam de nome na planilha.

---

### CONV-002 — Converters usam `import-utils.ts` para toda normalização [AUSENTE → parcialmente existente]

**Regra:** Um Converter nunca implementa sua própria lógica de normalização. Toda normalização vive em `src/infrastructure/scripts/import-utils.ts`. Se uma função não existe lá, ela é adicionada lá — nunca inline no converter.

**Nunca em Converters:**
```typescript
// PROIBIDO — normalização inline
const phone = rawPhone.replace(/\D/g, '').slice(-10);
const name = rawName.trim().split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
```

**Correto:**
```typescript
import { normalizePhoneAR, normalizeProperName } from '../scripts/import-utils';
const phone = normalizePhoneAR(rawPhone);
const name = normalizeProperName(rawName);
```

---

### CONV-003 — Converters nunca lançam exceção por linha inválida [AUSENTE]

**Regra:** Uma linha inválida (coluna faltando, valor fora do enum) nunca para o converter. Ela gera um `ConversionError` e a linha é retornada como `{ error, rawRow, rowIndex }`. O importer decide o que fazer com erros.

```typescript
interface ConversionResult<T> {
  rows: T[];
  errors: Array<{ rowIndex: number; rawRow: unknown; error: string }>;
}
```

---

### CONV-004 — Detecção de coluna usa `colFuzzy()` centralizado [EXISTENTE → formalizar]

**Regra:** A lógica de detecção de colunas com nomes variáveis (`col()`, `colFuzzy()`) vive em `import-utils.ts` e é a única maneira de ler colunas de uma linha bruta. Nunca acesse `row['Nome']` diretamente.

```typescript
// Correto
const name = col(row, 'Nome', 'Nombre', 'NOME', 'Worker Name');

// Proibido
const name = row['Nome'] ?? row['Nombre'];
```

---

## 3. Padrão Dual-Use: CLI e HTTP

O mesmo arquivo pode ser importado via `pnpm import:clickup` ou via `POST /api/import/upload`. As regras abaixo garantem que ambos os caminhos usem exatamente a mesma lógica de negócio.

---

### DUAL-001 — `PlanilhaImporter` recebe dependências via construtor [AUSENTE]

**Regra:** O `PlanilhaImporter` não instancia repositórios diretamente. Ele recebe as dependências via construtor. Isso permite que CLI e HTTP usem a mesma classe sem acoplamento ao contexto do Express.

```typescript
class PlanilhaImporter {
  constructor(
    private encuadreRepo: IEncuadreRepository,
    private workerRepo: IWorkerRepository,
    private importJobRepo: IImportJobRepository,
    // ...
  ) {}
}
```

---

### DUAL-002 — `onProgress` é o único ponto de divergência entre CLI e HTTP [EXISTENTE → formalizar]

**Regra:** CLI e HTTP diferem apenas na implementação de `onProgress`:

```typescript
// CLI
const onProgress = (p: ImportProgress) => {
  process.stdout.write(`\r[${p.sheet}] ${p.processedRows}/${p.totalRows}`);
};

// HTTP (ImportController)
const onProgress = async (p: ImportProgress) => {
  await importJobRepo.updateProgress(jobId, p);
};
```

Qualquer outro comportamento diferente entre CLI e HTTP é um bug de arquitetura.

---

### DUAL-003 — Todo import CLI tem um `ImportJob` no banco [EXISTENTE → formalizar]

**Regra:** Mesmo importações via CLI criam um registro `import_jobs`. Isso garante histórico e rastreabilidade independente do caminho de entrada.

```typescript
// Em import-all-excel.ts
const importJob = await importJobRepo.create({ filename, fileHash, createdBy: 'cli' });
await importer.importBuffer(buffer, filename, importJob.id, onProgress);
```

---

### DUAL-004 — HTTP retorna 202 imediatamente, CLI aguarda [EXISTENTE → formalizar]

**Regra:**
- HTTP: `POST /api/import/upload` → cria `ImportJob` → retorna `202 { importJobId, statusUrl }` → processa em background
- CLI: chama `importBuffer()` → aguarda → imprime resultado

Nunca faça o HTTP aguardar o processamento completo antes de responder.

---

## 4. Repositórios

> ⚠️ **Estes exemplos refletem o padrão pré-2026-05-23.** Em código novo, escrever apenas em `worker_job_applications`. Trigger 189 garante encuadre mínimo automaticamente. Ver [docs/features/worker-job-applications/08-pipelines.md](../../docs/features/worker-job-applications/08-pipelines.md).

---

### REPO-001 — Um arquivo por repositório [AUSENTE]

**Regra:** `OperationalRepositories.ts` com 10+ classes em 600+ linhas é uma violação. Cada repositório tem seu próprio arquivo.

**Estrutura correta:**
```
src/infrastructure/repositories/
  WorkerRepository.ts
  EncuadreRepository.ts
  JobPostingRepository.ts        ← renomear de JobPostingARRepository
  PatientRepository.ts
  BlacklistRepository.ts
  PublicationRepository.ts
  ImportJobRepository.ts
  AnalyticsRepository.ts
  index.ts                       ← barrel export
```

---

### REPO-002 — Repositórios nunca normalizam dados [EXISTENTE → formalizar]

**Regra:** Repositórios recebem DTOs já normalizados. Eles executam SQL. Nunca fazem `phone.replace()`, `name.trim()`, ou lógica de negócio. Se precisam transformar algo, é um sinal de que a normalização deveria ter acontecido antes.

---

### REPO-003 — `ON CONFLICT` tem comentário explicando a estratégia [AUSENTE]

**Regra:** Todo `ON CONFLICT ... DO UPDATE` deve ter comentário inline explicando por que cada campo usa `EXCLUDED.*` (sobrescreve) vs `COALESCE` (preserva) vs `CASE WHEN` (condicional).

```sql
ON CONFLICT (dedup_hash) DO UPDATE SET
  -- Planilha é source of truth para resultado: sempre sobrescreve
  resultado = EXCLUDED.resultado,
  -- Meet link é gerado externamente: preserve se já existe
  meet_link = COALESCE(encuadres.meet_link, EXCLUDED.meet_link),
  -- Se obs mudou, o LLM precisa reprocessar: reseta timestamp
  llm_processed_at = CASE
    WHEN encuadres.obs_encuadre IS DISTINCT FROM EXCLUDED.obs_encuadre
    THEN NULL
    ELSE encuadres.llm_processed_at
  END
```

---

### REPO-004 — `upsert()` sempre retorna `{ entity, created: boolean }` [EXISTENTE → formalizar]

**Regra:** O método `upsert()` de todo repositório retorna o objeto salvo E um booleano indicando se foi criação ou atualização. Isso é necessário para o contador de progresso do ImportJob.

```typescript
async upsert(dto: CreateEncuadreDTO): Promise<{ entity: Encuadre; created: boolean }> {
  // xmax = 0 significa INSERT; xmax != 0 significa UPDATE
  const result = await pool.query(`
    INSERT INTO encuadres ... ON CONFLICT ... DO UPDATE ...
    RETURNING *, (xmax = 0) AS created
  `);
  return { entity: mapRow(result.rows[0]), created: result.rows[0].created };
}
```

---

### REPO-005 — Linking por telefone é operação atômica do repositório [EXISTENTE → formalizar]

**Regra:** `linkWorkersByPhone()` e `syncToWorkerJobApplications()` são operações do repositório, não do importer. O importer apenas as chama após o upsert em lote.

Sequência pós-import:
```typescript
await encuadreRepo.linkWorkersByPhone();     // 1. Liga encuadres a workers
await blacklistRepo.linkWorkersByPhone();    // 2. Liga blacklist a workers
// encuadreRepo.syncToWorkerJobApplications() — DEPRECADO F6 (2026-05-24): não chamar
```

> **F6 entregue 2026-05-24:** call site recorrente em `import-encuadres-from-clickup.ts` removido. Função mantida com `@deprecated` para backfill manual se necessário. Ver README do plano WJA.

---

## 5. Normalização e Utilitários

---

### NORM-001 — `import-utils.ts` é a única fonte de verdade para normalização [EXISTENTE → formalizar]

**Regra:** Toda função de normalização de dados vive em `src/infrastructure/scripts/import-utils.ts`. Nenhum arquivo importa outra biblioteca de formatação diretamente.

Funções obrigatórias que devem existir (adicionar as ausentes):
```typescript
normalizePhoneAR(raw: string): string | null          // → 549XXXXXXXXXX
normalizeEmail(raw: string): string | null             // → lowercase, trim
normalizeProperName(raw: string): string | null        // → Title Case
normalizeBoolean(raw: unknown): boolean | null         // → Si/No/1/0/true/false
normalizeResultado(raw: string): EncuadreResultado | null
parseExcelDate(raw: unknown): Date | null              // Serial, DD/MM/YYYY, ISO
classifyProfession(raw: string): WorkerOccupation | null
col(row, ...keys): string | undefined                  // Exact match
colFuzzy(row, ...keys): string | undefined             // Fuzzy match
hashEncuadre(data: EncuadreHashInput): string          // MD5 dedup
hashPublication(data: PublicationHashInput): string
```

---

### NORM-002 — Funções de normalização são puras [EXISTENTE → formalizar]

**Regra:** Funções em `import-utils.ts` não têm efeitos colaterais, não acessam banco, não fazem IO. Dado o mesmo input, sempre retornam o mesmo output. Isso permite testá-las unitariamente de forma trivial.

---

### NORM-003 — Falha de normalização é silenciosa e logada, nunca uma exceção [AUSENTE]

**Regra:** `normalizePhoneAR('invalido')` retorna `null`, não lança erro. A linha é marcada como tendo um campo inválido e continua sendo processada. O log indica a linha e o campo problemático.

```typescript
// Correto
function normalizePhoneAR(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) {
    logger.warn(`normalizePhoneAR: valor inválido descartado: "${raw}"`);
    return null;
  }
  return formatArgentinePhone(digits);
}
```

---

### NORM-004 — Hash de deduplicação documenta quais campos o compõem [AUSENTE]

**Regra:** Todo `hash*()` em `import-utils.ts` tem um comentário listando os campos exatos que compõem o hash. Mudança de campos = nova migração para recalcular hashes existentes.

```typescript
/**
 * Hash de deduplicação de encuadre.
 * Campos: caseNumber | workerPhone | interviewDate | interviewTime
 * Nota: não inclui workerName — evita duplicatas por variações de nome.
 */
function hashEncuadre(data: EncuadreHashInput): string {
  const raw = [data.caseNumber, data.workerPhone, data.interviewDate, data.interviewTime]
    .map(v => v ?? '')
    .join('|');
  return crypto.createHash('md5').update(raw).digest('hex');
}
```

---

## 6. Serviços LLM

---

### LLM-001 — LLM nunca é chamado no path síncrono de import [EXISTENTE → formalizar]

**Regra:** Durante `importBuffer()`, nenhuma chamada LLM é feita. LLM é sempre disparado em background após o import:
- ClickUp: `JobPostingEnrichmentService.enrichIfNeeded()` → fired async após upsert
- Encuadres: processado em batch separado, não no import

Violação desse padrão causa timeouts no HTTP e lentidão no CLI.

---

### LLM-002 — Rate limiting é configurável e implementado em todos os serviços LLM [AUSENTE → parcialmente existente]

**Regra:** Todo serviço que chama LLM tem um `delayMs` configurável com default explícito:

```typescript
class JobPostingEnrichmentService {
  private readonly RATE_LIMIT_MS = 2100; // Groq: 30 req/min → 2100ms entre calls

  private async delay(): Promise<void> {
    return new Promise(r => setTimeout(r, this.RATE_LIMIT_MS));
  }

  async enrichBatch(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.enrichIfNeeded(id);
      await this.delay(); // Sempre, mesmo no último item
    }
  }
}
```

---

### LLM-003 — Resultados LLM são sempre nullable e nunca bloqueantes [EXISTENTE → formalizar]

**Regra:** Campos `llm_*` nunca têm `NOT NULL`. Um worker ou job_posting sem `llm_processed_at` é válido. O sistema nunca falha por ausência de enriquecimento LLM.

---

### LLM-004 — Prompts LLM são constantes exportadas, nunca strings inline [AUSENTE]

**Regra:** Todo prompt LLM está numa constante nomeada no topo do arquivo do serviço. Isso facilita versionamento e revisão.

```typescript
// src/infrastructure/services/JobPostingEnrichmentService.ts

const ENRICHMENT_SYSTEM_PROMPT = `
  Você é um especialista em recrutamento de profissionais de saúde domiciliar.
  Analise o perfil de vaga e extraia os campos estruturados solicitados.
  Retorne APENAS JSON válido, sem texto adicional.
`;

const buildEnrichmentPrompt = (posting: JobPosting): string => `
  Perfil: ${posting.workerProfileSought}
  Horário: ${posting.scheduleDaysHours}
  Diagnóstico: ${posting.diagnosis}
`;
```

---

## 7. Progresso e Rastreabilidade

---

### TRACK-001 — Todo import cria e fecha um `ImportJob` [EXISTENTE → formalizar]

**Regra:** Independente do caminho (CLI ou HTTP), o fluxo é:
```
create ImportJob (status='pending')
  → status='processing' ao iniciar
  → updateProgress() a cada chunk
  → status='done' ou status='error' ao terminar
```

Nunca deixar um ImportJob em `processing` sem handler de erro.

---

### TRACK-002 — Erros de linha individual nunca param o import [EXISTENTE → formalizar]

**Regra:** Erros de linha são capturados, logados e acumulados em `ImportJob.errorDetails`. O import continua para a próxima linha. Apenas erros sistêmicos (banco fora, arquivo corrompido) marcam o ImportJob como `error`.

```typescript
for (const [index, row] of rows.entries()) {
  try {
    await this.processRow(row);
    progress.processedRows++;
  } catch (err) {
    progress.errorRows++;
    progress.errors.push({ row: index + 2, error: String(err) });
    // NÃO re-throw aqui
  }
}
```

---

### TRACK-003 — Progresso reportado a cada `CHUNK_SIZE` linhas [EXISTENTE → formalizar]

**Regra:** `CHUNK_SIZE = 100` é a constante para flush de progresso. Ela deve ser definida como constante nomeada no topo de `import-planilhas.ts`, nunca hardcoded inline.

---

### TRACK-004 — File hash previne reimportação acidental [EXISTENTE → formalizar]

**Regra:** Antes de iniciar qualquer import, calcula SHA-256 do buffer e verifica `import_jobs` por `file_hash` com `status='done'`. Se encontrar, retorna sem processar e informa o usuário.

---

## 8. Testes

---

### TEST-001 — Cada Converter tem testes unitários com fixtures reais [AUSENTE]

**Regra:** Para cada converter existe um arquivo de teste com fixture real (Excel/CSV anonimizado):

```
tests/
  fixtures/
    talentum-sample.csv              ← anonimizado, mas estrutura real
    clickup-export-sample.xlsx
    planilla-operativa-sample.xlsx  // histórico — importador descontinuado em 2026-05-23
    ana-care-sample.xlsx
  unit/
    converters/
      TalentumConverter.test.ts
      ClickUpConverter.test.ts
      PlanilhaOperativaConverter.test.ts
      AnaCareConverter.test.ts
```

Cada teste cobre: detecção de tipo (`canHandle`), parsing de linha válida, handling de linha inválida, normalização de campos-chave.

---

### TEST-002 — Funções de `import-utils.ts` têm cobertura de 100% [AUSENTE]

**Regra:** `import-utils.ts` é código puro e trivialmente testável. Deve ter 100% de cobertura de branches. Cada caso de `normalizePhoneAR` (argentino com 0, sem 0, 10 dígitos, 11 dígitos, inválido) tem um teste.

---

### TEST-003 — Testes de integração usam banco real, sem mocks [EXISTENTE → formalizar]

**Regra:** Testes de repositório nunca mocam o banco. Usam uma database de teste real com dados isolados. Mocks de banco levaram a falhas em produção no passado.

---

### TEST-004 — Importers têm testes de integração por tipo de arquivo [EXISTENTE → expandir]

**Regra:** Para cada tipo de arquivo existe um teste de integração que:
1. Lê o fixture real
2. Chama `PlanilhaImporter.importBuffer()`
3. Verifica registros criados no banco de teste
4. Verifica contadores do `ImportJob`

---

## 9. Organização de Código e Arquivos

---

### ORG-001 — Máximo 400 linhas por arquivo de implementação [AUSENTE]

**Regra:** Arquivos acima de 400 linhas são um sinal de que a classe está fazendo coisas demais. Violadores atuais que precisam ser refatorados:
- `import-planilhas.ts` (1200+ linhas) → dividir em Converters + Importer
- `OperationalRepositories.ts` (600+ linhas) → um arquivo por repositório
- `index.ts` (500+ linhas) → extrair rotas para `src/interfaces/routes/`

---

### ORG-002 — Rotas HTTP vivem em `src/interfaces/routes/` [AUSENTE]

**Regra:** `src/index.ts` não registra rotas individualmente. Ele importa e monta módulos de rotas:

```typescript
// src/index.ts
app.use('/api/import', importRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/analytics', analyticsRoutes);
```

```
src/interfaces/routes/
  import.routes.ts
  worker.routes.ts
  admin.routes.ts
  analytics.routes.ts
```

---

### ORG-003 — Controllers não contêm lógica de negócio [EXISTENTE → formalizar]

**Regra:** Controllers fazem: validação de input, chamada de serviço/use case, formatação de resposta. Nada além disso. Regras de negócio vivem em Services ou UseCases.

---

### ORG-004 — Imports são relativos ao módulo, nunca `../../../` mais de 2 níveis [AUSENTE]

**Regra:** Se um import precisa de 3+ `../`, use um path alias configurado no `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@domain/*": ["src/domain/*"],
      "@infra/*": ["src/infrastructure/*"],
      "@interfaces/*": ["src/interfaces/*"]
    }
  }
}
```

---

## 10. Banco de Dados e Migrações

---

### DB-001 — Uma migration por mudança lógica [EXISTENTE → formalizar]

**Regra:** Cada migration altera uma coisa. Não agrupe "add column A + add column B + add index" em uma migration se não forem logicamente relacionados.

---

### DB-002 — Migrations são sempre aditivas por padrão [EXISTENTE → formalizar]

**Regra:** Nunca dropar coluna ou tabela em produção sem um período de deprecação. Sequência obrigatória para remover algo:
1. Migration: renomear para `_deprecated_YYYYMMDD`
2. Deploy: verificar que nada usa
3. Migration futura: drop definitivo

---

### DB-003 — Novas colunas LLM sempre têm migration própria [EXISTENTE → formalizar]

**Regra:** Todo campo `llm_*` adicionado ao schema tem:
- Migration com `ALTER TABLE ... ADD COLUMN llm_xxx ... DEFAULT NULL`
- Comentário no SQL explicando o que o LLM extrai para esse campo

---

### DB-004 — `dedup_hash` nunca muda de algoritmo sem recalcular todos os registros [AUSENTE]

**Regra:** Mudar os campos que compõem um `dedup_hash` requer uma migration que recalcula todos os registros existentes. Sem isso, o `ON CONFLICT` para de funcionar corretamente para dados antigos.

---

## CHECKLIST DE IMPLEMENTAÇÃO

Use este checklist ao implementar qualquer nova feature de import:

### Novo tipo de arquivo
- [ ] Criado `src/infrastructure/converters/XyzConverter.ts`
- [ ] Converter implementa `IFileConverter<XyzRowDTO>`
- [ ] `canHandle()` está no converter, não no importer
- [ ] DTO tipado criado para as linhas
- [ ] Converter registrado em `converters/index.ts`
- [ ] Normalização usa apenas funções de `import-utils.ts`
- [ ] Fixture de teste criada em `tests/fixtures/`
- [ ] Testes unitários do converter criados
- [ ] Teste de integração do import criado
- [ ] Comando CLI adicionado em `package.json`
- [ ] Documentação adicionada neste arquivo

### Nova coluna no banco
- [ ] Migration criada com número sequencial
- [ ] Column é `DEFAULT NULL` se opcional
- [ ] `ON CONFLICT` atualizado com estratégia documentada
- [ ] Campo adicionado ao DTO e à interface de entidade
- [ ] Campo mapeado no `mapRow()` do repositório

### Novo serviço LLM
- [ ] Prompt em constante nomeada, não inline
- [ ] Rate limiting implementado com `RATE_LIMIT_MS`
- [ ] Resultados são `nullable`
- [ ] Nunca chamado no path síncrono de import
- [ ] Campos resultado são `llm_*` com `llm_processed_at` correspondente

---

*Última atualização: 2026-03-25*
*Próxima revisão: quando um novo tipo de arquivo for adicionado*
