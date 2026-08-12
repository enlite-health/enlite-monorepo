# Status lifecycle de ADRs

ADRs têm ciclo de vida com 5 estados. Transições obedecem regras específicas — a skill `adr-writing` **só cria ADRs em `Proposed`**; demais transições exigem ação humana ou criação de ADR substituto.

---

## Estados

| Status | Significado | Quem move | Quando |
|---|---|---|---|
| **Proposed** | Architect propôs, aguarda revisão humana | Sistema (criação automática) | Toda criação nova |
| **Accepted** | PO + Gabriel validaram; decisão vigente | Humano (PO ou Gabriel) via edit manual | Após review |
| **Rejected** | Discussão concluída sem adoção | Humano via edit manual | Após review |
| **Deprecated** | Decisão antiga, substituída por contexto/realidade | Architect ao criar ADR substituto | Quando contexto mudou |
| **Superseded by ADR-NNN** | Substituída por outra decisão formal | Architect ao criar ADR substituto | Quando nova decisão invalida a antiga |

---

## Diagrama de transições válidas

```
                  ┌─────────┐
   criar  ───────▶│Proposed │
                  └─────────┘
                       │
        ┌──────────────┼───────────────┐
        │              │               │
        ▼              ▼               ▼
   ┌─────────┐    ┌─────────┐    ┌─────────┐
   │Accepted │    │Rejected │    │Deprecated│
   └─────────┘    └─────────┘    └─────────┘
        │
        ▼
   ┌─────────────────────┐
   │Superseded by ADR-N │
   └─────────────────────┘
```

Transições **proibidas**:
- `Rejected` → qualquer outro (rejeição é terminal — se mudar de ideia, criar novo ADR)
- `Accepted` → `Proposed` (não dá pra "desaprovar"; criar ADR substituto)
- Pular `Proposed` (toda decisão passa por revisão)

---

## Responsabilidade da skill `adr-writing`

A skill **só cria ADRs em `Proposed`**. Não muda status de ADR existente. Não aprova. Não rejeita.

Quando um ADR existente precisa transicionar:

- **Para Accepted/Rejected:** humano (PO ou Gabriel) edita manualmente o campo `Status:` no topo do arquivo. Skill `adr-writing` não cobre esse caso.
- **Para Deprecated/Superseded by:** criar novo ADR (que recebe próximo número). O novo ADR cita o antigo em References. Depois disso, humano edita o antigo pra mudar Status.

---

## Atualização defensiva de Status (caso o caller insista)

Se o caller pedir explicitamente "marcar ADR antigo como Superseded by", a skill PODE fazer via `Edit` no arquivo antigo — mas exige:

1. ADR novo já criado e número conhecido
2. Confirmação explícita do caller ("sim, atualize ADR-042 para Superseded by ADR-048")
3. Atualizar APENAS a linha `- **Status:** <antigo>` → `- **Status:** Superseded by ADR-048`

Não modificar outras seções do ADR antigo. Não deletar conteúdo. Manter histórico intacto.

---

## Output de status na resposta final

Sempre que a skill cria ou edita ADR, incluir no output:

```
- **Status:** Proposed   (ou)
- **Status:** Superseded by ADR-NNN
```

Se houver edit de ADR antigo, incluir bloco adicional:

```
## ADR antigo atualizado

- **Arquivo:** `docs/adr/<NNN>-<titulo>.md`
- **Status anterior:** <Proposed|Accepted|...>
- **Status novo:** Superseded by ADR-<NNN-novo>
- **Linha modificada:** Apenas a linha `- **Status:**` no topo
```
