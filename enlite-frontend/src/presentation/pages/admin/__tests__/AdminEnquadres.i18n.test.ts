/**
 * i18n da lista global de enquadres (spec 076): mesmo conjunto de chaves em es e pt-BR, nenhum valor vazio ou igual à chave crua
 * (texto fixo / chave ausente é defeito), e os `code`s que a tela traduz têm mensagem nos dois idiomas.
 */
import { describe, it, expect } from 'vitest';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import es from '@infrastructure/i18n/locales/es.json';

type Tree = Record<string, unknown>;
const flatten = (obj: Tree, prefix: string): Array<[string, string]> =>
  Object.entries(obj).flatMap(([k, v]) => {
    const path = `${prefix}.${k}`;
    return typeof v === 'object' && v !== null ? flatten(v as Tree, path) : [[path, String(v)] as [string, string]];
  });

const slice = (l: Tree): Array<[string, string]> => {
  const admin = l.admin as Tree & { enquadres: Tree; nav: Tree; access: { screens: Tree } };
  return [
    ...flatten(admin.enquadres, 'admin.enquadres'),
    ['admin.nav.enquadres', String(admin.nav.enquadres)],
    ...flatten(admin.access.screens.enquadres as Tree, 'admin.access.screens.enquadres'),
  ];
};

const ptEntries = slice(ptBR as Tree);
const esEntries = slice(es as Tree);

describe('admin.enquadres — paridade es × pt-BR', () => {
  it('mesmo conjunto de chaves nos dois idiomas', () => {
    expect(ptEntries.map(([k]) => k).sort()).toEqual(esEntries.map(([k]) => k).sort());
  });

  it('nenhum valor vazio nem igual à chave crua', () => {
    for (const [k, v] of [...ptEntries, ...esEntries]) {
      expect(v.trim(), k).not.toBe('');
      expect(v, k).not.toBe(k);
    }
  });

  it('cobre os codes de erro que a tela traduz e o plural dos totais', () => {
    const keys = ptEntries.map(([k]) => k);
    for (const code of ['ENQUADRE_LIST_RANGE_INCOMPLETE', 'ENQUADRE_LIST_RANGE_INVERTED', 'ENQUADRE_LIST_RANGE_TOO_LONG', 'COUNTRY_SCOPE_REQUIRED', 'INVALID_COUNTRY', 'generic']) {
      expect(keys).toContain(`admin.enquadres.errors.${code}`);
    }
    for (const k of ['enquadres_one', 'enquadres_other', 'convoked_one', 'convoked_other']) expect(keys).toContain(`admin.enquadres.totals.${k}`);
  });

  it('o item de menu é "Encuadres" em es e "Enquadres" em pt-BR', () => {
    expect((es as Tree & { admin: { nav: Tree } }).admin.nav.enquadres).toBe('Encuadres');
    expect((ptBR as Tree & { admin: { nav: Tree } }).admin.nav.enquadres).toBe('Enquadres');
  });
});
