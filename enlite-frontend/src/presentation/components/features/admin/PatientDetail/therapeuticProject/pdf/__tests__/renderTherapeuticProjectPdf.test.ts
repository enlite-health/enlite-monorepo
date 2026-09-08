// @vitest-environment node
/**
 * O PDF de verdade (bytes) lido de volta com `pdf-parse` — spec 017 F3 (lex C11–C14).
 * Prova POSITIVA: com todas as células, o nome, o CID, os objetivos e o rodapé estão no texto.
 * Prova NEGATIVA: sem `patient_identity`/`patient_family`/clínica, o nome e o texto clínico NÃO estão,
 * e o rótulo de seção omitida está. Zero requisições de rede durante a geração.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { resolve } from 'node:path';
// O `index.js` do pdf-parse roda um autoteste ao ser importado sem `module.parent` (ESM) — importar a lib direta.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import type { TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { renderTherapeuticProjectPdfBuffer, renderTherapeuticProjectPdfBlob, pdfFileName } from '../renderTherapeuticProjectPdf';
import { ageFromBirthDate, formatIsoDateEsAr, implementationPeriodText } from '../therapeuticProjectPdfInput';
import { PDF_LABELS } from '../pdfFixedTexts';
import type { TherapeuticProjectPdfInput } from '../therapeuticProjectPdfInput';

const FONTS = resolve(__dirname, '../../../../../../../../../public/fonts');

const version: TherapeuticProjectVersion = {
  id: 'v-1',
  patientId: 'p-1',
  major: 1,
  minor: 2,
  version: 'V.1.2',
  editedFromVersionId: 'v-0',
  contractedServiceId: 's-1',
  contractedServiceCode: 'CAREGIVER',
  modality: 'IN_PERSON',
  diagnoses: [{ uri: 'u', code: '8B11', title: 'Hemiplejía sintética de prueba' }],
  clinicalContext: 'SINTESIS-CLINICA-SINTETICA texto de contexto para el test.',
  generalObjective: 'OBJETIVO-GENERAL-SINTETICO para el test.',
  specificObjectives: [{ id: 'o1', label: 'Favorecer la prevención de escaras (test).' }],
  activities: [{ id: 'a1', label: 'Realizar cambios posturales frecuentes (test).' }],
  pathologyTypes: [{ id: 'pt1', label: 'Trastornos psicóticos' }],
  startDate: '2026-09-01',
  endDate: '2026-12-31',
  annulledAt: null,
  annulledByName: null,
  annulReason: null,
  createdByName: 'Ana Sintética',
  createdAt: '2026-09-07T13:00:00.000Z',
  country: 'AR',
};

const fullInput: TherapeuticProjectPdfInput = {
  caseRef: '12345',
  version,
  identification: { fullName: 'PACIENTE-SINTETICO Apellido', documentLabel: 'DNI 00.000.000', birthDate: '1938-03-29', age: 88 },
  coverage: { insurance: 'Cobertura Sintética', affiliateId: '0000-TEST' },
  service: { serviceLabel: 'Cuidador', deviceLabels: ['Domicilio'], providerProfile: 'Perfil sintético del prestador', scheduleText: 'Lunes a domingo, 24 hs', careLocationLabel: 'Domicilio' },
  addressText: 'Calle Sintética 123, 4º A, CABA',
  emergencyContacts: [{ name: 'RESPONSABLE-SINTETICO', relationship: 'hijo', phone: '11 0000 0000', email: 'resp@example.test' }],
  coverageEmergencyContacts: [
    { kindLabel: 'Ambulancia', name: 'AMBULANCIA-SINTETICA', phone: '0800 000 0001' },
    { kindLabel: 'Profesional directo', name: 'PROFESIONAL-DIRECTO-SINTETICO', phone: '11 0000 0002' },
  ],
  coverageDirectProfessionalRedacted: false,
  coverageEmergencyContactsUnavailable: false,
  fixedSectionsServiceCode: 'CAREGIVER',
  modalityLabel: 'Presencial',
  careTeam: ['Equipo tratante sintético'],
  issuedAtText: '08/09/2026 10:00',
};

const texto = async (input: TherapeuticProjectPdfInput): Promise<{ text: string; pages: number }> => {
  const buf = await renderTherapeuticProjectPdfBuffer(input, FONTS);
  const parsed = await pdfParse(buf);
  return { text: parsed.text.replace(/\s+/g, ' '), pages: parsed.numpages };
};

describe('PDF do projeto terapêutico — bytes reais, texto extraído (spec 017 F3)', () => {
  let fetchSpy: ReturnType<typeof vi.fn<unknown[], unknown>>;
  beforeAll(() => {
    // O yoga (layout do react-pdf) carrega o próprio WASM por `fetch` de um `data:` URL — memória, não
    // rede. Só isso passa; qualquer `http(s)://` é recusado e contado.
    const realFetch = globalThis.fetch;
    fetchSpy = vi.fn<unknown[], unknown>((...args: unknown[]) => {
      const url = String(args[0]);
      if (url.startsWith('data:')) return realFetch(args[0] as string);
      return Promise.reject(new Error(`rede proibida durante a geração (lex C11): ${url}`));
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  it('com todas as células: nome, documento, cobertura, serviço, contato, CID, textos, catálogos, autor e rodapé estão no PDF', async () => {
    const { text, pages } = await texto(fullInput);
    for (const esperado of [
      'Proyecto Terapéutico – EnLite Care',
      'PACIENTE-SINTETICO Apellido', 'DNI 00.000.000', '29/03/1938', '88 años',
      'Cobertura Sintética', '0000-TEST',
      'Cuidador', 'Domicilio', 'Perfil sintético del prestador', 'Lunes a domingo, 24 hs',
      'Calle Sintética 123', 'RESPONSABLE-SINTETICO (hijo) - 11 0000 0000 - resp@example.test',
      'Modalidad: Presencial', 'Familiar / persona responsable', 'Emergencia de la cobertura médica',
      'Ambulancia: AMBULANCIA-SINTETICA - 0800 000 0001', 'Profesional directo: PROFESIONAL-DIRECTO-SINTETICO - 11 0000 0002',
      'Hemiplejía sintética de prueba', 'Trastornos psicóticos', 'Equipo tratante sintético',
      'SINTESIS-CLINICA-SINTETICA', 'OBJETIVO-GENERAL-SINTETICO',
      'Favorecer la prevención de escaras (test).', 'Realizar cambios posturales frecuentes (test).',
      'Funciones y límites del cuidador', 'Regla fundamental de EnLite Care', 'El cuidador NO debe',
      'Proyecto elaborado por: Ana Sintética', 'Septiembre a diciembre 2026', 'Fecha de confección: 07/09/2026',
      'Caso: 12345', 'Versión V.1.2', 'Emitido: 08/09/2026 10:00',
      'Documento confidencial', 'puede ser corregido y reemplazado',
    ]) {
      expect(text, esperado).toContain(esperado);
    }
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain('ICHOM');
    expect(text).not.toContain(PDF_LABELS.sectionRedacted);
    expect(text).not.toContain(PDF_LABELS.annulled);
    // lex C11: nenhuma requisição de rede — as fontes vieram de arquivo.
    expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith('data:'))).toEqual([]);
  });

  it('🔒 sem identidade, família e clínica: o NOME, o contato e o texto clínico NÃO estão; o rótulo de omissão está', async () => {
    const redigida: TherapeuticProjectPdfInput = {
      ...fullInput,
      identification: null,
      emergencyContacts: null,
      careTeam: null,
      version: { ...version, clinicalContext: null, generalObjective: null, diagnoses: null, redacted: { clinical: true } },
    };
    const { text } = await texto(redigida);
    for (const proibido of ['PACIENTE-SINTETICO', 'DNI 00.000.000', 'RESPONSABLE-SINTETICO', 'resp@example.test', 'SINTESIS-CLINICA-SINTETICA', 'OBJETIVO-GENERAL-SINTETICO', 'Hemiplejía sintética', 'Equipo tratante sintético']) {
      expect(text, proibido).not.toContain(proibido);
    }
    expect(text).toContain(PDF_LABELS.sectionRedacted);
    // O que não é clínico continua: catálogos, cobertura, serviço, rodapé.
    expect(text).toContain('Favorecer la prevención de escaras (test).');
    expect(text).toContain('Cobertura Sintética');
    expect(text).toContain('Versión V.1.2');
  });

  it('versão anulada leva o carimbo; campos vazios saem como "—", contatos vazios idem', async () => {
    const anulada: TherapeuticProjectPdfInput = {
      ...fullInput,
      version: { ...version, annulledAt: '2026-09-08T00:00:00Z', annulledByName: 'Ana', annulReason: 'erro', createdByName: null },
      coverage: { insurance: null, affiliateId: null },
      service: { serviceLabel: 'Cuidador', deviceLabels: [], providerProfile: null, scheduleText: null, careLocationLabel: null },
      emergencyContacts: [],
      coverageEmergencyContacts: [],
      modalityLabel: null,
      careTeam: [],
      identification: { fullName: 'X Y', documentLabel: 'DNI —', birthDate: null, age: null },
    };
    const { text } = await texto(anulada);
    expect(text).toContain(PDF_LABELS.annulled);
    expect(text).toContain('Proyecto elaborado por: —');
    expect(text).toContain('Cobertura médica: —');
    expect(text).toContain('Familiar / persona responsable: —');
    expect(text).toContain('Emergencia de la cobertura médica: —');
    expect(text).toContain('Modalidad: —'); // versão anterior à 417
    expect(text).toContain('Fecha de nacimiento: —');
  });

  it('🔒 lex C5 — contatos da COBERTURA redigidos com família visível: o bloco da cobertura vira rótulo e o nome/telefone NÃO estão; o familiar continua', async () => {
    const { text } = await texto({ ...fullInput, coverageEmergencyContacts: null });
    expect(text).not.toContain('AMBULANCIA-SINTETICA');
    expect(text).not.toContain('PROFESIONAL-DIRECTO-SINTETICO');
    expect(text).not.toContain('0800 000 0001');
    expect(text).toContain('RESPONSABLE-SINTETICO (hijo)');
    expect(text).toContain(PDF_LABELS.sectionRedacted);
    // E o inverso: família redigida, cobertura visível.
    const { text: inverso } = await texto({ ...fullInput, emergencyContacts: null });
    expect(inverso).not.toContain('RESPONSABLE-SINTETICO');
    expect(inverso).toContain('AMBULANCIA-SINTETICA');
  });

  it('D301.1 — serviço AT (congelado na VERSÃO): as seções VIII/IX saem com o rótulo "no aplicable" e SEM o texto do cuidador; sem célula de serviço o texto do cuidador CONTINUA (é constante)', async () => {
    const at = await texto({ ...fullInput, fixedSectionsServiceCode: 'AT' });
    expect(at.text).toContain('Funciones y límites del cuidador');
    expect(at.text).toContain('Regla fundamental de EnLite Care');
    expect(at.text.split(PDF_LABELS.sectionNotForService).length - 1).toBe(2);
    expect(at.text).not.toContain('El cuidador NO debe');
    expect(at.text).not.toContain('Por cuestiones Terapéuticas');
    const semServico = await texto({ ...fullInput, service: null });
    expect(semServico.text).toContain('El cuidador NO debe'); // texto fixo não depende de célula
    expect(semServico.text).toContain('Por cuestiones Terapéuticas');
    expect(semServico.text).not.toContain(PDF_LABELS.sectionNotForService);
    expect(semServico.text).toContain(PDF_LABELS.sectionRedacted); // só o bloco do serviço (dados) é redigido
  });

  it('lex C3 / D167 — profissional direto retido: o rótulo sai junto da lista; leitura indisponível: "No disponible", nunca "—"', async () => {
    const retido = await texto({ ...fullInput, coverageEmergencyContacts: [fullInput.coverageEmergencyContacts![0]], coverageDirectProfessionalRedacted: true });
    expect(retido.text).toContain('Ambulancia: AMBULANCIA-SINTETICA');
    expect(retido.text).toContain(PDF_LABELS.directProfessionalWithheld);
    expect(retido.text).not.toContain('PROFESIONAL-DIRECTO-SINTETICO');
    const indisponivel = await texto({ ...fullInput, coverageEmergencyContacts: [], coverageEmergencyContactsUnavailable: true });
    expect(indisponivel.text).toContain(`Emergencia de la cobertura médica: ${PDF_LABELS.fieldUnavailable}`);
    expect(indisponivel.text).not.toContain('Emergencia de la cobertura médica: —');
    expect(fullInput.coverageDirectProfessionalRedacted).toBe(false);
    const { text } = await texto(fullInput);
    expect(text).not.toContain(PDF_LABELS.directProfessionalWithheld);
    expect(text).not.toContain(PDF_LABELS.fieldUnavailable);
  });

  it('cobertura, serviço e endereço redigidos (containers separados): cada um vira o rótulo de omissão', async () => {
    const { text } = await texto({ ...fullInput, coverage: null, service: null, addressText: null });
    expect(text).not.toContain('Cobertura Sintética');
    expect(text).not.toContain('Perfil sintético del prestador');
    expect(text).not.toContain('Calle Sintética');
    expect(text.split(PDF_LABELS.sectionRedacted).length - 1).toBeGreaterThanOrEqual(3);
  });

  it('o Blob do navegador nasce do mesmo documento (fontes já registradas) e é um PDF', async () => {
    const blob = await renderTherapeuticProjectPdfBlob(fullInput);
    expect(blob.type).toBe('application/pdf');
    const head = Buffer.from(await blob.slice(0, 5).arrayBuffer()).toString('latin1');
    expect(head).toBe('%PDF-');
  });

  it('helpers de data: idade civil, dd/mm/aaaa e prazo — bordas', () => {
    const hoje = new Date(2026, 8, 8); // 08/09/2026
    expect(ageFromBirthDate('1938-03-29', hoje)).toBe(88);
    expect(ageFromBirthDate('1938-09-09', hoje)).toBe(87); // aniversário amanhã
    expect(ageFromBirthDate('1938-09-08', hoje)).toBe(88); // aniversário hoje
    expect(ageFromBirthDate('2027-01-01', hoje)).toBeNull(); // futuro
    expect(ageFromBirthDate(null, hoje)).toBeNull();
    expect(ageFromBirthDate('não-é-data', hoje)).toBeNull();
    expect(formatIsoDateEsAr(null)).toBeNull();
    expect(formatIsoDateEsAr('texto')).toBe('texto');
    expect(formatIsoDateEsAr('2026-12-31T00:00:00Z')).toBe('31/12/2026');
    expect(implementationPeriodText('2026-09-01', '2026-12-31')).toBe('Septiembre a diciembre 2026');
    expect(implementationPeriodText('x', '2026-12-31')).toBe('x – 31/12/2026');
  });

  it('bordas dos campos compostos: logo presente, nascimento sem idade, cobertura sem afiliado, contato sem vínculo', async () => {
    const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const { text } = await texto({
      ...fullInput,
      logoSrc: png1x1,
      identification: { fullName: 'X Y', documentLabel: 'DNI 1', birthDate: '1938-03-29', age: null },
      coverage: { insurance: 'Cobertura Sintética', affiliateId: null },
      emergencyContacts: [{ name: 'CONTATO-SEM-VINCULO', relationship: null, phone: null, email: null }],
    });
    expect(text).toContain('Fecha de nacimiento: 29/03/1938');
    expect(text).not.toContain('años');
    expect(text).toContain('Cobertura médica: Cobertura Sintética');
    expect(text).not.toContain('N.º de afiliado');
    expect(text).toContain('Familiar / persona responsable: CONTATO-SEM-VINCULO');
  });

  it('prazo em anos diferentes e nome do arquivo sem nome de paciente', async () => {
    const { text } = await texto({ ...fullInput, version: { ...version, startDate: '2026-11-01', endDate: '2027-02-28' } });
    expect(text).toContain('Noviembre 2026 a febrero 2027');
    expect(pdfFileName(fullInput)).toBe('proyecto-terapeutico-caso-12345-V_1_2.pdf');
    expect(pdfFileName(fullInput)).not.toContain('SINTETICO');
  });
});
