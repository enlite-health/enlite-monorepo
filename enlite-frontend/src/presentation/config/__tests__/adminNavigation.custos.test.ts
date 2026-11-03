/**
 * spec 082 (RF-1 / DF-2): a página `/admin/custos` NÃO tem item de menu nem link — acesso só pela URL digitada.
 * A rota existe (App.tsx) e a tela está no registro (a célula é o controle), mas `adminNavigation.tsx` não pode citá-la.
 * Se alguém adicionar o item, este teste fica vermelho.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screenByRoute } from '../screenRegistry';

const NAV = readFileSync(resolve(__dirname, '../adminNavigation.tsx'), 'utf8');
const APP = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

describe('painel de custos fora do menu (spec 082, DF-2)', () => {
  it('adminNavigation.tsx não cita /admin/custos nem o id `custos`', () => {
    expect(NAV).not.toMatch(/\/admin\/custos/);
    expect(NAV).not.toMatch(/['"`]custos['"`]/);
    expect(NAV).not.toMatch(/admin\.nav\.custos/);
  });

  it('controle de que o teste mede algo: a rota existe no App e a tela está no registro com a célula só-Master', () => {
    expect(APP).toMatch(/path="custos"/);
    expect(screenByRoute('/admin/custos')).toMatchObject({ id: 'custos', cells: ['platform_costs:read'] });
  });
});
