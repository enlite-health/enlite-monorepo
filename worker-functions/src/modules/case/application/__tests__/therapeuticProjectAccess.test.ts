/**
 * therapeuticProjectAccess — o ponto ÚNICO que decide o que de uma versão do projeto terapêutico
 * sai para o ator (spec 017, D299; lex 08/09 C7/C8; D286 "célula por DADO").
 *
 * As provas, uma por condição:
 *  · C7   — `clinicalContext`/`generalObjective`/`diagnoses` só saem com `patient_clinical:read`;
 *  · C8   — o marcador `redacted.clinical` é CONSTANTE: versão com e sem texto clínico produzem a
 *           MESMA resposta para quem não tem a célula (senão "existe contexto clínico" vaza por
 *           inferência);
 *  · D113 — `cells = null` é "o engine não decidiu", não `[]`: tudo passa;
 *  · lex 29/08 item 3 — o uid do autor NUNCA sai, só o nome resolvido;
 *  · lex C9/C13 — a trilha carrega só NOME de container, nunca valor.
 *
 * Sem mock: são funções puras sobre um objeto de domínio.
 */
import type { TherapeuticProjectVersion } from '../../domain/TherapeuticProject';
import {
  canReadTherapeuticClinical,
  canWriteTherapeuticClinical,
  projectTherapeuticVersionForActor,
  therapeuticTrailAction,
  PATIENT_CLINICAL_READ_CELL,
  PATIENT_CLINICAL_WRITE_CELL,
  THERAPEUTIC_PROJECT_RESOURCE,
} from '../therapeuticProjectAccess';

const PROJETO_READ = `${THERAPEUTIC_PROJECT_RESOURCE}:read`;

function versao(over: Partial<TherapeuticProjectVersion> = {}): TherapeuticProjectVersion {
  return {
    id: 'v-1',
    patientId: 'p-1',
    major: 1,
    minor: 0,
    version: 'V.1.0',
    editedFromVersionId: null,
    contractedServiceId: 'svc-1',
    modality: 'IN_PERSON',
    contractedServiceCode: 'CAREGIVER',
    diagnoses: [{ uri: 'http://id.who.int/icd/entity/1', code: '6A02', title: 'TEA' }],
    clinicalContext: 'contexto clínico do titular',
    generalObjective: 'objetivo geral do titular',
    specificObjectives: [{ id: 'o-1', label: 'Vínculo terapéutico' }],
    activities: [{ id: 'a-1', label: 'Acompañamiento escolar' }],
    pathologyTypes: [{ id: 'pt-1', label: 'Neurodesarrollo' }],
    startDate: '2026-01-01',
    endDate: '2026-06-30',
    annulledAt: null,
    annulledBy: null,
    annulledByName: null,
    annulReason: null,
    createdBy: 'uid-do-autor',
    createdByName: 'Ana Joulie',
    createdAt: '2026-09-08T10:00:00.000Z',
    country: 'AR',
    ...over,
  };
}

describe('as células nomeadas', () => {
  it('as duas células clínicas são as do container `patient_clinical` (D286: a MESMA chave da ficha)', () => {
    expect(PATIENT_CLINICAL_READ_CELL).toBe('patient_clinical:read');
    expect(PATIENT_CLINICAL_WRITE_CELL).toBe('patient_clinical:write');
    expect(THERAPEUTIC_PROJECT_RESOURCE).toBe('patient_therapeutic_project');
  });
});

describe('canReadTherapeuticClinical', () => {
  it('null e undefined (o engine não decidiu, D113) → tudo passa', () => {
    expect(canReadTherapeuticClinical(null)).toBe(true);
    expect(canReadTherapeuticClinical(undefined)).toBe(true);
  });

  it('[] é ator conhecido e sem célula → não lê clínico', () => {
    expect(canReadTherapeuticClinical([])).toBe(false);
  });

  it('a célula do projeto NÃO dá a clínica — as duas são cumulativas (lex C7)', () => {
    expect(canReadTherapeuticClinical([PROJETO_READ])).toBe(false);
    expect(canReadTherapeuticClinical([PROJETO_READ, PATIENT_CLINICAL_READ_CELL])).toBe(true);
  });

  it('a célula de ESCRITA clínica não dá leitura', () => {
    expect(canReadTherapeuticClinical([PATIENT_CLINICAL_WRITE_CELL])).toBe(false);
  });
});

describe('canWriteTherapeuticClinical', () => {
  it('null/undefined → passa; [] → não; só a célula de escrita clínica libera (lex C7)', () => {
    expect(canWriteTherapeuticClinical(null)).toBe(true);
    expect(canWriteTherapeuticClinical(undefined)).toBe(true);
    expect(canWriteTherapeuticClinical([])).toBe(false);
    expect(canWriteTherapeuticClinical([PATIENT_CLINICAL_READ_CELL])).toBe(false);
    expect(canWriteTherapeuticClinical([PATIENT_CLINICAL_WRITE_CELL])).toBe(true);
  });
});

describe('projectTherapeuticVersionForActor', () => {
  it('o uid do autor NUNCA sai — nem para quem tem TODAS as células (lex 29/08 item 3)', () => {
    const comTudo = projectTherapeuticVersionForActor(versao(), null);
    const semClinica = projectTherapeuticVersionForActor(versao(), []);
    expect(comTudo).not.toHaveProperty('createdBy');
    expect(semClinica).not.toHaveProperty('createdBy');
    // O uid de quem anulou também é dado de staff: sai só o nome resolvido (gate 08/09).
    expect(comTudo).not.toHaveProperty('annulledBy');
    expect(semClinica).not.toHaveProperty('annulledBy');
    expect(comTudo.annulledByName).toBeNull();
    // o NOME resolvido continua saindo — é o "Proyecto elaborado por" da tela
    expect(comTudo.createdByName).toBe('Ana Joulie');
  });

  it('cells=null (D113) → os três campos clínicos saem inteiros e sem marcador', () => {
    const out = projectTherapeuticVersionForActor(versao(), null);
    expect(out.clinicalContext).toBe('contexto clínico do titular');
    expect(out.generalObjective).toBe('objetivo geral do titular');
    expect(out.diagnoses).toHaveLength(1);
    expect(out).not.toHaveProperty('redacted');
  });

  it('com `patient_clinical:read` → idem: o texto clínico sai', () => {
    const out = projectTherapeuticVersionForActor(versao(), [PROJETO_READ, PATIENT_CLINICAL_READ_CELL]);
    expect(out.clinicalContext).toBe('contexto clínico do titular');
    expect(out).not.toHaveProperty('redacted');
  });

  it('sem a célula clínica → os TRÊS campos saem null e o marcador `redacted.clinical` sai (lex C7)', () => {
    const out = projectTherapeuticVersionForActor(versao(), [PROJETO_READ]);
    expect(out.clinicalContext).toBeNull();
    expect(out.generalObjective).toBeNull();
    expect(out.diagnoses).toBeNull();
    expect(out.redacted).toEqual({ clinical: true });
  });

  it('o que NÃO é clínico continua saindo sem a célula: número, datas, autor, serviço e catálogos', () => {
    const out = projectTherapeuticVersionForActor(versao(), []);
    expect(out).toMatchObject({
      id: 'v-1',
      version: 'V.1.0',
      major: 1,
      minor: 0,
      contractedServiceId: 'svc-1',
      modality: 'IN_PERSON',
      contractedServiceCode: 'CAREGIVER',
      startDate: '2026-01-01',
      endDate: '2026-06-30',
      createdByName: 'Ana Joulie',
      specificObjectives: [{ id: 'o-1', label: 'Vínculo terapéutico' }],
      activities: [{ id: 'a-1', label: 'Acompañamiento escolar' }],
      pathologyTypes: [{ id: 'pt-1', label: 'Neurodesarrollo' }],
    });
  });

  it('lex C8: o marcador é CONSTANTE — versão com e sem conteúdo clínico dão a MESMA resposta', () => {
    const cheia = projectTherapeuticVersionForActor(versao(), []);
    const vazia = projectTherapeuticVersionForActor(
      versao({ clinicalContext: '', generalObjective: '', diagnoses: [] }),
      [],
    );
    expect(vazia).toEqual(cheia);
    expect(vazia.redacted).toEqual({ clinical: true });
  });

  it('nenhum resquício do texto clínico sobra no objeto serializado do ator sem célula', () => {
    const out = projectTherapeuticVersionForActor(versao(), []);
    expect(JSON.stringify(out)).not.toContain('contexto clínico do titular');
    expect(JSON.stringify(out)).not.toContain('objetivo geral do titular');
    expect(JSON.stringify(out)).not.toContain('6A02');
    expect(JSON.stringify(out)).not.toContain('uid-do-autor');
  });

  it('não muta a versão de origem (a projeção é cópia, não redação em cima do row)', () => {
    const original = versao();
    projectTherapeuticVersionForActor(original, []);
    expect(original.clinicalContext).toBe('contexto clínico do titular');
    expect(original.createdBy).toBe('uid-do-autor');
  });
});

describe('therapeuticTrailAction (lex C9/C13: só NOME de container)', () => {
  it.each([
    ['read_project', 'read_project:therapeuticProject+clinical', 'read_project:therapeuticProject'],
    ['write_project', 'write_project:therapeuticProject+clinical', 'write_project:therapeuticProject'],
    ['export_pdf', 'export_pdf:therapeuticProject+clinical', 'export_pdf:therapeuticProject'],
  ] as const)('%s: com clínica → "%s"; sem → "%s"', (prefixo, comClinica, semClinica) => {
    expect(therapeuticTrailAction(prefixo, null)).toBe(comClinica);
    expect(therapeuticTrailAction(prefixo, [PATIENT_CLINICAL_READ_CELL])).toBe(comClinica);
    expect(therapeuticTrailAction(prefixo, [])).toBe(semClinica);
    expect(therapeuticTrailAction(prefixo, [PROJETO_READ])).toBe(semClinica);
  });

  it('a trilha nunca carrega id nem texto — só os dois nomes de container', () => {
    expect(therapeuticTrailAction('read_project', undefined)).toMatch(/^read_project:[A-Za-z+]+$/);
  });
});
