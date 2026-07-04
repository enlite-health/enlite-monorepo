import { describe, it, expect, afterEach } from 'vitest';
import { initClarity } from '../clarity';

const CLARITY_SRC_PREFIX = 'https://www.clarity.ms/tag/';

function findClarityScripts(): HTMLScriptElement[] {
  return Array.from(
    document.querySelectorAll<HTMLScriptElement>(`script[src^="${CLARITY_SRC_PREFIX}"]`),
  );
}

describe('initClarity', () => {
  afterEach(() => {
    findClarityScripts().forEach((script) => script.remove());
    delete window.clarity;
  });

  it('não injeta script quando o project ID está vazio', () => {
    initClarity('');

    expect(findClarityScripts()).toHaveLength(0);
    expect(window.clarity).toBeUndefined();
  });

  it('injeta o script do Clarity com o project ID configurado', () => {
    initClarity('xftpznri3x');

    const scripts = findClarityScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(`${CLARITY_SRC_PREFIX}xftpznri3x`);
    expect(scripts[0].async).toBe(true);
  });

  it('cria o stub window.clarity que enfileira chamadas antes do script carregar', () => {
    initClarity('xftpznri3x');

    expect(window.clarity).toBeTypeOf('function');
    window.clarity?.('set', 'page', 'test');
    expect(window.clarity?.q).toEqual([['set', 'page', 'test']]);
  });

  it('não duplica o script em chamadas repetidas', () => {
    initClarity('xftpznri3x');
    initClarity('xftpznri3x');

    expect(findClarityScripts()).toHaveLength(1);
  });
});
