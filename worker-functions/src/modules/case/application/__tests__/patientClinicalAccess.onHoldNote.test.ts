/**
 * `on_hold_note` entra no ponto ÚNICO de autorização (lex C7.1-a, pacote D211.2): quem não pode
 * ler o texto clínico restrito recebe `onHoldNote: null` + `onHoldNoteRedacted: true`; o motivo
 * (`onHoldReason`, rótulo de catálogo) continua visível.
 */
import { projectPatientClinicalForActor, CLINICAL_RESTRICTED_FIELDS } from '../patientClinicalAccess';

describe('patientClinicalAccess — on_hold_note', () => {
  const patient = { id: 'p', status: 'ON_HOLD', onHoldReason: 'INSURER', onHoldNote: 'texto clinico 7c2a', emergencyInstructions: null, emergencyInstructionsUpdatedAt: null, emergencyInstructionsUpdatedBy: null };

  it('onHoldNote é campo restrito; redigido → null + flag; o motivo fica', () => {
    expect(CLINICAL_RESTRICTED_FIELDS).toContain('onHoldNote');
    const red = projectPatientClinicalForActor(patient, []);
    expect(red.onHoldNote).toBeNull();
    expect(red.onHoldNoteRedacted).toBe(true);
    expect(red.onHoldReason).toBe('INSURER');
    expect(JSON.stringify(red)).not.toContain('7c2a');
  });

  it('quem pode ler recebe o MESMO objeto, sem flag', () => {
    const same = projectPatientClinicalForActor(patient, null);
    expect(same).toBe(patient);
    expect((same as { onHoldNoteRedacted?: true }).onHoldNoteRedacted).toBeUndefined();
  });
});
