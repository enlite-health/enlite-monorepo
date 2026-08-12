import { describe, it, expect, afterEach, vi } from 'vitest';
import { initClarity, identifyClarity } from '../clarity';

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

describe('identifyClarity', () => {
  afterEach(() => {
    delete window.clarity;
  });

  it('é no-op quando o Clarity não foi inicializado (window.clarity undefined)', () => {
    expect(() => identifyClarity('uid-123')).not.toThrow();
    expect(window.clarity).toBeUndefined();
  });

  it('é no-op quando o userId é vazio', () => {
    const spy = vi.fn();
    window.clarity = spy as unknown as typeof window.clarity;

    identifyClarity('');

    expect(spy).not.toHaveBeenCalled();
  });

  it('chama identify com o id opaco', () => {
    const spy = vi.fn();
    window.clarity = spy as unknown as typeof window.clarity;

    identifyClarity('uid-123');

    expect(spy).toHaveBeenCalledWith('identify', 'uid-123');
  });

  it('seta as tags customizadas informadas', () => {
    const spy = vi.fn();
    window.clarity = spy as unknown as typeof window.clarity;

    identifyClarity('uid-123', { workerId: 'w-1', workerStatus: 'REGISTERED' });

    expect(spy).toHaveBeenCalledWith('identify', 'uid-123');
    expect(spy).toHaveBeenCalledWith('set', 'workerId', 'w-1');
    expect(spy).toHaveBeenCalledWith('set', 'workerStatus', 'REGISTERED');
  });

  it('ignora tags com valor vazio (não vaza campo em branco)', () => {
    const spy = vi.fn();
    window.clarity = spy as unknown as typeof window.clarity;

    identifyClarity('uid-123', { workerId: 'w-1', workerStatus: '' });

    expect(spy).toHaveBeenCalledWith('set', 'workerId', 'w-1');
    expect(spy).not.toHaveBeenCalledWith('set', 'workerStatus', '');
  });
});
