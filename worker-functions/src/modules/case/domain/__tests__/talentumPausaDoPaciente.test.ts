import { acaoTalentumDaTransicao } from '../talentumPausaDoPaciente';
import { PACIENTE_QUE_PAUSA_A_VAGA } from '../../../matching/domain/vacancyPublication';

describe('acaoTalentumDaTransicao (P6)', () => {
  it.each(['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED'])('vivo → %s = pause', (to) => {
    expect(acaoTalentumDaTransicao('ACTIVE', to)).toBe('pause');
    expect(acaoTalentumDaTransicao('SEARCHING', to)).toBe('pause');
  });

  it.each(['ACTIVE', 'SEARCHING', 'REPLACEMENT'])('pausado → %s = resume', (to) => {
    for (const from of PACIENTE_QUE_PAUSA_A_VAGA) expect(acaoTalentumDaTransicao(from, to)).toBe('resume');
  });

  it('vivo → vivo e pausado → pausado não fazem nada', () => {
    expect(acaoTalentumDaTransicao('SEARCHING', 'ACTIVE')).toBeNull();
    expect(acaoTalentumDaTransicao('ON_HOLD', 'SUSPENDED')).toBeNull();
    expect(acaoTalentumDaTransicao('SUSPENDED', 'DISCHARGED')).toBeNull();
  });

  it('paciente sem estado anterior (null) conta como vivo', () => {
    expect(acaoTalentumDaTransicao(null, 'SEARCHING')).toBeNull();
    expect(acaoTalentumDaTransicao(null, 'ON_HOLD')).toBe('pause');
  });

  it('o conjunto que pausa é o do dono: nenhuma lista própria aqui', () => {
    for (const s of PACIENTE_QUE_PAUSA_A_VAGA) expect(acaoTalentumDaTransicao('ACTIVE', s)).toBe('pause');
  });
});
