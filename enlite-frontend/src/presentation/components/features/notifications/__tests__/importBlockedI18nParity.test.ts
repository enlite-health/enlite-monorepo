/**
 * importBlockedI18nParity — spec 083, CA-12: a árvore `admin.notifications.importBlocked` tem as MESMAS chaves
 * e as MESMAS variáveis `{{}}` em es e pt-BR. (A paridade de chaves de `admin.notifications` inteira já existe no
 * teste do registro; aqui entra o que ela não mede: os placeholders — um `{{prazo}}` esquecido vira "{{prazo}}" na tela.)
 */
import { describe, it, expect } from 'vitest';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

type Tree = { [k: string]: string | Tree };

function flattenLeaves(tree: Tree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : flattenLeaves(v, `${prefix}${k}.`)));
}

const placeholders = (text: string): string[] => [...new Set(text.match(/\{\{\s*\w+\s*\}\}/g) ?? [])].sort();

const es = flattenLeaves((esJson.admin.notifications as unknown as { importBlocked: Tree }).importBlocked);
const pt = flattenLeaves((ptBRJson.admin.notifications as unknown as { importBlocked: Tree }).importBlocked);

describe('admin.notifications.importBlocked — paridade es × pt-BR (CA-12)', () => {
  it('a árvore existe e tem folhas nos dois idiomas (controle positivo do alcance)', () => {
    expect(es.length).toBeGreaterThan(10);
    expect(pt.length).toBeGreaterThan(10);
  });

  it('mesmas chaves nos dois idiomas', () => {
    expect(es.map(([k]) => k).sort()).toEqual(pt.map(([k]) => k).sort());
  });

  it('mesmas variáveis {{}} em cada chave', () => {
    const ptByKey = new Map(pt);
    for (const [key, text] of es) {
      expect({ key, vars: placeholders(text) }).toEqual({ key, vars: placeholders(ptByKey.get(key) ?? '') });
    }
  });

  it('autoteste do instrumento: placeholders() enxerga a diferença quando ela existe', () => {
    expect(placeholders('até {{prazo}} e {{data}}')).not.toEqual(placeholders('até {{prazo}}'));
  });
});
