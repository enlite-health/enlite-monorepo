---
name: bug-shield
description: "Disciplina PRÉ e DURANTE a implementação pra não produzir bug: TDD red-first (teste falhando ANTES do código — mock só aqui), fix por causa-raiz (grep TODOS os callers, conserta a função compartilhada uma vez, não o sintoma do ticket), e uma checagem runnable por lógica não-trivial. Complementa o flow-guard (que é a prova PÓS). Use ao começar a implementar uma feature/bugfix, ou quando o user pedir 'sem bugs', 'com teste', 'diminuir bug'."
---

# Bug Shield — evitar o bug antes de ele existir

`flow-guard` prova o fluxo **depois**. Esta skill é a disciplina de **antes/durante** — barata, aplicada enquanto se escreve. Bug que não nasce não precisa de gate.

## As três travas

### 1. TDD red-first (o mock mora aqui, e só aqui)
A armadilha nº1 da IA com testes: escrever a implementação primeiro e o teste depois — o teste passa a espelhar o código e não pega bug nenhum (coverage 100%, confiança 0).

Ordem obrigatória para lógica nova:
1. Escrever o teste que descreve o **comportamento esperado**.
2. Rodar e **ver falhar (RED)** — colar o output vermelho como evidência de que o teste realmente exercita algo.
3. Implementar o mínimo pra passar (GREEN).
4. Refatorar com o teste segurando.

**Mock é permitido só neste nível unitário**, para isolar fronteira externa. Na prova de fluxo (flow-guard) mock é proibido. Nunca mockar service interno — isso testa implementação, não comportamento.

### 2. Causa-raiz, não sintoma
Um report nomeia um **sintoma**. Antes de corrigir:
```bash
grep -rn "<função ou método a corrigir>" <src> --include=*.ts --include=*.tsx
```
Consertar a **função compartilhada uma vez** (um guard lá é um diff menor que um por caller) e verificar que **nenhum caller irmão** ficou quebrado. Corrigir só o caminho que o ticket cita deixa um sibling caller ainda com o bug. **Evidência exigida: a saída do grep com a contagem de callers e a decisão de onde o fix entrou.**

### 3. Uma checagem runnable por lógica não-trivial
Toda lógica não-trivial deixa **ONE runnable check** — a menor coisa que quebra se a lógica quebrar (um teste pequeno ou assert-based self-check; sem framework pesado, sem fixture). One-liner trivial não precisa.

## Não-negociáveis (nunca sacrificar por brevidade)
Validação em trust boundary, error handling que evita data-loss, segurança, acessibilidade. Código "lazy" sem a sua checagem está **incompleto**.

## Checklist antes de dizer "implementado"
- [ ] Teste escrito ANTES e visto **RED** (output colado)?
- [ ] `grep` de callers rodado e fix na função compartilhada (não no sintoma)?
- [ ] Callers irmãos verificados (nenhum quebrado / nenhum ainda com o bug)?
- [ ] One runnable check pra cada lógica não-trivial?
- [ ] Type-check + lint locais verdes (pre-commit já roda, mas confirmar)?
- [ ] Nenhum `.only`/`.skip` deixado no teste?

## Output estruturado (fixo)

```markdown
## Bug Shield: [feature/bugfix]

### TDD
- Teste: [path] — visto RED antes? [output colado] — GREEN depois? [contagem]
- Mock usado? [onde e por quê — só fronteira externa]

### Causa-raiz
- grep callers: [comando] → [N callers]
- Fix em: [função compartilhada / arquivo:linha]
- Callers irmãos verificados: [lista/contagem]

### Checagens runnable
- [lógica] → [check em arquivo:linha]

### Veredicto
✅ Blindado — RED comprovado, root-cause, checks no lugar.
⚠ Parcial — [o que faltou; NÃO afirmar blindagem que não existe].
```

## Critérios de exclusão duros
- Teste escrito DEPOIS da implementação sem RED comprovado → não conta como TDD (é espelho do código).
- Fix aplicado só no caller do ticket sem grep dos irmãos → causa-raiz não provada.
- Mock fora do nível unitário → viola a fronteira; remover.
