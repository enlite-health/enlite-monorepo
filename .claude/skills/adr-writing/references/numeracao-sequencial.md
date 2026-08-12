# Numeração sequencial de ADRs

ADRs são numerados sequencialmente a partir de `001`, com zero-padding de 3 dígitos. Numeração é derivada do filesystem — não há registro paralelo de "último número usado".

---

## Protocolo

### Passo 1 — Verificar/criar diretório

```bash
ls /Users/gabrielstein-dev/projects/enlite/infra/docs/adr/ 2>/dev/null || mkdir -p /Users/gabrielstein-dev/projects/enlite/infra/docs/adr/
```

Se o diretório não existe, criar. Se já existe, prosseguir.

### Passo 2 — Listar ADRs existentes

```bash
ls /Users/gabrielstein-dev/projects/enlite/infra/docs/adr/ 2>/dev/null | grep -E '^[0-9]{3}-' | sort -n
```

Resultado esperado: lista ordenada de arquivos `NNN-titulo.md`. Vazio se nenhum ADR existe ainda.

### Passo 3 — Calcular próximo número

- Se a lista do Passo 2 está vazia → próximo número = **001**
- Se há ADRs → pegar o maior número e incrementar (com zero-padding 3 dígitos):
  - `042-foo.md` → próximo é `043`
  - `099-bar.md` → próximo é `100`
  - `001-baz.md` → próximo é `002`

### Passo 4 — Verificar colisão (defensivo)

Antes de escrever, conferir que o arquivo `docs/adr/<NNN>-<titulo>.md` NÃO existe. Se existir (race condition entre paralelos), reincrementar 1 e tentar de novo.

```bash
test -e /Users/gabrielstein-dev/projects/enlite/infra/docs/adr/NNN-titulo.md && echo "EXISTS" || echo "OK"
```

---

## Convenção de nome do arquivo

`<NNN>-<titulo-kebab>.md`

- `<NNN>` — número com 3 dígitos zero-padded (`001`, `042`, `100`)
- `<titulo-kebab>` — título em kebab-case, 4-7 palavras, sem ponto final
  - Exemplos válidos: `extrair-triage-service`, `encuadres-unique-constraint-f5`, `deprecar-application-status`
  - Exemplos inválidos: `EncuadresUniqueConstraint` (camelCase), `001 encuadres unique` (espaços), `encuadres-unique-constraint-f5.` (ponto final)

---

## Casos extremos

### ADR substituto (Superseded by)

Quando criar um ADR que substitui um existente:
- O novo recebe número sequencial normal (não "reusa" o número antigo)
- O ADR antigo tem seu Status atualizado para `Superseded by ADR-NNN`
- O novo ADR cita o substituído em References

### Numeração não-contígua

Aceitável. Se ADR-042 foi deletado manualmente (não deveria, mas aconteceu), o próximo continua sendo `max+1`, não `042`. Não há renumeração retroativa.

### Race condition

Se 2 ADRs são criados em "paralelo" (segundo agent escreve antes do primeiro terminar):
- Segundo agent deve **reler** o FS antes de escrever
- Se mesmo assim colidir, incrementar até achar slot livre
- Nunca sobrescrever

---

## Output esperado da fase

Após completar a numeração, o caller deve ter em mãos:

- `proximo_numero` (string com 3 dígitos): ex. `"048"`
- `nome_arquivo` (string): ex. `"048-encuadres-unique-constraint-f5.md"`
- `path_absoluto` (string): ex. `"/Users/gabrielstein-dev/projects/enlite/infra/docs/adr/048-encuadres-unique-constraint-f5.md"`

Esses 3 valores entram na Fase 2 (template) e Fase 3 (persistir).
