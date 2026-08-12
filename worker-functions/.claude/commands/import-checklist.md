# /import-checklist — Checklist para modificações no pipeline de import

Usado quando: **qualquer modificação** em arquivos de:
- `scripts/import-*.ts`
- `src/infrastructure/scripts/`
- `src/infrastructure/converters/`
- `src/infrastructure/services/ImportController.ts`

---

## Antes de começar — entenda o contexto

Responda antes de escrever código:

1. **Qual fonte de dados está sendo modificada?**
   - [ ] Talentum (`TalentumConverter`)
   - [ ] ClickUp (`ClickUpConverter`)
   - [ ] Planilla Operativa (`PlanilhaOperativaConverter`)
   - [ ] Ana Care (`AnaCareConverter`)
   - [ ] Nova fonte → usar `/new-converter`

2. **Qual caminho está sendo afetado?**
   - [ ] CLI (`scripts/import-*.ts`)
   - [ ] HTTP (`POST /api/import/upload`)
   - [ ] Ambos → deve usar o mesmo `importBuffer()` core

3. **A mudança afeta normalização?**
   - Se sim, a função muda em `import-utils.ts`, não no Converter

---

## Regras de modificação

### Alteração de coluna na planilha

Quando a fonte de dados muda o nome de uma coluna:

1. Modificar **apenas** o `col()` / `colFuzzy()` no Converter correspondente
2. Adicionar o novo nome como alternativa (não remover o antigo — pode vir de arquivos históricos):
   ```typescript
   // Antes
   const name = col(row, 'Nome', 'Nombre');
   // Depois (nova coluna adicionada na planilha)
   const name = col(row, 'Nome', 'Nombre', 'Nombre Completo');
   ```
3. Atualizar o fixture de teste com o novo nome de coluna
4. Verificar que `canHandle()` ainda funciona para arquivos antigos e novos

### Alteração de lógica de normalização

Quando o formato de um campo muda (ex: telefone agora vem com DDI):

1. Modificar a função correspondente em `import-utils.ts`
2. A função **continua funcionando para o formato antigo** (compatibilidade)
3. Adicionar teste para o novo formato em `import-utils.test.ts`
4. **Nunca** adicionar a lógica diretamente no Converter

### Adição de novo campo ao import

1. Adicionar campo ao DTO (`XyzRowDTO`)
2. Ler e normalizar o campo no Converter (`parse()`)
3. Adicionar campo ao upsert do repositório
4. Verificar estratégia de `ON CONFLICT` para o novo campo:
   - Sempre sobrescreve? → `field = EXCLUDED.field`
   - Preserva se já existe? → `field = COALESCE(table.field, EXCLUDED.field)`
   - Condicional? → `field = CASE WHEN ... END`
   - Documentar a escolha com comentário no SQL

---

## Checklist de integridade pós-modificação

### Separação de responsabilidades
- [ ] A lógica de parse/normalização está no Converter (não no Importer, não no repositório)
- [ ] O Importer apenas orquestra — detecta tipo, chama Converter, chama repositório
- [ ] Scripts CLI têm menos de 80 linhas e zero lógica de negócio

### Dual-use CLI/HTTP
- [ ] A modificação funciona quando chamada via CLI (`pnpm import:xxx`)
- [ ] A modificação funciona quando chamada via `POST /api/import/upload`
- [ ] `onProgress` é o único ponto de diferença entre os dois caminhos
- [ ] Todo import (CLI ou HTTP) cria e fecha um `ImportJob`

### Rastreabilidade
- [ ] Erros de linha individual não param o import — são acumulados em `errorDetails`
- [ ] Progresso é reportado a cada `CHUNK_SIZE` (100) linhas
- [ ] `ImportJob` termina em `done` ou `error`, nunca fica em `processing`

### Sequência pós-import
- [ ] `encuadreRepo.linkWorkersByPhone()` é chamado após upsert em lote
- [ ] `blacklistRepo.linkWorkersByPhone()` é chamado após upsert em lote
- [ ] `encuadreRepo.syncToWorkerJobApplications()` **NÃO** é chamado — deprecada F6 (2026-05-24)
  > **F6 (2026-05-24):** `syncToWorkerJobApplications` foi removida da sequência. Imports não devem mais chamar essa função.

### LLM (se aplicável)
- [ ] LLM não é chamado dentro do `for` de linhas — sempre em background após o import
- [ ] `enrichIfNeeded()` é usado (não `enrich()`) para não reprocessar desnecessariamente
- [ ] Rate limiting está ativo (`await delay()` entre cada chamada)

### Testes
- [ ] Fixture de teste representa o formato real do arquivo
- [ ] Cenário de coluna ausente está coberto
- [ ] Cenário de valor inválido no campo está coberto
- [ ] Teste de integração roda contra banco real (não mock)

---

## Armadilhas comuns — nunca faça isso

```typescript
// PROIBIDO — normalização inline no Converter
const phone = rawPhone.replace(/\D/g, '').slice(-10);

// PROIBIDO — lógica de detecção de tipo no Importer
if (filename.includes('Ana Care')) { ... }
else if (filename.includes('Talentum')) { ... }

// PROIBIDO — LLM no path síncrono
for (const row of rows) {
  await llmService.enrich(row); // bloqueia o import inteiro
}

// PROIBIDO — throw dentro do loop de linhas
for (const row of rows) {
  const result = await repo.upsert(row); // se isso falhar, para tudo
}

// PROIBIDO — lógica de negócio em scripts/
// scripts/import-clickup.ts
const rows = XLSX.read(buffer)...; // isso pertence ao ClickUpConverter
```
