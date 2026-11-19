/**
 * Causa tipada da recusa do Tactiq (change tactiq-vinculo-valida-acesso, F1): `denyReason` é a ÚNICA função que vira `reason`,
 * e os sanitizadores impedem que texto livre de terceiro vire valor de evento/log.
 */
import {
  denyReason,
  sanitizeAccessAction,
  sanitizeAccessTitle,
  sanitizeScopeList,
  TactiqUnauthorizedError,
} from '../ports/TactiqPorts';

describe('denyReason', () => {
  it('cada causa tem a sua string, distinta das outras', () => {
    const reasons = [
      denyReason({ kind: 'token_endpoint' }),
      denyReason({ kind: 'mcp_transport' }),
      denyReason({ kind: 'access_action', action: 'request_seat' }),
      denyReason({ kind: 'scope_without_details' }),
      denyReason({ kind: 'unspecified' }),
    ];
    expect(reasons).toEqual([
      'token_endpoint_401_403',
      'mcp_transport_401_403',
      'access_action:request_seat',
      'scope_without_details',
      'unspecified',
    ]);
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('action com texto livre vira unrecognized_value mesmo se chegar cru até aqui', () => {
    expect(denyReason({ kind: 'access_action', action: 'Ask your team admin <b>' })).toBe('access_action:unrecognized_value');
  });
});

describe('sanitizeAccessAction', () => {
  it.each(['request_seat', 'upgrade', 'a', 'x'.repeat(1) + 'y'.repeat(31)])('aceita o enum %s', (v) => {
    expect(sanitizeAccessAction(v)).toBe(v);
  });

  it.each(['Request_Seat', '1abc', 'tem espaço', 'a'.repeat(33), '', 'ação', 'x;drop', null, undefined, 42])(
    'rejeita %p → unrecognized_value',
    (v) => {
      expect(sanitizeAccessAction(v)).toBe('unrecognized_value');
    },
  );
});

describe('sanitizeAccessTitle', () => {
  it('mantém o título medido (F21) intacto', () => {
    expect(sanitizeAccessTitle('Ask your team admin for a seat')).toBe('Ask your team admin for a seat');
  });

  it('descarta marcação: <img onerror> não deixa < nem > nem aspas duplas', () => {
    const out = sanitizeAccessTitle('<img src=x onerror="alert(1)">Upgrade needed') as string;
    expect(out).not.toMatch(/[<>"=()]/);
    expect(out).toContain('Upgrade needed');
  });

  it('corta em 80 caracteres', () => {
    expect((sanitizeAccessTitle('a'.repeat(200)) as string).length).toBe(80);
  });

  it('preserva acentos e a pontuação permitida; vazio, não-string e só-lixo → null', () => {
    expect(sanitizeAccessTitle("¡Pedí un asiento! ¿Cómo? It's: ok-ok.")).toBe("¡Pedí un asiento! ¿Cómo? It's: ok-ok.");
    expect(sanitizeAccessTitle('<<>>')).toBeNull();
    expect(sanitizeAccessTitle('')).toBeNull();
    expect(sanitizeAccessTitle(undefined)).toBeNull();
    expect(sanitizeAccessTitle({ a: 1 })).toBeNull();
  });
});

describe('sanitizeScopeList', () => {
  it('quebra por espaço e mantém só tokens ^[a-z:_]+$', () => {
    expect(sanitizeScopeList('mcp:meetings:own mcp:meetings:details')).toEqual(['mcp:meetings:own', 'mcp:meetings:details']);
    expect(sanitizeScopeList('mcp:meetings:own <script> BAD x1')).toEqual(['mcp:meetings:own']);
  });

  it('no máximo 8 tokens; ausente/não-string → null (não apurado)', () => {
    expect(sanitizeScopeList(Array.from({ length: 12 }, () => 'a:b').join(' '))).toHaveLength(8);
    expect(sanitizeScopeList(undefined)).toBeNull();
    expect(sanitizeScopeList(['mcp:meetings:own'])).toBeNull();
  });
});

describe('TactiqUnauthorizedError', () => {
  it('sem argumento compila e a causa é unspecified; com causa, carrega-a', () => {
    expect(new TactiqUnauthorizedError().cause).toEqual({ kind: 'unspecified' });
    expect(new TactiqUnauthorizedError({ kind: 'token_endpoint' }).cause).toEqual({ kind: 'token_endpoint' });
    expect(new TactiqUnauthorizedError({ kind: 'mcp_transport' }).message).toBe('tactiq_unauthorized');
  });
});
