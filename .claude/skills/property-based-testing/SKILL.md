---
name: property-based-testing
description: "Auditor de property-based testing com fast-check. Para cada Value Object e Aggregate Root do domínio, garante que existe spec dedicado .property.spec.ts cobrindo invariantes (idempotência, comutatividade, simetria, round-trip, monotonia, fronteiras) com ≥100 runs. Lista VOs/Aggregates sem spec property, gera scaffolds quando solicitado, e bloqueia se invariante crítica não está testada. Setup do fast-check idempotente. Não substitui unit tests example-based — complementa."
---

# Property-Based Testing — invariantes do domínio testadas com fast-check

Unit tests "example-based" provam que o código funciona com os exemplos que você escolheu. Property-based testing prova que ele funciona com **centenas de exemplos gerados aleatoriamente** que respeitam um shape — e se quebrar, o fast-check **encolhe** (shrinking) até o mínimo contra-exemplo. É o que pega bugs em VOs e Aggregates que ninguém pensou.

## Princípios

1. **Todo VO precisa de property spec.** O ponto do VO é capturar invariantes — propriedades são a prova literal.
2. **Todo Aggregate precisa de property spec pras invariantes da máquina de estados.** "Não posso ativar sem categoria" é uma propriedade.
3. **≥100 runs por propriedade.** Default do fast-check é 100; aceito. <100 = BLOCKER.
4. **Sem `fc.constantFrom([...])` substituindo geração.** Se o input gerável vira lista fixa, é só example-based fantasiado.
5. **Sempre teste shrinking funciona.** Asserte que falhas produzem contra-exemplo mínimo — não basta gerar, tem que shrinkar.

---

## Setup canônico (idempotente)

### S.1 — Instalar `fast-check`

```bash
ls node_modules/fast-check 2>/dev/null || npm install --save-dev fast-check@3
```

### S.2 — Convenção de nome

| Tipo de teste | Arquivo |
|---|---|
| Example-based existente | `foo.spec.ts` |
| Property-based novo | `foo.property.spec.ts` |

Co-localizado com o source (mesma pasta).

### S.3 — Arbitraries reutilizáveis

Criar `src/shared/domain/__test-fixtures__/arbitraries.ts`:

```ts
import * as fc from 'fast-check';

// strings sem espaço-em-branco-puro, com tamanho controlado
export const arbName = (min = 1, max = 80) =>
  fc.string({ minLength: min, maxLength: max }).filter((s) => s.trim().length >= min);

// UUID v4 válido
export const arbUuid = (): fc.Arbitrary<string> => fc.uuid({ version: 4 });

// slug kebab-case
export const arbSlug = (): fc.Arbitrary<string> =>
  fc
    .array(fc.stringMatching(/^[a-z0-9]+$/), { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join('-'));

// inteiro positivo
export const arbPositiveInt = (max = 1_000_000): fc.Arbitrary<number> =>
  fc.integer({ min: 1, max });

// money em centavos (>=0)
export const arbCents = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 100_000_000 });
```

Adicione novos arbitraries específicos do domínio (`arbCategoryName`, `arbProductSku`) co-localizados ao módulo:

```ts
// src/modules/catalog/category/domain/__test-fixtures__/category-arbitraries.ts
import * as fc from 'fast-check';
import { CategoryName } from '../value-objects/category-name';

export const arbCategoryNameString = () =>
  fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length >= 1);

export const arbCategoryName = (): fc.Arbitrary<CategoryName> =>
  arbCategoryNameString().map((s) => CategoryName.of(s));
```

---

## Catálogo de propriedades obrigatórias

Para CADA VO, no mínimo:

| Propriedade | Lei |
|---|---|
| **smart constructor é total** | input válido → não joga; input inválido → joga erro tipado (não Error genérico) |
| **`equals` é reflexiva** | `vo.equals(vo) === true` |
| **`equals` é simétrica** | `a.equals(b) === b.equals(a)` |
| **`equals` é transitiva** | `a.equals(b) && b.equals(c) ⇒ a.equals(c)` |
| **`equals` consistente com `value`** | `a.equals(b) ⇔ a.value === b.value` (ou estrutural equivalente) |
| **round-trip serialize** | `VO.of(vo.value).equals(vo)` |
| **imutabilidade** | toda operação retorna nova instância (`vo === vo.someOp()` é falso quando `someOp` muda algo) |
| **rejeição de inválidos** | gere strings vazias, com whitespace puro, > maxLength, com chars proibidos → assert `expect(() => VO.of(x)).toThrow(EspecíficoError)` |

Para CADA Aggregate Root, no mínimo:

| Propriedade | Lei |
|---|---|
| **fábrica `create` produz raiz válida** | round-trip create + rehydrate(state) → mesma raiz |
| **eventos refletem mudanças** | toda transição válida grava ≥1 evento; nenhuma transição rejeitada grava evento |
| **invariantes de estado** | ex: Product.activate requer categoria E atributo — gere combinações e assert que activate só funciona quando os 2 estão presentes |
| **idempotência de operações no-op** | rename pra mesmo name → sem evento; attach categoria já presente → sem evento |
| **comutatividade quando aplicável** | attachCategory(A) então attachCategory(B) ≡ attachCategory(B) então attachCategory(A) (em estado final, não em sequência de eventos) |
| **proibição em estado terminal** | ARCHIVED bloqueia toda mutação — gere qualquer comando e assert throw `ArchivedProductIsImmutableError` |

---

## Protocolo de auditoria

### Passo 1 — Listar VOs e Aggregates

```bash
# VOs (heurística: arquivo em domain/value-objects/ ou com class XxxId, XxxName, XxxStatus)
find src/modules src/shared -path '*/domain/value-objects/*.ts' -not -name '*.spec.ts'

# Aggregates (extends AggregateRoot)
grep -rln 'extends AggregateRoot' src/modules src/shared --include='*.ts' | grep -v spec
```

Conta total → `T_vo`, `T_agg`.

### Passo 2 — Property specs existentes

```bash
find src -name '*.property.spec.ts'
# para cada um, verifique import de fast-check e ≥1 fc.assert
grep -l "import .*fast-check" src --include='*.property.spec.ts' -r
grep -l "fc.assert" src --include='*.property.spec.ts' -r
```

Cruza: para cada VO/Aggregate, há `<nome>.property.spec.ts` no mesmo diretório? Se não → BLOCKER.

### Passo 3 — Auditoria de qualidade dos specs existentes

Para CADA `.property.spec.ts`, verifique via `Read`:

| Check | Falha = |
|---|---|
| Tem `import * as fc from 'fast-check'` | WARN se importa por named só |
| Tem ≥1 `fc.assert(fc.property(...))` ou `fc.assert(fc.asyncProperty(...))` | BLOCKER se só usa `fc.sample` |
| `numRuns` (segundo arg de fc.assert) é `>= 100` (ou usa default) | BLOCKER se `numRuns < 100` |
| Sem `fc.constantFrom([...])` como único gerador | WARN se substitui geração |
| Cada propriedade tem nome descritivo (string passada ao `it`/`test` começa com "is", "preserves", "rejects", "round-trips") | WARN |
| Tem seed reprodutível em CI | WARN se ausência de `seed` no examples ou `globalConfigOptions` |

### Passo 4 — Invariantes do catálogo cobertas?

Para cada VO/Aggregate com property spec, checar que **as leis do catálogo acima** estão presentes. Heurística: `grep` por descrições no spec:

```bash
grep -nE "(equals|round.?trip|reflexive|symmetric|transitive|idempot|invariant|reject|imutab|commutat)" <spec>
```

Lei ausente em VO/Aggregate é BLOCKER quando lei é aplicável. Lei não aplicável (ex: comutatividade num VO sem ops) → omita (não é BLOCKER).

### Passo 5 — Geração de scaffold (sob demanda)

Se o user pediu "gerar property specs faltantes", para CADA VO/Aggregate sem spec, crie `<nome>.property.spec.ts` com template:

```ts
// src/modules/catalog/category/domain/value-objects/category-name.property.spec.ts
import * as fc from 'fast-check';
import { CategoryName } from './category-name';
import { InvalidCategoryNameError } from '../errors/invalid-category-name.error'; // ajuste

describe('CategoryName — properties', () => {
  it('rejects empty or whitespace-only', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.trim().length === 0),
        (s) => {
          expect(() => CategoryName.of(s)).toThrow(InvalidCategoryNameError);
        },
      ),
    );
  });

  it('round-trips via value', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length >= 1),
        (s) => {
          const a = CategoryName.of(s);
          const b = CategoryName.of(a.value);
          expect(a.equals(b)).toBe(true);
        },
      ),
    );
  });

  it('equals is reflexive', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length >= 1),
        (s) => {
          const a = CategoryName.of(s);
          expect(a.equals(a)).toBe(true);
        },
      ),
    );
  });

  it('equals is symmetric and consistent with value', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length >= 1),
        fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length >= 1),
        (x, y) => {
          const a = CategoryName.of(x);
          const b = CategoryName.of(y);
          expect(a.equals(b)).toBe(b.equals(a));
          expect(a.equals(b)).toBe(a.value === b.value);
        },
      ),
    );
  });
});
```

Para Aggregates, scaffold com **transições + invariantes** (exemplo Product):

```ts
// src/modules/catalog/product/domain/product.property.spec.ts
import * as fc from 'fast-check';
import { Product } from './product';
import { ProductId } from './value-objects/product-id';
import { ProductName } from './value-objects/product-name';
import { CategoryId } from '../../category/domain/value-objects/category-id';
import { Attribute } from './value-objects/attribute';
import { ProductCannotBeActivatedError } from './errors/product-cannot-be-activated.error';
import { ArchivedProductIsImmutableError } from './errors/archived-product-is-immutable.error';

const arbId = (): fc.Arbitrary<ProductId> => fc.uuid({ version: 4 }).map((u) => ProductId.of(u));
const arbCatId = (): fc.Arbitrary<CategoryId> => fc.uuid({ version: 4 }).map((u) => CategoryId.of(u));
const arbName = (): fc.Arbitrary<ProductName> =>
  fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length >= 1).map((s) => ProductName.of(s));
const arbAttr = (): fc.Arbitrary<Attribute> =>
  fc.record({
    key: fc.string({ minLength: 1, maxLength: 20 }),
    value: fc.string({ minLength: 1, maxLength: 60 }),
  }).map(({ key, value }) => Attribute.of(key, value));

describe('Product — invariants', () => {
  it('newly created is DRAFT and records ProductCreated', () => {
    fc.assert(
      fc.property(arbId(), arbName(), (id, name) => {
        const p = Product.create({ id, name });
        expect(p.isDraft()).toBe(true);
        const events = p.pullDomainEvents(); // ajuste pra API real
        expect(events).toHaveLength(1);
        expect(events[0].constructor.name).toBe('ProductCreated');
      }),
    );
  });

  it('activate requires at least 1 category AND 1 attribute', () => {
    fc.assert(
      fc.property(arbId(), arbName(), arbCatId(), arbAttr(), (id, name, cat, attr) => {
        const p = Product.create({ id, name });
        expect(() => p.activate()).toThrow(ProductCannotBeActivatedError);
        p.attachCategory(cat);
        expect(() => p.activate()).toThrow(ProductCannotBeActivatedError);
        p.addAttribute(attr);
        expect(() => p.activate()).not.toThrow();
        expect(p.isActive()).toBe(true);
      }),
    );
  });

  it('archived blocks every mutating operation', () => {
    fc.assert(
      fc.property(arbId(), arbName(), arbCatId(), arbAttr(), arbName(), (id, name, cat, attr, newName) => {
        const p = Product.create({ id, name });
        p.attachCategory(cat);
        p.addAttribute(attr);
        p.activate();
        p.archive();

        expect(() => p.rename(newName)).toThrow(ArchivedProductIsImmutableError);
        expect(() => p.attachCategory(cat)).toThrow(ArchivedProductIsImmutableError);
        expect(() => p.detachCategory(cat)).toThrow(ArchivedProductIsImmutableError);
        expect(() => p.addAttribute(attr)).toThrow(ArchivedProductIsImmutableError);
        expect(() => p.removeAttribute(attr.key)).toThrow(ArchivedProductIsImmutableError);
        expect(() => p.archive()).toThrow(ArchivedProductIsImmutableError);
      }),
    );
  });

  it('attachCategory is idempotent (no event on duplicate)', () => {
    fc.assert(
      fc.property(arbId(), arbName(), arbCatId(), (id, name, cat) => {
        const p = Product.create({ id, name });
        p.pullDomainEvents(); // limpa created
        p.attachCategory(cat);
        const after1 = p.pullDomainEvents();
        p.attachCategory(cat);
        const after2 = p.pullDomainEvents();
        expect(after1).toHaveLength(1);
        expect(after2).toHaveLength(0);
      }),
    );
  });

  it('rename to current name is no-op (no event)', () => {
    fc.assert(
      fc.property(arbId(), arbName(), (id, name) => {
        const p = Product.create({ id, name });
        p.pullDomainEvents();
        p.rename(name);
        expect(p.pullDomainEvents()).toHaveLength(0);
      }),
    );
  });
});
```

> Ajuste `pullDomainEvents()` ao nome real do método na implementação do projeto (`AggregateRoot`). Se for `getUncommittedEvents` / `domainEvents` / etc., use o nome real lendo `src/shared/domain/aggregate-root.ts`.

### Passo 6 — Saída

```
[OK|BLOCKER] VOs com property spec: <N>/<T_vo>
[OK|BLOCKER] Aggregates com property spec: <N>/<T_agg>
[OK|BLOCKER] Specs com numRuns ≥ 100: <N>/<N_specs>
[OK|BLOCKER] Invariantes obrigatórias cobertas

VOs/Aggregates sem property spec:
  src/modules/catalog/product/domain/value-objects/product-sku.ts
    criar:    src/modules/catalog/product/domain/value-objects/product-sku.property.spec.ts
    leis:     smart-constructor totality, equals reflex/sim/trans, round-trip, reject inválidos
  ...

Specs property abaixo do padrão:
  src/.../category-name.property.spec.ts
    falta: equals transitive, round-trip
  src/.../product.property.spec.ts
    numRuns explícito = 50 (alvo ≥ 100)

Comando:
  $ find src -name '*.property.spec.ts' | xargs -I{} npx jest {} --verbose
```

---

## Anti-padrões

- ❌ `fc.constantFrom(['foo', 'bar'])` substituindo geração — é example-based fantasiado
- ❌ Propriedade que faz só `expect(true).toBe(true)` — escreve a invariante real
- ❌ Property spec dentro de `*.spec.ts` (junto com example-based) — confunde, separe em `.property.spec.ts`
- ❌ Asserção indo só pelo resultado feliz, sem `expect(...).toThrow(...)` pra inputs inválidos
- ❌ Decrementar `numRuns` pra acelerar CI — em vez disso, melhora arbitrary pra ser mais barato
- ❌ Não testar shrinking — quando uma propriedade falha em PR, o contra-exemplo precisa ser mínimo, senão o diagnóstico é caro

---

## Quando ABORTAR

- `fast-check` não instalado e `npm install` falhou → ABORTA
- Spec gera `Stack overflow` (shrinking infinito) → ABORTA com indicação do spec
- Geração demora >30s por propriedade → ABORTA, peça pra reduzir arbitrary

---

## Limites

- Não escreve a invariante por você se ela não está clara na implementação — pergunta ao architect
- Não substitui mutation-testing (são complementares)
- Não testa side-effects (rede, DB) — pra isso use integration tests
