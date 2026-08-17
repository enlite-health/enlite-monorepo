/**
 * O matcher responde a pergunta que o guard de rota-sem-declaração faz a cada
 * request: "o caminho concreto que chegou cai em qual rota registrada?". Errar
 * para MAIS é negar rota legítima; errar para MENOS é deixar passar rota sem
 * declaração. Os dois lados estão aqui.
 */

import { buildRouteIndex } from '../routeMatcher';
import type { ScannedRoute } from '../scanExpressRouter';

const cell = { resource: 'user_management', action: 'read' };

const ROTAS: ScannedRoute[] = [
  { method: 'GET', path: '/api/admin/users', cell },
  { method: 'DELETE', path: '/api/admin/users/by-email' },
  { method: 'DELETE', path: '/api/admin/users/:id' },
  { method: 'POST', path: '/api/admin/workers/:id/documents/:type' },
  { method: 'USE', path: '/api/docs', cell },
];

describe('buildRouteIndex', () => {
  const index = buildRouteIndex(ROTAS);

  it('casa caminho exato e devolve a célula declarada', () => {
    expect(index.find('GET', '/api/admin/users')?.cell).toEqual(cell);
  });

  it('método diferente no mesmo caminho não casa', () => {
    expect(index.find('POST', '/api/admin/users')).toBeUndefined();
  });

  it('método em minúsculas é o mesmo método', () => {
    expect(index.find('get', '/api/admin/users')?.path).toBe('/api/admin/users');
  });

  it(':param casa qualquer segmento', () => {
    expect(index.find('DELETE', '/api/admin/users/abc-123')?.path).toBe('/api/admin/users/:id');
  });

  it('vários :param no mesmo caminho', () => {
    expect(index.find('POST', '/api/admin/workers/42/documents/dni')?.path).toBe(
      '/api/admin/workers/:id/documents/:type',
    );
  });

  it('a PRIMEIRA rota registrada ganha — a mesma ordem que o Express despacha', () => {
    // `by-email` foi registrada antes de `:id`; se a ordem invertesse, o DELETE
    // por e-mail seria engolido pelo `:id` (o bug que a extração da família
    // admin.users corrigiu).
    expect(index.find('DELETE', '/api/admin/users/by-email')?.path).toBe('/api/admin/users/by-email');
  });

  it('número de segmentos diferente não casa', () => {
    expect(index.find('GET', '/api/admin/users/1/extra')).toBeUndefined();
    expect(index.find('GET', '/api/admin')).toBeUndefined();
  });

  it('barra final é irrelevante', () => {
    expect(index.find('GET', '/api/admin/users/')?.path).toBe('/api/admin/users');
  });

  it('USE casa por PREFIXO (middleware montado governa o que está abaixo)', () => {
    expect(index.find('GET', '/api/docs/swagger.json')?.path).toBe('/api/docs');
    expect(index.find('GET', '/api/docs')?.path).toBe('/api/docs');
    expect(index.find('GET', '/api/documentos')).toBeUndefined();
  });

  it('caminho que não casa com nada volta undefined (não inventa decisão)', () => {
    expect(index.find('GET', '/api/admin/inexistente')).toBeUndefined();
  });

  it('all() devolve a varredura inteira, na ordem', () => {
    expect(index.all()).toBe(ROTAS);
  });

  it('índice vazio não casa nada', () => {
    expect(buildRouteIndex([]).find('GET', '/api/admin/users')).toBeUndefined();
  });
});
