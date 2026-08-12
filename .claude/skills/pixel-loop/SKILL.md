---
name: pixel-loop
description: "Loop de fidelidade visual web (enlite-frontend) contra o Figma que ITERA até o score estrutural ≥95% ou esgotar o teto de iterações. Mede semelhança por elemento (dimensão/cor/espaçamento/tipografia dentro de tolerância) — NÃO por pixel bruto (antialiasing WebGL vs browser já dá 5-20% de diff numa impl fiel, logo pixel-95% nunca converge). Aplica fixes, re-mede, repete. Reusa a extração do /pixel-check. Use quando o user pedir 'pixel perfect', 'idêntico ao Figma', 'até ficar igual'."
---

# Pixel Loop — iterar até ≥95% estrutural vs Figma

Estende o `/pixel-check` (one-shot) para um **loop com métrica que converge**. O `/pixel-check` mede e reporta uma vez; esta skill mede → corrige → re-mede até o corte.

## Por que estrutural e não pixel bruto

Comparar render do Figma (WebGL/antialiasing próprio) com screenshot do browser (CoreText/subpixel) dá **5-20% de diff de pixel mesmo numa implementação perfeita** — está documentado no `/qa-visual`. Um loop mirando "95% de pixels idênticos" **roda pra sempre**. Por isso o score aqui é **estrutural**: por propriedade medida com tolerância, imune a ruído de rendering.

## Pré-condição dura (checar ANTES de qualquer coisa)

Figma MCP autorizado. Rode `mcp__figma__get_design_context` no node alvo. Se falhar por auth:

```
BLOQUEADO: Figma MCP não autorizado. Reautorize via /mcp (server "figma") numa sessão interativa. Sem isso não há fonte de verdade — não há como medir. Parando.
```

Não invente medidas do Figma a partir do código. Sem MCP, para.

## Definição do score (auditável, converge)

Para cada elemento no mapa `nodeId ↔ seletor CSS`, comparar estas propriedades:

| Propriedade | Fonte Figma (Plugin API) | Fonte impl | Tolerância |
|---|---|---|---|
| width / height | `n.width` / `n.height` | Playwright `boundingBox()` | ±2px |
| x / y relativo ao pai | `n.x` / `n.y` | boundingBox relativo | ±2px |
| padding (4 lados) | `n.paddingTop/Right/Bottom/Left` | `getComputedStyle().padding*` | ±2px |
| gap (itemSpacing) | `n.itemSpacing` | `getComputedStyle().gap` | ±2px |
| font-size | TEXT `n.fontSize` | `getComputedStyle().fontSize` | exato |
| font-weight | `n.fontName.style` → peso | `fontWeight` | exato |
| line-height | `n.lineHeight` | `lineHeight` | ±1px |
| letter-spacing | `n.letterSpacing` | `letterSpacing` | ±0.2px |
| color / background | `fills` → hex | `color`/`backgroundColor` | hex exato |
| border-radius | `n.cornerRadius` | `borderRadius` | ±1px |

- **`score = props_dentro_da_tolerância / props_comparadas × 100`**.
- **Gate de corte: `score ≥ 95` E zero elemento 🔴.** Um elemento é 🔴 se: dimensão diverge >8px, OU cor totalmente diferente (não só shade), OU elemento ausente. Um único 🔴 reprova mesmo com score ≥95 — média alta não pode esconder um bloqueante.
- Reportar sempre o **denominador** (`props_comparadas`) e o **mapa** usado. Score sem mapa não vale (princípio: evidência, não afirmação).

## Protocolo do loop (teto: 5 iterações)

Delegue a medição pesada a um subagente `general-purpose` para não poluir o contexto principal — ele roda Figma Plugin API + Playwright e devolve só o JSON do score + lista de props fora de tolerância.

```
iteração = 0
enquanto iteração < 5:
  1. MEDIR (subagente): extrai Figma (Plugin API) + impl (Playwright screenshot 1× + getComputedStyle),
     calcula score conforme tabela, devolve { score, props_comparadas, falhas: [{el, prop, figma, impl, delta}], blockers: [...] }
  2. SE score ≥ 95 E blockers vazio  → SUCESSO, sair do loop
  3. APLICAR FIXES: para cada falha, ajustar o componente (preferir design tokens do projeto —
     text-4xl, gap-N, tokens de cor — nunca valor arbitrário se o token existe).
     Fixes seguem TODAS as lições do /pixel-check (text-box-trim pra cap-height, className chega no elemento certo,
     glyph de ícone via SVG do Figma, padding assimétrico, deviceScaleFactor:1).
  4. iteração += 1
```

### Regras de convergência (críticas)

- **Nunca declarar sucesso sem re-medir.** O score que vale é o da última medição, não a expectativa pós-fix.
- **Retorno parcial é obrigatório e honesto.** Se após 5 iterações `score < 95`, PARE e reporte o score real + as falhas remanescentes + por que não convergiu (ex: design system não tem o tamanho exato, fonte não bate). **Proibido forçar "95%" arredondando ou removendo elementos difíceis do mapa.**
- **Se o score regredir entre iterações**, reverter o último fix e reportar o conflito — um ajuste quebrou outro.
- **Screenshot sempre `deviceScaleFactor: 1`** e com o estado (auth/user stores) populado, senão elementos vazios falseiam o score.

## Output estruturado (fixo)

```markdown
## Pixel Loop: [feature] — [estado]
**Figma node:** [nodeId] · **URL:** [local-url] · **Mapa:** N elementos
**Iterações:** [k]/5

| Iteração | Score | Blockers | Props fora |
|---|---|---|---|
| 0 | 78% | 2 | 9/41 |
| ... | ... | ... | ... |
| k | 96% | 0 | 2/41 |

### Falhas remanescentes (se houver)
| Elemento | Prop | Figma | Impl | Δ | Por que não fechou |
|---|---|---|---|---|---|

### Veredicto
✅ Convergiu — score [X]% ≥ 95, zero blocker
⚠ NÃO convergiu em 5 iterações — score real [X]%, [N] falhas remanescentes (detalhe acima). NÃO está pixel perfect.

### Evidência
- Composite side-by-side: [path do magick montage figma|impl]
- Mapa nodeId↔seletor usado: [inline ou path]
```

## Critérios de exclusão (não entram no loop)

- Node do Figma que é só `RECTANGLE`/`VECTOR` isolado sem layout → subir ao FRAME/GROUP pai antes (senão o mapa é lixo).
- Elemento que depende de dado que não dá pra simular → documentar como limitação, NÃO contar no denominador.
- Diferença de sub-pixel font rendering → nunca é falha (é ruído esperado).
