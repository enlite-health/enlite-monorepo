/**
 * Textos FIXOS do PDF "Proyecto Terapéutico – EnLite Care" (spec 017, D299.7): sempre es-AR,
 * independente do idioma do painel — o documento é entregável externo (família/financiador), a UI é
 * ferramenta interna. As seções VIII (funciones y límites del cuidador) e IX (regla fundamental) são
 * texto fixo por decisão do Gabriel (08/09): "fixo POR ENQUANTO; se mudarem, viram catálogo".
 *
 * Nada aqui é dado de titular. Rótulo "ICHOM" não existe (D299.2).
 */

export const PDF_TITLE = 'Proyecto Terapéutico – EnLite Care';

/** Só o serviço de cuidadores carrega as seções fixas VIII/IX (Ana Joulie, 08/09 — D301.1). */
export const FIXED_SECTIONS_SERVICE_CODE = 'CAREGIVER';

export const PDF_SECTIONS = {
  identification: 'I. Datos de Identificación',
  diagnosis: 'II. Datos del Diagnóstico',
  careTeam: 'III. Equipo tratante',
  clinicalContext: 'IV. Síntesis clínica y contexto',
  generalObjective: 'V. Objetivo general',
  specificObjectives: 'VI. Objetivos Específicos',
  activities: 'VII. Rutina y Actividades',
  caregiverLimits: 'VIII. Funciones y límites del cuidador(a)',
  fundamentalRule: 'IX. Regla fundamental de EnLite Care',
  projectData: 'X. Datos del Proyecto Terapéutico',
} as const;

export const PDF_LABELS = {
  patient: 'Paciente',
  document: 'Documento',
  birthDate: 'Fecha de nacimiento',
  age: 'Edad',
  years: 'años',
  coverage: 'Cobertura médica',
  affiliateId: 'N.º de afiliado',
  requestedService: 'Servicio solicitado',
  deviceType: 'Tipo de Dispositivo',
  providerProfile: 'Perfil del prestador(a)',
  authorizedSchedule: 'Días y horarios autorizados',
  address: 'Dirección',
  emergencyContact: 'Contacto de emergencia',
  familyEmergencyContact: 'Familiar / persona responsable',
  coverageEmergencyContact: 'Emergencia de la cobertura médica',
  modality: 'Modalidad',
  pathologyType: 'Tipo de patología (segmento)',
  elaboratedBy: 'Proyecto elaborado por',
  implementationPeriod: 'Plazo de implementación',
  issueDate: 'Fecha de confección',
  version: 'Versión',
  caseNumber: 'Caso',
  issuedAt: 'Emitido',
  notInformed: '—',
  /** Seção cujo container foi redigido para o ator (lex C12): omitida COM rótulo, nunca em branco. */
  sectionRedacted: 'Sección no incluida: el usuario que emitió este documento no tiene permiso para este dato.',
  /** D301.1 (Ana): o texto fixo VIII/IX é do serviço de CUIDADORES; nos demais serviços a seção sai omitida COM rótulo. */
  sectionNotForService: 'Sección no aplicable a este servicio: el texto está definido para el servicio de cuidadores.',
  /** Versão anulada — não deve ser exportada (C5), mas se o for, o documento diz. */
  annulled: 'VERSIÓN ANULADA',
} as const;

export const PDF_FOOTER = {
  confidentiality:
    'Documento confidencial con datos de salud (Ley 25.326, art. 2 y 10). Uso exclusivo del equipo de cuidado y de la familia/representante del paciente. Prohibida su reproducción o divulgación.',
  mutable: 'Este documento puede ser corregido y reemplazado por una versión posterior.',
} as const;

/** VIII — texto do documento de referência (genérico, sem dado de titular). */
export const CAREGIVER_LIMITS: ReadonlyArray<{ title: string; items: readonly string[] }> = [
  {
    title: '1. Asistencia en la vida diaria',
    items: [
      'Asistir al paciente en higiene, vestido y uso del baño.',
      'Brindar apoyo durante la alimentación e hidratación, de acuerdo con las indicaciones recibidas.',
      'Asistir en transferencias y desplazamientos según las capacidades del paciente.',
      'Colaborar con la organización de los elementos personales y del espacio utilizado por el paciente.',
      'Favorecer la autonomía, evitando realizar por el paciente aquello que puede hacer por sí mismo.',
    ],
  },
  {
    title: '2. Supervisión y seguridad',
    items: [
      'Supervisar al paciente de acuerdo con su nivel de dependencia y riesgo.',
      'Identificar y prevenir situaciones que puedan comprometer su seguridad.',
      'Acompañar salidas, consultas o actividades cuando estén contempladas en el servicio.',
      'Informar (llamando por teléfono), inmediatamente, cualquier accidente, cambio significativo o situación de riesgo.',
    ],
  },
  {
    title: '3. Acompañamiento y bienestar',
    items: [
      'Brindar compañía y presencia permanente durante la jornada.',
      'Favorecer una rutina organizada y adecuada a las necesidades del paciente.',
      'Estimular actividades recreativas, sociales y de ocio acordes a sus posibilidades.',
      'Respetar los tiempos, preferencias, decisiones y dignidad del paciente.',
    ],
  },
  {
    title: '4. Comunicación y registro',
    items: [
      'Registrar información relevante de la jornada.',
      'Comunicar a la coordinación y/o familia las novedades significativas.',
      'Mantener una comunicación respetuosa y profesional con el paciente, la familia y el equipo.',
    ],
  },
];

export const CAREGIVER_LIMITS_INTRO =
  'El cuidador debe actuar dentro de las funciones para las cuales fue contratado y de sus competencias, sin asumir responsabilidades propias de otros profesionales.';

export const CAREGIVER_MUST_NOT_TITLE = 'El cuidador NO debe:';
export const CAREGIVER_MUST_NOT: readonly string[] = [
  'Diagnosticar, evaluar clínicamente o establecer pronósticos.',
  'Indicar, modificar o suspender tratamientos o medicación.',
  'Realizar procedimientos clínicos o invasivos para los cuales no esté habilitado.',
  'Ejecutar intervenciones propias de psicología, psiquiatría, fisioterapia, terapia ocupacional, enfermería u otras disciplinas.',
  'Modificar las pautas establecidas por el equipo tratante.',
  'Tomar decisiones clínicas en nombre del paciente, la familia o el equipo profesional.',
  'Realizar tareas domésticas que no estén directamente relacionadas con el cuidado del paciente.',
  'Asumir responsabilidades sobre otros miembros de la familia.',
  'Realizar técnicas de rehabilitación como sustituto de un fisioterapeuta o terapeuta ocupacional.',
  'Asumir funciones propias de un Acompañante Terapéutico si ese no es el servicio contratado.',
  'Realizar contenciones físicas como práctica habitual.',
  'Ocultar información relevante a la familia o a la coordinación.',
  'Dar diagnósticos, pronósticos o indicaciones médicas al paciente o a su familia.',
];

export const NOT_DOMESTIC_TITLE = 'El cuidador no es personal doméstico. Por lo tanto, no corresponde que:';
export const NOT_DOMESTIC: readonly string[] = [
  'Limpie toda la vivienda.',
  'Lave ropa de toda la familia.',
  'Cocine para toda la familia.',
  'Cuide a otros integrantes del hogar.',
  'Realice compras personales de la familia.',
  'Realice tareas domésticas que no estén vinculadas directamente con el cuidado del paciente.',
];
export const NOT_DOMESTIC_OUTRO =
  'Sí puede colaborar con tareas directamente relacionadas con el paciente, como preparar su comida, organizar sus pertenencias o mantener ordenado el espacio que utiliza.';

/** IX — regra fundamental (genérico). */
export const FUNDAMENTAL_RULE: ReadonlyArray<{ title: string; items: readonly string[] }> = [
  {
    title: 'Por cuestiones Terapéuticas',
    items: [
      'No psicoterapizar: el acompañamiento no reemplaza el espacio clínico individual. No corresponde realizar interpretaciones, devoluciones ni intervenciones clínicas profundas.',
      'No invadir ni forzar espacios de intimidad emocional o corporal: el respeto por el ritmo y los límites del paciente es clave en el vínculo terapéutico.',
      'No generar dependencia emocional: evitar posicionamientos salvadores o relaciones asimétricas de poder.',
      'No involucrarse en la administración de la toma de medicación.',
      'No aplicar medicación o realizar procedimientos médicos.',
      'No recomendar el uso de ningún tipo de red social sin el consentimiento del familiar de referencia.',
    ],
  },
  {
    title: 'Por cuestiones Administrativas',
    items: [
      'No modificar horario y días sin consentimiento del coordinador.',
      'No delegar funciones propias a otros familiares, cuidadores o acompañantes.',
      'No utilizar recursos personales del acompañante (dinero, transporte propio) para cubrir necesidades del paciente.',
      'No utilizar el celular con fines personales durante el servicio.',
    ],
  },
  {
    title: 'Por cuestiones Éticas',
    items: [
      'No desarrollar vínculo extra terapéutico: no involucrarse en relaciones afectivas o personales por fuera del encuadre.',
      'No exponer al paciente en redes sociales ni en espacios no autorizados.',
      'No aceptar regalos, dinero ni beneficios personales por parte del paciente o su familia.',
      'No brindar información clínica a la familia sin coordinación previa.',
      'No establecer vínculos afectivos desbordados o informales con el paciente o su entorno.',
    ],
  },
];
