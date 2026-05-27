---
name: contract-testing
description: "Auditor de contract tests entre Ports (domain/application) e Adapters (infra). Para cada interface Port, garante existência de uma suite de contrato compartilhada em __contracts__/<port>.contract.ts que descreve TODAS as obrigações. Garante que TODO adapter daquele port (in-memory + TypeORM, no mínimo) roda essa suite. Detecta drift entre adapters. Gera scaffolds de contract suite sob demanda. Reporta ports sem suite + adapters que não rodam suite + assertion gaps."
---

# Contract Testing — Ports e Adapters cumprem o mesmo comportamento

Hexagonal só funciona se **trocar de adapter é seguro**. Trocar `InMemoryProductRepository` por `ProductRepositoryTypeOrm` em produção não pode quebrar nada — esses dois precisam ser **indistinguíveis** do ponto de vista do domínio. Contract test é a prova literal disso.

## Anatomia

```
src/modules/catalog/product/
├── domain/
│   └── product.repository.ts                  ← PORT (interface)
├── application/
│   └── __test-fixtures__/
│       └── in-memory-product.repository.ts    ← ADAPTER 1 (fake)
└── infra/
    └── repositories/
        └── product.repository.typeorm.ts      ← ADAPTER 2 (real)

src/modules/catalog/product/domain/__contracts__/
└── product.repository.contract.ts             ← SUITE COMPARTILHADA
```

`*.contract.ts` exporta uma função:

```ts
export function describeProductRepositoryContract(
  name: string,
  makeRepo: () => Promise<{ repo: ProductRepository; cleanup: () => Promise<void> }>,
): void;
```

Cada adapter cria 1 spec de 5 linhas que importa e chama:

```ts
// src/modules/catalog/product/application/__test-fixtures__/in-memory-product.repository.spec.ts
import { describeProductRepositoryContract } from '../../domain/__contracts__/product.repository.contract';
import { InMemoryProductRepository } from './in-memory-product.repository';

describeProductRepositoryContract('InMemoryProductRepository', async () => ({
  repo: new InMemoryProductRepository(),
  cleanup: async () => {},
}));
```

```ts
// test/contracts/product.repository.typeorm.contract.spec.ts
import { describeProductRepositoryContract } from '../../src/modules/catalog/product/domain/__contracts__/product.repository.contract';
import { ProductRepositoryTypeOrm } from '../../src/modules/catalog/product/infra/repositories/product.repository.typeorm';
import { startCatalogTestBed, truncateCatalog } from '../helpers/catalog-test-bed';

describeProductRepositoryContract('ProductRepositoryTypeOrm', async () => {
  const bed = await startCatalogTestBed();
  return {
    repo: new ProductRepositoryTypeOrm(bed.dataSource),
    cleanup: async () => {
      await truncateCatalog(bed.dataSource);
      await bed.stop();
    },
  };
});
```

---

## Princípios

1. **Toda port tem contract suite, sem exceção.** Adapter sem contract suite = você nem sabe se ele cumpre o contrato.
2. **Adapter novo NÃO precisa de spec próprio.** Ele só importa a contract suite. Duplicar a lógica do spec é red flag.
3. **Contract testa COMPORTAMENTO, não implementação.** Sem `expect(typeorm.createQueryBuilder).toHaveBeenCalled()` — isso é teste de implementação.
4. **Contract roda TODAS as obrigações** que aparecem na docstring da interface.

---

## Identificação de Ports (heurística)

Uma interface é um Port se:
- está em `domain/` ou `application/` (não em infra ou presentation)
- termina em `Repository`, `Service`, `Port`, `Gateway`, `Publisher`, `Producer`, `Notifier`, `Client`
- é decorada/anotada como tal (ou é `interface X` ou `abstract class X`)

```bash
# Lista candidatos
grep -rlE "(export\s+(interface|abstract\s+class)\s+\w+(Repository|Service|Port|Gateway|Publisher|Producer|Notifier|Client)\b)" \
  src/modules/*/*/domain src/modules/*/*/application src/shared/domain src/shared/application 2>/dev/null
```

Para cada arquivo retornado, é um Port a auditar.

---

## Protocolo de auditoria

### Passo 1 — Listar ports e adapters

```bash
# Ports
PORTS=$(grep -rlE "(export\s+(interface|abstract\s+class)\s+\w+(Repository|Service|Port|Gateway|Publisher|Producer|Notifier|Client)\b)" \
  src/modules/*/*/domain src/modules/*/*/application src/shared/domain src/shared/application 2>/dev/null)

# Adapters por port (heurística: arquivos que implementam, em infra/ ou __test-fixtures__/)
# Para cada port, busque `implements <PortName>` ou `extends <PortName>`
```

Para cada Port `XxxRepository`:

```bash
grep -rlE "(implements|extends)\s+XxxRepository\b" src/ --include='*.ts'
```

Conta de adapters por port.

### Passo 2 — Localizar contract suites

```bash
# Convenção: src/.../domain/__contracts__/<port>.contract.ts
find src -path '*__contracts__*' -name '*.contract.ts'
```

Para cada Port, checa se existe `<port-name>.contract.ts` no `__contracts__/` ao lado.

### Passo 3 — Auditoria por port

Para CADA port detectado:

| Check | BLOCKER se |
|---|---|
| Existe `<port>.contract.ts` | Não existe |
| Exporta `describe<PortName>Contract(name, makeRepo)` | Função não existe ou assinatura difere |
| Tem ≥1 `describe(...)` interno e ≥1 `it(...)` por método público do port | Faltam métodos sem cobertura |
| Cada adapter conhecido tem 1 spec chamando a contract | Adapter ignora a contract |
| Contract testa errors (ex: `notFound`, `duplicate`) | Só testa happy path |
| Contract testa side-effects (ex: events publicados pelo repo) | Não |

### Passo 4 — Cobertura de obrigações

Pegue a interface do Port (`Read`) e extraia métodos:

```ts
export interface ProductRepository {
  save(product: Product): Promise<void>;
  findById(id: ProductId): Promise<Product | null>;
  delete(id: ProductId): Promise<void>;
  // ...
}
```

Para cada método, na contract suite, deve haver ≥1 `it(...)` cuja descrição menciona o método (heurística):

```bash
grep -nE "it\s*\(\s*['\"].*(save|find|delete|exists|nextId)" <contract-file>
```

Método sem caso → BLOCKER.

### Passo 5 — Adapters não rodam a suite

Para cada adapter (`implements <Port>`), busca spec correspondente:

```bash
# adapter src/.../foo.typeorm.ts → procurar spec que importa o contract
ADAPTER="src/modules/catalog/product/infra/repositories/product.repository.typeorm.ts"
grep -rln "describeProductRepositoryContract" src test --include='*.ts' \
  | xargs grep -l "$ADAPTER" 2>/dev/null
```

Se zero resultados → BLOCKER: adapter não roda contract.

### Passo 6 — Drift entre adapters

Conceitualmente: se o spec do `InMemory` passa e o do `TypeORM` falha (ou vice-versa) na MESMA contract, há drift. Rode a contract suite e compare:

```bash
npx jest --testPathPattern='\.contract\.spec\.ts$' --runInBand --verbose 2>&1 | tail -100
```

Reporte falhas com nome do adapter + caso da contract.

### Passo 7 — Geração de scaffold (sob demanda)

Se `gerar contract suites faltantes`, para cada Port sem `<port>.contract.ts`, crie:

```ts
// src/modules/catalog/product/domain/__contracts__/product.repository.contract.ts
import type { ProductRepository } from '../product.repository';
import { Product } from '../product';
import { ProductId } from '../value-objects/product-id';
import { ProductName } from '../value-objects/product-name';
import { CategoryId } from '../../../category/domain/value-objects/category-id';
import { Attribute } from '../value-objects/attribute';

export interface ContractDeps {
  repo: ProductRepository;
  cleanup: () => Promise<void>;
}

export function describeProductRepositoryContract(
  adapterName: string,
  makeDeps: () => Promise<ContractDeps>,
): void {
  describe(`contract: ProductRepository — ${adapterName}`, () => {
    let deps: ContractDeps;
    let repo: ProductRepository;

    beforeAll(async () => {
      deps = await makeDeps();
      repo = deps.repo;
    });

    afterAll(async () => {
      await deps.cleanup();
    });

    describe('save + findById', () => {
      it('persists a product and rehydrates by id', async () => {
        const product = Product.create({
          id: ProductId.of('11111111-1111-4111-8111-111111111111'),
          name: ProductName.of('Phone'),
        });
        await repo.save(product);

        const loaded = await repo.findById(product.id);
        expect(loaded).not.toBeNull();
        expect(loaded?.id.value).toBe(product.id.value);
        expect(loaded?.name.value).toBe('Phone');
      });

      it('returns null for unknown id', async () => {
        const id = ProductId.of('22222222-2222-4222-8222-222222222222');
        const loaded = await repo.findById(id);
        expect(loaded).toBeNull();
      });

      it('upserts on second save (no duplicate)', async () => {
        const product = Product.create({
          id: ProductId.of('33333333-3333-4333-8333-333333333333'),
          name: ProductName.of('Tablet'),
        });
        await repo.save(product);
        product.rename(ProductName.of('Tablet Pro'));
        await repo.save(product);

        const loaded = await repo.findById(product.id);
        expect(loaded?.name.value).toBe('Tablet Pro');
      });
    });

    describe('aggregate boundaries', () => {
      it('persists categories of an active product', async () => {
        const product = Product.create({
          id: ProductId.of('44444444-4444-4444-8444-444444444444'),
          name: ProductName.of('Laptop'),
        });
        const cat = CategoryId.of('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        product.attachCategory(cat);
        product.addAttribute(Attribute.of('color', 'silver'));
        product.activate();
        await repo.save(product);

        const loaded = await repo.findById(product.id);
        expect(loaded?.categoryIds.map((c) => c.value)).toContain(cat.value);
        expect(loaded?.attributes.toArray()).toHaveLength(1);
      });
    });

    // adicione um describe('errors') quando o port modelar exceptions:
    // - DuplicatedAggregateError, OptimisticConcurrencyError, etc.
  });
}
```

E os 2 specs finos (1 por adapter) — ver "Anatomia" no topo.

### Passo 8 — Saída

```
[OK|BLOCKER] ports com contract suite: <N>/<T_ports>
[OK|BLOCKER] adapters rodando contract: <N>/<T_adapters>
[OK|BLOCKER] obrigações cobertas: <N>/<T_methods>
[OK|BLOCKER] sem drift (contract verde em todos os adapters)

Ports sem contract suite:
  src/modules/catalog/category/domain/category.repository.ts
    criar: src/modules/catalog/category/domain/__contracts__/category.repository.contract.ts
    métodos a cobrir: save, findById, findByName, delete

Adapters não rodando contract:
  src/modules/catalog/category/infra/repositories/category.repository.typeorm.ts
    criar: test/contracts/category.repository.typeorm.contract.spec.ts
    template:
      describeCategoryRepositoryContract('CategoryRepositoryTypeOrm', async () => { ... })

Métodos sem cobertura na contract:
  ProductRepository.delete()  — sem it() correspondente em product.repository.contract.ts

Drift detectado:
  contract ProductRepository — ProductRepositoryTypeOrm > save + findById > persists ...
    InMemory: PASS
    TypeORM:  FAIL (rehydrate perde events; check mapper)

Comando:
  $ npx jest --testPathPattern='\.contract\.spec\.ts$' --runInBand
```

---

## Anti-padrões

- ❌ Contract acessar internals do adapter (ex: `expect(repo.dataSource).toBeDefined()`)
- ❌ Contract com mocks (mock anula o ponto do contract)
- ❌ Adapter com spec **independente** que duplica casos da contract — refactor pra usar a contract
- ❌ Contract dependendo de ordem de execução (cada `it` deve ser isolado; use `beforeEach` + cleanup)
- ❌ TypeORM contract sem Testcontainers (rodar contra Postgres compartilhado é flaky)
- ❌ Esquecer de adicionar caso pra novo método quando o port cresce

---

## Quando ABORTAR

- Testcontainers timeout durante contract → ABORTA
- Port com herança múltipla / mixin (heurística não pega) → ABORTA, peça lista manual

---

## Limites

- Não escreve a contract pra você quando o comportamento esperado não é claro (peça ao `architect` ou ao `backend-dev`)
- Não diferencia "intended drift" (adapter com superpoder) de bug — toda divergência = BLOCKER até prova em contrário
