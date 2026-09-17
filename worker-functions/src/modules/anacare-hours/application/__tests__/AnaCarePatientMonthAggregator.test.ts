/**
 * AnaCarePatientMonthAggregator.test.ts
 *
 * A armadilha desta frente (ver rawShiftRealShape.ts): `FakeAnaCareShiftsSource` devolve
 * `SourceShiftDTO` PRONTO e nunca passa pela minimização — por isso os DTOs aqui nascem de
 * `minimizeShiftDTO(rawShift...RealShape(...))`, a forma CRUA real medida 17/09/2026 contra a API
 * do Ana Care, não montados literais à mão.
 */
import { minimizeShiftDTO } from '@modules/integration/infrastructure/anacare/AnaCareFieldMinimization';
import {
  rawShiftNoturnoCruzaMeiaNoite,
  rawShiftComCheckinSemCheckout,
  rawShiftSemCheckin,
  rawNurseRealShape,
  rawPatientRealShape,
} from '@modules/integration/infrastructure/anacare/__fixtures__/rawShiftRealShape';
import { aggregatePatientMonth, aggregateByPatient } from '../AnaCarePatientMonthAggregator';

const PATIENT_ID = String(rawPatientRealShape().id);

describe('aggregatePatientMonth', () => {
  it('turno SEM check-in: shiftsCount conta, hoursActualSum fica 0, previsto entra em hoursScheduledSumMissingActual', () => {
    const dto = minimizeShiftDTO(rawShiftSemCheckin());
    const result = aggregatePatientMonth(PATIENT_ID, [dto]);

    expect(result.shiftsCount).toBe(1);
    expect(result.providersCount).toBe(1);
    expect(result.hoursActualSum).toBe(0);
    // rawShiftSemCheckin: start 2026-08-29T20:00-06:00, end 2026-08-30T08:00-06:00 → 12h previstas.
    expect(result.hoursScheduledSumMissingActual).toBe(12);
    expect(result.originSinCheckin).toBe(1);
    expect(result.originWebAdmin).toBe(0);
    expect(result.originApp).toBe(0);
  });

  it('turno COM check-in e SEM checkout: não entra em hoursActualSum nem em hoursScheduledSumMissingActual pelo checkout ausente — soma o PREVISTO (só falta o REAL)', () => {
    const dto = minimizeShiftDTO(rawShiftComCheckinSemCheckout());
    const result = aggregatePatientMonth(PATIENT_ID, [dto]);

    // computeActualHours exige actualStart E actualEnd — checkout null ⇒ null ⇒ conta como "sem hora real".
    expect(result.hoursActualSum).toBe(0);
    // rawShiftComCheckinSemCheckout: start 14:00 → end 20:00 (-06:00) = 6h previstas.
    expect(result.hoursScheduledSumMissingActual).toBe(6);
    expect(result.originWebAdmin).toBe(1);
    expect(result.originSinCheckin).toBe(0);
    expect(result.originApp).toBe(0);
  });

  it('dois prestadores no mesmo paciente: providersCount=2, shiftsCount soma os dois', () => {
    const dtoNurseA = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite());
    const dtoNurseB = minimizeShiftDTO(
      rawShiftComCheckinSemCheckout({ id: 'outro-turno', nurse: rawNurseRealShape({ id: 'AC-NURSE-OUTRO' }) }),
    );

    const result = aggregatePatientMonth(PATIENT_ID, [dtoNurseA, dtoNurseB]);

    expect(result.providersCount).toBe(2);
    expect(result.shiftsCount).toBe(2);
  });

  it('turno cruzando a meia-noite (noturno, com check-in E checkout): entra em hoursActualSum, nunca em hoursScheduledSumMissingActual', () => {
    const dto = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite());
    const result = aggregatePatientMonth(PATIENT_ID, [dto]);

    // start 20:00 → checkin 20:12, checkout 08:00 (dia seguinte) = 11,8h reais.
    expect(result.hoursActualSum).toBe(11.8);
    expect(result.hoursScheduledSumMissingActual).toBe(0);
    expect(result.shiftsCount).toBe(1);
  });

  it('nenhum nome vindo da fonte: patientFirstName/patientLastName ficam undefined, nunca string vazia', () => {
    const dto = minimizeShiftDTO(
      rawShiftSemCheckin({ patient: rawPatientRealShape({ first_name: '', surname: '  ' }) }),
    );
    const result = aggregatePatientMonth(PATIENT_ID, [dto]);

    expect(result.patientFirstName).toBeUndefined();
    expect(result.patientLastName).toBeUndefined();
  });

  it('nome vindo da fonte: primeiro turno com nome não-vazio vence, o segundo (mesmo com nome diferente) não sobrescreve', () => {
    const dtoComNome = minimizeShiftDTO(rawShiftSemCheckin({ patient: rawPatientRealShape({ first_name: 'Ana', surname: 'Paciente' }) }));
    const dtoComOutroNome = minimizeShiftDTO(
      rawShiftComCheckinSemCheckout({ patient: rawPatientRealShape({ first_name: 'Outro', surname: 'Nome' }) }),
    );

    const result = aggregatePatientMonth(PATIENT_ID, [dtoComNome, dtoComOutroNome]);

    expect(result.patientFirstName).toBe('Ana');
    expect(result.patientLastName).toBe('Paciente');
  });

  it('mistura de origens: cada turno soma na coluna certa (app/web_admin/sin_checkin)', () => {
    const app = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite()); // checkin_source: 'app'
    const webAdmin = minimizeShiftDTO(rawShiftComCheckinSemCheckout()); // checkin_source: 'web_admin'
    const semCheckin = minimizeShiftDTO(rawShiftSemCheckin()); // checkin_source: null

    const result = aggregatePatientMonth(PATIENT_ID, [app, webAdmin, semCheckin]);

    expect(result.originApp).toBe(1);
    expect(result.originWebAdmin).toBe(1);
    expect(result.originSinCheckin).toBe(1);
    expect(result.shiftsCount).toBe(3);
  });
});

describe('aggregateByPatient', () => {
  it('agrupa uma lista mista de vários pacientes antes de agregar cada um', () => {
    const shiftPatientA = minimizeShiftDTO(rawShiftNoturnoCruzaMeiaNoite());
    const shiftPatientB = minimizeShiftDTO(
      rawShiftSemCheckin({ patient: rawPatientRealShape({ id: 'AC-PAT-OUTRO' }) }),
    );

    const result = aggregateByPatient([shiftPatientA, shiftPatientB]);

    expect(result).toHaveLength(2);
    const byId = new Map(result.map((r) => [r.anaCarePatientId, r]));
    expect(byId.get(PATIENT_ID)?.shiftsCount).toBe(1);
    expect(byId.get('AC-PAT-OUTRO')?.shiftsCount).toBe(1);
  });
});
