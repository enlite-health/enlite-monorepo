/**
 * Achado da revisão do PR-4 (item 6, task 4.10): a flag `VITE_PATIENT_PHOTO_ENABLED` nunca tinha
 * sido implementada — o slot de foto (`PatientPhotoSlot`, dentro de `PatientIdentityCard`)
 * aparecia sem gate nenhum, em qualquer build.
 * Este teste prova o GATE em si (`ENV.PATIENT_PHOTO_ENABLED`), mockando o módulo de env para
 * simular ligado/desligado — o comportamento interno do componente já tem suíte própria
 * (`PatientPhotoSlot.test.tsx`).
 *
 * Documentos y consentimiento de imagen (que também vivia atrás desta flag) foi REMOVIDO
 * (fix/018-remover-documentos-consentimento) — só a foto fica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mutável — cada teste ajusta antes de renderizar. `vi.hoisted` porque `vi.mock` é IÇADO para o
// topo do arquivo — uma `const` normal ainda não existiria no momento em que a fábrica roda (TDZ).
const envState = vi.hoisted(() => ({ PATIENT_PHOTO_ENABLED: false }));
vi.mock('@infrastructure/config/env', () => ({
  get ENV() {
    return envState;
  },
}));

// useCellAccess: 'hidden' — PatientPhotoSlot não dispara fetch quando renderizado (o que
// testaríamos aqui é só a PRESENÇA do wrapper, não o fluxo de dados).
vi.mock('@presentation/hooks/useCellAccess', () => ({
  useCellAccess: () => ({ level: 'hidden', canRead: false, canWrite: false, status: 'ready' }),
  useActionGate: () => ({ allowed: false }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}));

import { PatientIdentityCard } from '../PatientIdentityCard';
import { patientDetailFixture } from './patientDetailFixture';

describe('Flag VITE_PATIENT_PHOTO_ENABLED — PatientPhotoSlot dentro de PatientIdentityCard (achado item 6 da revisão do PR-4)', () => {
  beforeEach(() => {
    envState.PATIENT_PHOTO_ENABLED = false;
  });

  it('DESLIGADA (PRD — env ausente): PatientPhotoSlot NÃO aparece dentro do PatientIdentityCard', () => {
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('patient-identity-card')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-photo-slot')).not.toBeInTheDocument();
  });

  it('LIGADA (stage): PatientPhotoSlot aparece dentro do PatientIdentityCard', () => {
    envState.PATIENT_PHOTO_ENABLED = true;
    render(<PatientIdentityCard patient={patientDetailFixture} />);
    expect(screen.getByTestId('patient-photo-slot')).toBeInTheDocument();
  });
});
