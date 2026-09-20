/**
 * C6 — a exigência NEGATIVA: `funnel`, `match` e `vacancy` não podem virar
 * recurso sensível.
 *
 * ⚠️ Exigência negativa é a que se perde: ninguém escreve teste para o que NÃO
 * deve acontecer, e um dia alguém acrescenta `'funnel'` ao Set com a melhor das
 * intenções ("é dado de prestador, né?"). O efeito não seria mais segurança:
 * seria uma linha de ALLOW por abertura de Kanban, afogando as linhas de
 * abertura de dossiê e de exclusão que a trilha existe para destacar.
 */

import {
  SENSITIVE_RESOURCES,
  SENSITIVE_ACTIONS,
  NUNCA_SENSIVEIS,
} from '../PermissionMiddleware';

describe('C6 — o que entra e o que NUNCA entra na trilha de ALLOW', () => {
  it('funnel, match e vacancy estão FORA — encheriam a partição', () => {
    for (const recurso of NUNCA_SENSIVEIS) {
      expect([recurso, SENSITIVE_RESOURCES.has(recurso)]).toEqual([recurso, false]);
    }
  });

  it('os três sensíveis de verdade continuam dentro', () => {
    // Se alguém REMOVER um destes, a abertura de dossiê para de deixar rastro —
    // e a régua tem de acusar nas duas direções, não só na de acrescentar.
    expect([...SENSITIVE_RESOURCES].sort()).toEqual(['patient', 'worker_document', 'worker_pii']);
  });

  it('`export` já é ação sensível — a trilha do export NÃO precisava ser criada', () => {
    // Medido, não presumido: `isSensitive` é `recurso OU ação`, então
    // `worker:export` já produz linha de ALLOW hoje, sem nada novo.
    expect(SENSITIVE_ACTIONS.has('export')).toBe(true);
    expect(SENSITIVE_ACTIONS.has('delete')).toBe(true);
    expect(SENSITIVE_ACTIONS.has('execute')).toBe(true);
  });

  it('a lista de ações sensíveis é exatamente esta — nada entrou de carona', () => {
    expect([...SENSITIVE_ACTIONS].sort()).toEqual(['delete', 'execute', 'export']);
  });

  it('`read` NÃO é sensível por si — senão todo GET viraria linha', () => {
    expect(SENSITIVE_ACTIONS.has('read')).toBe(false);
    expect(SENSITIVE_ACTIONS.has('write')).toBe(false);
  });
});
