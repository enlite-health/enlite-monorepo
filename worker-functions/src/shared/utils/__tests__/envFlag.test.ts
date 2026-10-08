import { isEnvFlagOn } from '../envFlag';

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
