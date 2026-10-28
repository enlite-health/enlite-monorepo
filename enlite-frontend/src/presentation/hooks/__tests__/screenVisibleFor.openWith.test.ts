/**
 * `openWith: 'all'` (spec 076): a tela da lista global de enquadres só abre com AS DUAS células. O "OU" das demais telas não muda.
 */
import { describe, it, expect } from 'vitest';
import { screenVisibleFor } from '../useCellAccess';
import { screenById, type ScreenDef } from '@presentation/config/screenRegistry';

const enquadres = screenById('enquadres') as ScreenDef;

describe('screenVisibleFor — openWith: all', () => {
  it('a tela de enquadres declara openWith all e as duas células', () => {
    expect(enquadres.openWith).toBe('all');
    expect(enquadres.cells).toEqual(['enquadre_event:read', 'vacancy:read']);
  });

  it('só enquadre_event:read → falso', () => {
    expect(screenVisibleFor(enquadres, ['enquadre_event:read'], 'on')).toBe(false);
  });

  it('só vacancy:read → falso', () => {
    expect(screenVisibleFor(enquadres, ['vacancy:read'], 'on')).toBe(false);
  });

  it('as duas → verdadeiro', () => {
    expect(screenVisibleFor(enquadres, ['enquadre_event:read', 'vacancy:read'], 'on')).toBe(true);
  });

  it('engine off → verdadeiro, mesmo sem célula', () => {
    expect(screenVisibleFor(enquadres, [], 'off')).toBe(true);
  });

  it('tela SEM openWith com uma célula de duas → verdadeiro (o OU das outras telas não muda)', () => {
    const lista = screenById('vacancies.list') as ScreenDef;
    expect(lista.openWith).toBeUndefined();
    expect(screenVisibleFor(lista, ['vacancy:read'], 'on')).toBe(true);
  });
});
