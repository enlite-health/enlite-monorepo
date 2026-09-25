/**
 * Constants for GeminiVacancyParserService:
 * - Response schemas (Gemini responseSchema)
 * - Prompt instructions (system prompt suffixes)
 */

// ─────────────────────────────────────────────────────────────────
// Gemini responseSchema — forces structured JSON output
// ─────────────────────────────────────────────────────────────────

export const VACANCY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    vacancy: {
      type: 'OBJECT',
      properties: {
        case_number: { type: 'INTEGER', nullable: true },
        title: { type: 'STRING' },
        required_professions: { type: 'ARRAY', items: { type: 'STRING' } },
        required_sex: { type: 'STRING', nullable: true },
        age_range_min: { type: 'INTEGER', nullable: true },
        age_range_max: { type: 'INTEGER', nullable: true },
        required_experience: { type: 'STRING', nullable: true },
        worker_attributes: { type: 'STRING', nullable: true },
        schedule: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              dayOfWeek: { type: 'INTEGER' },
              startTime: { type: 'STRING' },
              endTime: { type: 'STRING' },
            },
            required: ['dayOfWeek', 'startTime', 'endTime'],
          },
        },
        work_schedule: { type: 'STRING', nullable: true },
        /** Transit: passed to patients.diagnosis — not persisted in job_postings */
        pathology_types: { type: 'STRING', nullable: true },
        /** Transit: passed to patients.dependency_level — not persisted in job_postings */
        dependency_level: { type: 'STRING', nullable: true },
        providers_needed: { type: 'INTEGER' },
        salary_text: { type: 'STRING', nullable: true },
        payment_day: { type: 'STRING', nullable: true },
        daily_obs: { type: 'STRING', nullable: true },
        status: { type: 'STRING' },
      },
      required: [
        'title', 'required_professions', 'schedule',
        'providers_needed', 'status',
      ],
    },
    prescreening: {
      type: 'OBJECT',
      properties: {
        questions: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              question: { type: 'STRING' },
              responseType: { type: 'ARRAY', items: { type: 'STRING' } },
              desiredResponse: { type: 'STRING' },
              weight: { type: 'INTEGER' },
              required: { type: 'BOOLEAN' },
              analyzed: { type: 'BOOLEAN' },
              earlyStoppage: { type: 'BOOLEAN' },
            },
            required: ['question', 'responseType', 'desiredResponse', 'weight', 'required', 'analyzed', 'earlyStoppage'],
          },
        },
        faq: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              question: { type: 'STRING' },
              answer: { type: 'STRING' },
            },
            required: ['question', 'answer'],
          },
        },
      },
      required: ['questions', 'faq'],
    },
    description: {
      type: 'OBJECT',
      properties: {
        titulo_propuesta: { type: 'STRING' },
        descripcion_propuesta: { type: 'STRING' },
        perfil_profesional: { type: 'STRING' },
      },
      required: ['titulo_propuesta', 'descripcion_propuesta', 'perfil_profesional'],
    },
  },
  required: ['vacancy', 'prescreening', 'description'],
};

export const TALENTUM_VACANCY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    required_professions: { type: 'ARRAY', items: { type: 'STRING' } },
    required_sex: { type: 'STRING', nullable: true },
    age_range_min: { type: 'INTEGER', nullable: true },
    age_range_max: { type: 'INTEGER', nullable: true },
    required_experience: { type: 'STRING', nullable: true },
    worker_attributes: { type: 'STRING', nullable: true },
    schedule: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          dayOfWeek: { type: 'INTEGER' },
          startTime: { type: 'STRING' },
          endTime: { type: 'STRING' },
        },
        required: ['dayOfWeek', 'startTime', 'endTime'],
      },
    },
    work_schedule: { type: 'STRING', nullable: true },
    /** Transit: passed to patients.diagnosis — not persisted in job_postings */
    pathology_types: { type: 'STRING', nullable: true },
    /** Transit: passed to patients.dependency_level — not persisted in job_postings */
    dependency_level: { type: 'STRING', nullable: true },
    providers_needed: { type: 'INTEGER' },
    salary_text: { type: 'STRING', nullable: true },
    payment_day: { type: 'STRING', nullable: true },
    daily_obs: { type: 'STRING', nullable: true },
    status: { type: 'STRING' },
  },
  required: ['required_professions', 'schedule', 'providers_needed', 'status'],
};

// ─────────────────────────────────────────────────────────────────
// Prompt text constants
// ─────────────────────────────────────────────────────────────────

const SELF_REVIEW_CHECKLIST = `
CHECKLIST DE AUTO-REVISIÓN (verificar ANTES de responder):
Revisá tu JSON contra el texto original campo por campo:
1. ¿El texto menciona un rango de edad requerido para el PROFESIONAL (no del paciente)? → age_range_min y age_range_max. CUIDADO: la edad del paciente NO es age_range — dejá null si solo se menciona la edad del paciente.
2. ¿El texto menciona sexo/género del profesional (ej: "AT varón", "cuidadora mujer", "indistinto")? → required_sex debe ser "M", "F" o "BOTH". "varón" SIEMPRE es "M", "mujer" SIEMPRE es "F".
3. ¿El texto menciona días y horarios? → schedule debe tener TODOS los días/horarios.
4. ¿El texto menciona diagnóstico o patología? → pathology_types debe estar presente (se usa para actualizar el paciente).
5. ¿El texto menciona nivel de dependencia? → dependency_level debe estar presente (se usa para actualizar el paciente).
6. ¿El texto menciona experiencia requerida? → required_experience debe estar presente.
7. ¿El texto menciona salario o remuneración? → salary_text debe estar presente.
Si algún dato está en el texto pero falta en tu JSON, CORREGILO antes de responder.`;

export const TALENTUM_VACANCY_ONLY_INSTRUCTIONS = `
FORMATO DE RESPUESTA OBLIGATORIO:
Tu respuesta DEBE ser ÚNICAMENTE un JSON válido con la estructura descrita abajo.
No incluyas texto, markdown ni explicaciones fuera del JSON.

CONTEXTO:
Estás parseando la descripción de un proyecto publicado en Talentum (plataforma de pre-screening).
Tu tarea es extraer SOLO los campos de vacancy. NO generes prescreening ni description — ya existen en Talentum.

MAPEO DE VALORES (usar SIEMPRE estos códigos, no texto libre):
- Sexo del PROFESIONAL (campo "Perfil del Prestador Buscado" o descripción del profesional buscado):
  - "M": varón, varon, hombre, masculino, masc, AT varón, cuidador (en masculino sin "/a")
  - "F": mujer, femenina, femenino, fem, AT mujer, cuidadora
  - "BOTH": indistinto, ambos, cualquiera, sin preferencia, "AT varón o mujer", "M/F"
  - null: si no se menciona preferencia de sexo del profesional
  - IMPORTANTE: el sexo del PACIENTE no cuenta. Solo extraer sexo cuando se refiere al AT/cuidador/profesional buscado.
- Profesión: AT→"AT", Cuidador/a→"CAREGIVER", Enfermero/a→"NURSE", Kinesiólogo/a→"KINESIOLOGIST", Psicólogo/a→"PSYCHOLOGIST"
  - Si el texto menciona "acompañante terapéutico" o "AT" → "AT"
  - Si el texto menciona "cuidador/a", "asistente domiciliario/a", o funciones de cuidado sin mención terapéutica → "CAREGIVER"
- Jornada: jornada completa→"full-time", medio turno→"part-time", flexible→"flexible"
- Día de semana: 0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb
- Nivel de dependencia: usar SIEMPRE uno de estos valores exactos (capitalización incluida): "Leve", "Moderado", "Grave", "Alto", "Muy Grave". Mapeo: LEVE→"Leve", MODERADO/MODERADA→"Moderado", GRAVE→"Grave", ALTO/ALTA→"Alto", MUY GRAVE→"Muy Grave". Si no se menciona, null.

EXTRACCIÓN DE HORARIOS (schedule):
- Si el texto contiene un campo estructurado "Días y Horarios de Acompañamiento", usar ESE como fuente única de verdad e IGNORAR cualquier otro horario mencionado en el encabezado o descripción libre.
- Formato "16hs a 19hs" = 16:00 a 19:00. Formato "16:45 a 18:45" es literal.
- "Lunes y viernes de 16hs a 19hs" → dos entradas: {dayOfWeek:1,16:00-19:00} y {dayOfWeek:5,16:00-19:00}.

ESQUEMA JSON:
{
  "required_professions": ["AT"|"CAREGIVER"|"NURSE"|"KINESIOLOGIST"|"PSYCHOLOGIST"],
  "required_sex": "M"|"F"|"BOTH"|null,
  "age_range_min": <integer o null — edad mínima del PROFESIONAL, NO del paciente>,
  "age_range_max": <integer o null — edad máxima del PROFESIONAL, NO del paciente>,
  "required_experience": "<texto o null>",
  "worker_attributes": "<atributos separados por coma o null>",
  "schedule": [
    { "dayOfWeek": <0-6>, "startTime": "HH:MM", "endTime": "HH:MM" }
  ],
  "work_schedule": "full-time"|"part-time"|"flexible"|null,
  "pathology_types": "<diagnósticos o null — actualiza patients.diagnosis>",
  "dependency_level": "Leve"|"Moderado"|"Grave"|"Alto"|"Muy Grave"|null,
  "providers_needed": <integer, default 1>,
  "salary_text": "<texto o null>",
  "payment_day": "<texto o null>",
  "daily_obs": "<observaciones o null>",
  "status": "SEARCHING"
}

REGLAS:
- Extraer SOLO lo que está en el texto. Si un campo no puede inferirse, devolver null.
- NUNCA inventar datos que no estén en la descripción.
- providers_needed default 1 si no se especifica.
- status siempre "SEARCHING".
${SELF_REVIEW_CHECKLIST}
`;

export const JSON_OUTPUT_INSTRUCTIONS = `
FORMATO DE RESPUESTA OBLIGATORIO:
Tu respuesta DEBE ser ÚNICAMENTE un JSON válido con la estructura descrita abajo.
No incluyas texto, markdown ni explicaciones fuera del JSON.

MAPEO DE VALORES (usar SIEMPRE estos códigos, no texto libre):
- Sexo del PROFESIONAL (campo "Perfil del Prestador Buscado" o descripción del profesional buscado):
  - "M": varón, varon, hombre, masculino, masc, AT varón, cuidador (en masculino sin "/a")
  - "F": mujer, femenina, femenino, fem, AT mujer, cuidadora
  - "BOTH": indistinto, ambos, cualquiera, sin preferencia, "AT varón o mujer", "M/F"
  - null: si no se menciona preferencia de sexo del profesional
  - IMPORTANTE: el sexo del PACIENTE no cuenta. Solo extraer sexo cuando se refiere al AT/cuidador/profesional buscado.
- Profesión: AT→"AT", Cuidador/a→"CAREGIVER", Enfermero/a→"NURSE", Kinesiólogo/a→"KINESIOLOGIST", Psicólogo/a→"PSYCHOLOGIST"
- Jornada: jornada completa→"full-time", medio turno→"part-time", flexible→"flexible"
- Día de semana: 0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb
- Nivel de dependencia: usar SIEMPRE uno de estos valores exactos (capitalización incluida): "Leve", "Moderado", "Grave", "Alto", "Muy Grave". Mapeo: LEVE→"Leve", MODERADO/MODERADA→"Moderado", GRAVE→"Grave", ALTO/ALTA→"Alto", MUY GRAVE→"Muy Grave". Si no se menciona, null.

REGLA DE FORMATO DEL NÚMERO DE CASO (D422, 24/09/2026 — case_number ≥ 1000 es secuencia nativa, < 1000 es legado de ClickUp):
- Al ESCRIBIR el número de caso en "title" o "titulo_propuesta": usá "CASO EN{n}" si case_number ≥ 1000 (ej: "CASO EN1234"), y "CASO {n}" sin prefijo si case_number < 1000 (ej: "CASO 729").
- Al LEER el número de caso desde el texto fuente: reconocé todos los formatos por igual — "CASO 1234", "CASO EN1234", "EN1234" y "1234" refieren al mismo caso.

EXTRACCIÓN DE HORARIOS (schedule):
- Si el PDF contiene el campo estructurado "Días y Horarios de Acompañamiento", usar ESE como fuente única de verdad e IGNORAR cualquier otro horario mencionado en el encabezado o descripción libre (aunque difieran).
- Formato "16hs a 19hs" = 16:00 a 19:00. Formato "16:45 a 18:45" es literal.
- "Lunes y viernes de 16hs a 19hs" → dos entradas: {dayOfWeek:1,16:00-19:00} y {dayOfWeek:5,16:00-19:00}.

ESQUEMA JSON:
{
  "vacancy": {
    "case_number": <integer o null>,
    "title": "<CASO N o CASO EN<N> — ver REGLA DE FORMATO DEL NÚMERO DE CASO>",
    "required_professions": ["AT"|"CAREGIVER"|"NURSE"|"KINESIOLOGIST"|"PSYCHOLOGIST"],
    "required_sex": "M"|"F"|"BOTH"|null,
    "age_range_min": <integer o null>,
    "age_range_max": <integer o null>,
    "required_experience": "<texto o null>",
    "worker_attributes": "<atributos separados por coma o null>",
    "schedule": [
      { "dayOfWeek": <0-6>, "startTime": "HH:MM", "endTime": "HH:MM" }
    ],
    "work_schedule": "full-time"|"part-time"|"flexible",
    "pathology_types": "<diagnósticos — actualiza patients.diagnosis>",
    "dependency_level": "Leve"|"Moderado"|"Grave"|"Alto"|"Muy Grave",
    "providers_needed": <integer, default 1>,
    "salary_text": "<texto o 'A convenir'>",
    "payment_day": "<texto o null>",
    "daily_obs": "<observaciones o null>",
    "status": "SEARCHING"
  },
  "prescreening": {
    "questions": [
      {
        "question": "<pregunta en español argentino con voseo>",
        "responseType": ["text", "audio"],
        "desiredResponse": "Apto: ... / Aceptable: ... / No Apto: ...",
        "weight": <1-10>,
        "required": <boolean>,
        "analyzed": true,
        "earlyStoppage": <boolean>
      }
    ],
    "faq": [
      { "question": "<pregunta frecuente>", "answer": "<respuesta>" }
    ]
  },
  "description": {
    "titulo_propuesta": "<CASO N o CASO EN<N> — ver REGLA DE FORMATO DEL NÚMERO DE CASO>, <TIPO> - <ZONA>",
    "descripcion_propuesta": "<texto Descripción de la Propuesta>",
    "perfil_profesional": "<texto Perfil Profesional Sugerido>"
  }
}
${SELF_REVIEW_CHECKLIST}

REGLAS PARA PRESCREENING:
- Generar entre 5 y 8 preguntas relevantes al caso
- Usar voseo argentino (¿Tenés...?, ¿Podés...?, ¿Contás con...?)
- desiredResponse con criterios Apto/Aceptable/No Apto
- weight 8-10 para formación y experiencia, 5-7 para disponibilidad, 3-5 para soft skills
- earlyStoppage: true en preguntas sobre formación obligatoria o zona
- Generar entre 3 y 5 FAQ (horario, zona, pago, supervisión)

REGLAS PARA DESCRIPCIÓN:
- Español argentino profesional
- No incluir nombre del paciente ni datos de contacto
- descripcion_propuesta: resumen objetivo (zona, dispositivo, horarios, patología, objetivo)
- perfil_profesional: formación requerida, experiencia, atributos valorados
`;
