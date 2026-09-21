import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { getSexLabel, getGenderLabel } from '../workerDetailLabels';

/**
 * Defeito 3 (21/09/2026, autorizado pelo Gabriel): `resolve()` fazia `map[raw]`
 * sem normalizar caixa — o mapa só tem chaves minúsculas e o backend grava
 * MAIÚSCULO (ex.: sex_encrypted = 'MALE'). `WorkerPersonalInfoCard` chama
 * `getSexLabel(t, sex)` direto, sem `.toLowerCase()` (diferente de
 * `MergeAdvancedFields.tsx`, que já normaliza antes de chamar). Resultado:
 * "Sexo biológico: MALE" cru na tela.
 */
const identityT = ((key: string) => key) as unknown as TFunction;

describe('workerDetailLabels — resolve() normaliza caixa (defeito 3)', () => {
  it('getSexLabel com valor MAIÚSCULO ("MALE") resolve para a mesma chave que "male"', () => {
    const upper = getSexLabel(identityT, 'MALE');
    const lower = getSexLabel(identityT, 'male');
    expect(upper).toBe(lower);
    expect(upper).toBe('workerRegistration.generalInfo.male');
  });

  it('getGenderLabel com valor MAIÚSCULO ("FEMALE") resolve, não devolve cru', () => {
    const result = getGenderLabel(identityT, 'FEMALE');
    expect(result).toBe('workerRegistration.generalInfo.female');
    expect(result).not.toBe('FEMALE');
  });

  it('getSexLabel com variante ES em caixa mista ("Masculino") resolve via alias', () => {
    expect(getSexLabel(identityT, 'Masculino')).toBe('workerRegistration.generalInfo.male');
  });

  it('valor desconhecido (não mapeado) continua devolvido cru, mesmo em caixa alta', () => {
    expect(getSexLabel(identityT, 'UNKNOWN_VALUE')).toBe('UNKNOWN_VALUE');
  });

  it('null continua null', () => {
    expect(getSexLabel(identityT, null)).toBeNull();
  });
});
