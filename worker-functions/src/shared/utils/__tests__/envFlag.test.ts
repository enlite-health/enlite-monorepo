import { isEnvFlagOn } from '../envFlag';
import { isEnvFlagOff } from '../envFlag';

describe('isEnvFlagOn', () => {
  it('só a string exata `true` liga', () => {
    expect(isEnvFlagOn('X', { X: 'true' })).toBe(true);
  });

  // Aceitar variações faria o MESMO valor significar coisas diferentes conforme
  // quem lê — e a flag que decide acesso é o pior lugar para essa ambiguidade.
  it.each(['True', 'TRUE', '1', 'yes', 'false', '', ' true '])('%p não liga', (valor) => {
    expect(isEnvFlagOn('X', { X: valor })).toBe(false);
  });

  it('env ausente é desligado', () => {
    expect(isEnvFlagOn('X', {})).toBe(false);
  });

  it('sem env explícito, lê o process.env', () => {
    process.env.__ENV_FLAG_TESTE__ = 'true';
    expect(isEnvFlagOn('__ENV_FLAG_TESTE__')).toBe(true);
    delete process.env.__ENV_FLAG_TESTE__;
    expect(isEnvFlagOn('__ENV_FLAG_TESTE__')).toBe(false);
  });
});

// Cadeia Fase 15 (DX-15.5): flag de PADRÃO LIGADO — só o literal `off` desliga.
describe('isEnvFlagOff', () => {
  it('só a string exata `off` desliga', () => {
    expect(isEnvFlagOff('X', { X: 'off' })).toBe(true);
  });

  it.each(['', 'false', 'OFF', '0', 'true', 'on', 'Off', ' off '])('%p não desliga', (valor) => {
    expect(isEnvFlagOff('X', { X: valor })).toBe(false);
  });

  it('env ausente não desliga (o padrão é ligado)', () => {
    expect(isEnvFlagOff('X', {})).toBe(false);
  });

  it('sem env explícito, lê o process.env', () => {
    process.env.__ENV_FLAG_OFF_TESTE__ = 'off';
    try {
      expect(isEnvFlagOff('__ENV_FLAG_OFF_TESTE__')).toBe(true);
    } finally {
      delete process.env.__ENV_FLAG_OFF_TESTE__;
    }
    expect(isEnvFlagOff('__ENV_FLAG_OFF_TESTE__')).toBe(false);
  });
});
