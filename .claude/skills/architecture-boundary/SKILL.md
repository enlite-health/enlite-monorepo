---
name: architecture-boundary
description: "Auditor de fronteiras arquiteturais Hexagonal/DDD. Bloqueia: domain importando NestJS/TypeORM/Express, application importando infra/presentation, cross-aggregate por instância (em vez de por ID), entidade ORM fora de infra, DTO fora de presentation, env.var direto fora do AppConfigService, módulos circular. Usa dependency-cruiser + ESLint + grep. Setup idempotente do dependency-cruiser se ausente. Reporta violação file:line + regra + camada esperada vs encontrada."
---

# Architecture Boundary — fronteiras hexagonais automatizadas

Domínio puro é a primeira coisa que apodrece sob pressão. Esta skill garante por máquina (não por revisão humana) que **toda dependência cruza a fronteira no sentido certo**.

## Topologia (fonte da verdade)

```
              presentation/  ─┐
                              │
              application/ ◄──┤
                  ▲           │
                  │           │
                  │           ▼
              domain/  ◄────  infra/
              ───────
              (puro: nem framework, nem ORM, nem HTTP)
```

- **Sentido de dependência permitido:** `presentation → application → domain ← infra`
- **Sentido proibido:** qualquer seta invertida
- **Cross-module:** só através de `application/queries|commands` ou eventos publicados — nunca importando `domain/` de outro módulo direto, exceto VOs de identidade (`<Outro>Id`)

## Princípios

1. **Regra é tabular, não interpretativa.** Toda violação tem regra numerada (5.1–5.10).
2. **Evidência tem que ser scan-replicável.** O `grep`/`depcruise` que pegou a violação aparece no output.
3. **Sem exceção sem comentário.** Se um arquivo precisa furar a regra (raríssimo), exige `// arch-allow <regra>: <razão>` no topo. Sem isso = BLOCKER.
4. **Diretório vazio não conta como violação.** Camada sem `.ts` é OK.

---

## Setup canônico (idempotente)

### S.1 — Instalar `dependency-cruiser`

```bash
ls node_modules/dependency-cruiser 2>/dev/null || \
  npm install --save-dev dependency-cruiser@16
```

### S.2 — Criar `.dependency-cruiser.cjs` na raiz

```js
/** Dependency-cruiser config — fronteiras hexagonais para NestJS + DDD + TypeORM */
module.exports = {
  forbidden: [
    {
      name: 'domain-must-be-pure',
      severity: 'error',
      comment: 'Domain layer cannot import framework, ORM, HTTP, or messaging libs.',
      from: { path: '(^src/modules/[^/]+/[^/]+/domain)|(^src/shared/domain)' },
      to: {
        path: [
          '^node_modules/@nestjs',
          '^node_modules/typeorm',
          '^node_modules/express',
          '^node_modules/amqplib',
          '^node_modules/amqp-connection-manager',
          '^node_modules/@golevelup/nestjs-rabbitmq',
          '^node_modules/pg',
          '^node_modules/nestjs-pino',
          '^node_modules/pino-http',
          '^node_modules/joi',
          '^node_modules/dotenv',
          '^node_modules/@nestjs/cqrs',
        ],
      },
    },
    {
      name: 'domain-cannot-import-application-infra-presentation',
      severity: 'error',
      from: { path: '(^src/modules/[^/]+/[^/]+/domain)|(^src/shared/domain)' },
      to: { path: '(/application/)|(/infra/)|(/presentation/)' },
    },
    {
      name: 'application-cannot-import-infra-presentation',
      severity: 'error',
      from: { path: '(^src/modules/[^/]+/[^/]+/application)|(^src/shared/application)' },
      to: { path: '(/infra/)|(/presentation/)' },
    },
    {
      name: 'infra-cannot-import-presentation',
      severity: 'error',
      from: { path: '/infra/' },
      to: { path: '/presentation/' },
    },
    {
      name: 'shared-cannot-import-modules',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-orm-entity-outside-infra',
      severity: 'error',
      comment: 'TypeORM entities (*.entity.ts) só podem ser importadas por código em /infra/.',
      from: { pathNot: '/infra/' },
      to: { path: '\\.entity\\.ts$' },
    },
    {
      name: 'no-dto-outside-presentation',
      severity: 'error',
      from: { pathNot: '/presentation/' },
      to: { path: '\\.(dto|request|response)\\.ts$' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphan-source',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: '\\.(spec|e2e-spec)\\.ts$|/__test-fixtures__/|/migrations/',
      },
      to: {},
    },
    {
      name: 'no-deprecated-core',
      severity: 'warn',
      from: {},
      to: { dependencyTypes: ['deprecated'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: { collapsePattern: '^node_modules/[^/]+' },
      archi: {
        collapsePattern: '^(src/modules/[^/]+/[^/]+/(domain|application|infra|presentation))|(src/shared/[^/]+)',
      },
    },
  },
};
```

### S.3 — Scripts no `package.json`

```json
{
  "scripts": {
    "arch:check": "depcruise --config .dependency-cruiser.cjs src --output-type err",
    "arch:graph": "depcruise --config .dependency-cruiser.cjs src --output-type dot | dot -T svg -o reports/arch/dependency-graph.svg",
    "arch:archi": "depcruise --config .dependency-cruiser.cjs src --output-type archi | dot -T svg -o reports/arch/archi-diagram.svg"
  }
}
```

### S.4 — ESLint complementar (`.eslintrc.cjs`)

Adicione ao `rules` do `.eslintrc.cjs`:

```js
'no-restricted-imports': ['error', {
  patterns: [
    // domain puro
    { group: ['**/infra/**', '**/application/**', '**/presentation/**'], message: 'Domain layer não pode importar de infra/application/presentation.' },
    { group: ['@nestjs/*', 'typeorm', 'express', 'amqplib', '@golevelup/*'], message: 'Domain puro. Use Port + Adapter.' },
  ],
}],
```

> ESLint só pega a importação *escrita*, não a transitiva. dependency-cruiser pega ambas. Mantenha os 2.

---

## Protocolo de auditoria

### Passo 1 — Escopo

- `branch` → cruza apenas com `git diff --name-only`, mas roda depcruise no `src` inteiro (depcruise não suporta lista parcial). Filtra violações depois.
- `full` → `src`
- lista → roda `src` e filtra pelos paths informados

### Passo 2 — Rodar dependency-cruiser

```bash
mkdir -p reports/arch
npx depcruise --config .dependency-cruiser.cjs src --output-type err 2>&1
```

Exit 0 → sem `error` violations. Stderr formatado:

```
  error no-circular: src/modules/x/domain/a.ts → src/modules/x/application/b.ts → src/modules/x/domain/a.ts
```

Salve o output bruto.

### Passo 3 — Scans complementares por grep (defesa em profundidade)

#### 3.1 — Framework no domínio (regra 5.1)

```bash
grep -rnHE "from\s+['\"]@nestjs/" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
grep -rnHE "from\s+['\"]typeorm['\"]" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
grep -rnHE "from\s+['\"]express['\"]" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
grep -rnHE "@(Entity|Column|Injectable|Controller|Get|Post|Body|Param|Inject)\(" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
```

#### 3.2 — Camada baixa importando alta (regra 5.2)

```bash
grep -rnHE "from\s+['\"].*/(infra|application|presentation)/" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
grep -rnHE "from\s+['\"].*/(infra|presentation)/" src/modules/*/*/application/ src/shared/application/ 2>/dev/null || true
```

#### 3.3 — Entidade ORM fora de infra (regra 5.3)

```bash
grep -rnHE "from\s+['\"].*\.entity['\"]" src/ --include='*.ts' \
  | grep -v "/infra/" \
  | grep -v "/__test-fixtures__/" || true
```

#### 3.4 — DTO/Request/Response fora de presentation (regra 5.4)

```bash
grep -rnHE "from\s+['\"].*\.(dto|request|response)['\"]" src/ --include='*.ts' \
  | grep -v "/presentation/" || true
```

#### 3.5 — Cross-aggregate por instância (regra 5.5)

Para CADA agregado X, ver se `domain/X.ts` (e arquivos de domain dentro) importa outro agregado Y como classe (não como `YId` VO):

```bash
# heurística: import de '../<agg>/domain/<agg>' fora do próprio agg
grep -rnHE "from\s+['\"]\.\.\/\.\.\/[a-z]+\/domain\/[a-z]+['\"]" src/modules/*/*/domain/ \
  | grep -vE "value-objects/" || true
```

Inspecione cada match. Se importa `Product` ou `Category` (classe agregado) em vez de `ProductId`/`CategoryId`, é BLOCKER.

#### 3.6 — Cross-module via shared (regra 5.6)

```bash
grep -rnHE "from\s+['\"].*\/modules\/" src/shared/ 2>/dev/null || true
```

#### 3.7 — env.var direto (regra 5.7)

```bash
grep -rnH "process\.env\." src/ --include='*.ts' \
  | grep -vE "env\.validation\.ts|app-config\.service\.ts|data-source\.ts|main\.ts" || true
```

#### 3.8 — Decorator NestJS no domínio

```bash
grep -rnHE "^\s*@[A-Z][A-Za-z]+\(" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
```

Decorator em domain → BLOCKER. (Exceção zero — VOs e Aggregates são POJO + função.)

#### 3.9 — Logger NestJS no domínio

```bash
grep -rnHE "from\s+['\"]@nestjs/common['\"]" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
grep -rnHE "(Logger|Inject|Injectable)" src/modules/*/*/domain/ src/shared/domain/ 2>/dev/null || true
```

#### 3.10 — Allow comments sem justificativa

```bash
grep -rnH "arch-allow" src/ --include='*.ts' | grep -vE "arch-allow\s+[0-9]+\.[0-9]+:\s+.+" || true
```

### Passo 4 — Diagrama (informativo)

Se `graphviz` (`dot`) está instalado:

```bash
which dot >/dev/null 2>&1 && npm run arch:archi || echo "graphviz ausente, pulando diagrama"
```

Mencione path do SVG no output (se gerado).

### Passo 5 — Saída

```
[OK|BLOCKER] depcruise (forbidden rules)
[OK|BLOCKER] 5.1 — framework/ORM/HTTP fora de domain
[OK|BLOCKER] 5.2 — direção da seta (low→high apenas)
[OK|BLOCKER] 5.3 — *.entity.ts contido em infra
[OK|BLOCKER] 5.4 — *.dto/*.request/*.response contido em presentation
[OK|BLOCKER] 5.5 — cross-aggregate por ID
[OK|BLOCKER] 5.6 — shared não importa de modules
[OK|BLOCKER] 5.7 — process.env só em env.validation/app-config/data-source/main
[OK|BLOCKER] 5.8 — decorator NestJS fora do domain
[OK|BLOCKER] 5.9 — Logger/Inject/Injectable fora do domain
[OK|BLOCKER] sem ciclo de dependência

Violações:
  src/modules/catalog/product/domain/product.repository.ts:1
    regra: 5.1 (framework no domain)
    evidência: $ grep -rnHE "from '@nestjs/"
      src/.../product.repository.ts:1: import { Injectable } from '@nestjs/common';
    esperado: domain define INTERFACE (port); @Injectable mora na implementação em infra.
    fix: mover @Injectable pra src/.../infra/repositories/product.repository.typeorm.ts

  ...

Allow comments sem justificativa:
  src/.../foo.ts:1   // arch-allow 5.1   ← falta razão

Comando:
  $ npx depcruise --config .dependency-cruiser.cjs src --output-type err
Diagrama: reports/arch/archi-diagram.svg (se graphviz disponível)
```

---

## Anti-padrões

- ❌ Aceitar depcruise warn-only — toda violação de fronteira é `error`
- ❌ Excluir arquivo do scan ("não conta") sem comentário `// arch-allow X.Y: razão`
- ❌ Mover decorator pro próprio agregado pra silenciar regra — quebra o motivo do hexagonal
- ❌ Importar `*Repository` (interface) de `infra/` em vez de `domain/` — port mora em domain
- ❌ Re-exportar entidade ORM via barrel `index.ts` em domain pra "compatibilidade"

---

## Quando ABORTAR

- `dependency-cruiser` não instalado e `npm install` falhou → ABORTA
- `tsconfig.json` malformado (depcruise não resolve paths) → ABORTA
- `graphviz` ausente é WARN (diagrama opcional), não ABORTA

---

## Limites

- Não corrige imports (peça ao `backend-dev` ou orienta o user)
- Não decide se uma exceção é legítima (delega ao `architect` — exige ADR)
- Não roda em arquivos de teste por padrão (regras hexagonais não se aplicam lá)
