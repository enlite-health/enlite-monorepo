# /review-import — Revisar código de import

Usado quando: **revisando ou refatorando** qualquer código relacionado ao pipeline de import antes de fazer commit ou PR.

---

## Perguntas de revisão por camada

### Converter (`src/infrastructure/converters/`)

- O converter implementa `IFileConverter<TDto>`?
- `canHandle()` usa apenas filename e/ou primeiras linhas do buffer? (sem IO externo)
- `parse()` usa `col()` ou `colFuzzy()` de `import-utils.ts`? (nunca `row['Nome']` direto)
- Toda normalização delega para `import-utils.ts`?
- Linha inválida retorna `null` nos campos — nunca lança exceção?
- Linhas totalmente vazias são ignoradas com `continue`?
- O converter está registrado em `converters/index.ts`?

### Importer (`src/infrastructure/scripts/import-planilhas.ts`)

- O importer detecta o tipo chamando `converter.canHandle()` — sem `if/else` por filename?
- O importer apenas orquestra (detecta → parseia → persiste)? Sem lógica de parse inline?
- `onProgress` é chamado a cada `CHUNK_SIZE` linhas?
- Erros de linha são capturados com `try/catch` dentro do `for` e acumulados?
- A sequência pós-import está presente?
  ```typescript
  await encuadreRepo.linkWorkersByPhone();
  await blacklistRepo.linkWorkersByPhone();
  // encuadreRepo.syncToWorkerJobApplications() — DEPRECADO F6 (2026-05-24): não chamar
  ```
  > **F6 (2026-05-24):** `syncToWorkerJobApplications` foi removida da sequência. Imports não devem mais chamar essa função.

### Script CLI (`scripts/import-*.ts`)

- O script tem menos de 80 linhas?
- O script apenas lê argumentos, instancia o importer e chama `importBuffer()`?
- O script cria um `ImportJob` antes de começar?
- Nenhuma lógica de negócio ou parse inline?

### Endpoint HTTP (`ImportController`)

- Retorna `202 Accepted` imediatamente com `{ importJobId, statusUrl }`?
- O processamento acontece em método `async` separado (não bloqueia a resposta)?
- File hash é calculado antes de processar (previne reimportação)?
- `ImportJob` é criado antes do processamento começar?
- Erros no processamento async atualizam `ImportJob.status = 'error'`?

### Repositório (upsert)

- O upsert recebe DTO já normalizado? (sem normalização interna)
- Retorna `{ entity, created: boolean }`?
- Todo `ON CONFLICT ... DO UPDATE` tem comentário explicando a estratégia de cada campo?
  - `EXCLUDED.field` → sobrescreve (source of truth externa)
  - `COALESCE(table.field, EXCLUDED.field)` → preserva se já existe
  - `CASE WHEN ... END` → condicional (ex: resetar LLM se campo mudou)
- A estratégia de cada campo está correta para o caso de uso?

### LLM (se presente)

- LLM é chamado **fora** do loop de import? (nunca dentro do `for`)
- Existe `RATE_LIMIT_MS` como constante nomeada?
- `enrichIfNeeded()` é usado em vez de `enrich()` (evita reprocessamento)?
- Campos resultado são `nullable` — nunca lança se LLM falhar?
- Prompts são constantes nomeadas no topo do arquivo?

---

## Sinais de alerta — investigar antes de aprovar

```typescript
// Alerta: normalização inline
rawPhone.replace(/\D/g, '')
name.split(' ').map(w => ...)

// Alerta: detecção de tipo por if/else no importer
if (filename.includes('Ana Care')) { importAnaCare() }
else if (filename.includes('Talentum')) { importTalentum() }

// Alerta: LLM no path síncrono
for (const row of rows) {
  const enriched = await llmService.enrich(row);
}

// Alerta: throw dentro do loop de linhas
for (const row of rows) {
  await repo.upsert(row); // sem try/catch
}

// Alerta: script CLI com lógica de parse
// scripts/import-xyz.ts tem mais de 80 linhas
const wb = XLSX.read(buffer); // isso pertence ao Converter

// Alerta: ON CONFLICT sem comentário
ON CONFLICT (dedup_hash) DO UPDATE SET
  resultado = EXCLUDED.resultado,      -- por que sobrescreve?
  meet_link = COALESCE(...),           -- por que preserva?
  -- sem comentários = regra invisível
```

---

## Verificação de dual-use

Confirmar que CLI e HTTP produzem o mesmo resultado para o mesmo arquivo:

1. Testar import via CLI: `pnpm import:xyz docs/excel/arquivo.xlsx`
2. Verificar `import_jobs` no banco — deve estar `done`
3. Testar import via HTTP: `POST /api/import/upload` com o mesmo arquivo
4. Verificar que `import_jobs` registra os mesmos contadores
5. Se há divergência → tem lógica duplicada em algum lugar

---

## Refatoração prioritária (débito técnico ativo)

Ao revisar código nessas áreas, sinalizar para refatoração:

| Arquivo | Problema | Ação |
|---|---|---|
| `import-planilhas.ts` | 1200+ linhas, múltiplos parsers inline | Extrair Converters por tipo |
| `OperationalRepositories.ts` | 10+ classes num arquivo | Um arquivo por repositório |
| `src/index.ts` | Rotas registradas inline | Extrair para `interfaces/routes/` |
| Scripts CLI com mais de 80 linhas | Lógica de negócio no script | Mover para Converter ou Importer |
