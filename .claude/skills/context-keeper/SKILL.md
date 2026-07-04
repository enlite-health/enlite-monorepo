---
name: context-keeper
description: "Preserva o contexto do Claude em sessões longas antes de estourar a janela: gera um handoff estruturado (estado, decisões, arquivos, próximos passos) em docs/HANDOFF_*.md, atualiza a memória persistente, e aponta docs grandes pro RAG em vez de colar no contexto. Use quando a sessão ficar longa, antes de /clear ou /compact, quando o user disser 'salva o contexto', 'antes de perder', 'handoff', ou ao trocar de tarefa grande."
---

# Context Keeper — não perder o fio em sessão longa

Contexto é finito e degrada perto do teto. Rodar até ~90% produz mais texto e pior qualidade; parar em ~75% shippa melhor. Esta skill materializa o contexto **durável** fora da janela antes disso.

## Quando disparar
- Sessão longa (vários milestones) ou uso da janela chegando a ~70%.
- Antes de `/clear` ou `/compact`.
- Ao encerrar o dia ou trocar de feature grande.
- Quando o user pedir handoff explicitamente.

## O que NÃO fazer
- Não colar documento grande no contexto — indexar no RAG (`local-rag` → `ingest_file`) e buscar por `query_documents`. Doc grande no contexto é desperdício que acelera o estouro.
- Não duplicar o que já é durável: código, git history, CLAUDE.md e as memórias já sobrevivem. O handoff captura só o **volátil**: o raciocínio da sessão, decisões e o próximo passo.

## Protocolo

### 1. Handoff estruturado
Gerar/atualizar `docs/HANDOFF_<AAAA-MM-DD>_<slug>.md` (padrão já usado no repo) com:

```markdown
# Handoff — [tarefa] — [data absoluta]

## Estado atual
[Onde a implementação está AGORA — o que roda, o que falta.]

## Decisões desta sessão
- [decisão] — por quê — alternativa descartada

## Arquivos tocados / relevantes
- [path:linha] — o que mudou / o que olhar

## Próximos passos (ordem)
1. [passo acionável concreto]

## Armadilhas / o que NÃO repetir
- [erro já cometido nesta sessão + como evitar]

## Como retomar
[Comando/branch/URL pra voltar exatamente aqui. Ex: branch X, make dev, URL Y.]
```

### 2. Memória persistente
Fato não-óbvio que vale além desta sessão (preferência, decisão de projeto, armadilha recorrente) → gravar em `memory/` seguindo o protocolo de memória (um arquivo por fato + ponteiro no `MEMORY.md`). Não gravar o que o código/git já registra.

### 3. Docs grandes → RAG
Manual, contrato, política, spec longa citada na sessão → `ingest_file` no `local-rag`, referenciar por caminho, e da próxima vez buscar via `query_documents` em vez de reler inteiro.

### 4. Só então compactar
Com handoff salvo + memória atualizada, `/compact` (ou `/clear` e apontar o Claude pro HANDOFF) é seguro — o essencial está em disco.

## Output estruturado (fixo)

```markdown
## Context Keeper
- Handoff: [path criado/atualizado]
- Memórias gravadas/atualizadas: [slugs ou "nenhuma nova"]
- Docs indexados no RAG: [arquivos ou "nenhum"]
- Uso de contexto estimado: [~X%]
- Recomendação: [seguro compactar / seguir / parar por hoje]
```

## Critério de exclusão
- Não gerar handoff vazio "pra constar". Se não houve estado volátil relevante (tarefa trivial já commitada), dizer isso e não criar arquivo.
