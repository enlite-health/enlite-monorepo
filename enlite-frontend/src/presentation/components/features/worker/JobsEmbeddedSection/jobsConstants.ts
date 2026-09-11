import { TFunction } from 'i18next';
import type { SelectOption } from '@presentation/components/molecules/SelectField';
import { buildPendingRows } from '@presentation/utils/pendingRows';
export type { PublicJobListing } from '@domain/entities/PublicJobListing';

export interface Job {
  code: string;
  title: string;
  workerType: string;
  provincia: string;
  localidad: string;
  barrio: string;
  workerSex: string;
  /**
   * ⚠️ REMOVIDO em 25/08/2026 — não é omissão. Era `patients.diagnosis`, texto livre clínico,
   * servido cru pela rota pública `/api/public/v1/jobs`. O campo saiu do feed; nada a exibir.
   */
  description: string;
  service: string;
  daysAndHours: string;
  ageRange: string;
  profile: string;
  whatsappLink: string;
  detailLink: string;
}

export const getWorkerTypeOptions = (t: TFunction): SelectOption[] => [
  { value: 'acompañante terapéutico', label: t('jobs.types.at') },
  { value: 'acompañante terapéutico (at)', label: t('jobs.types.at_full') },
  { value: 'acompañante terapéutico (at) escolar', label: t('jobs.types.at_school') },
  { value: 'cuidador/a', label: t('jobs.types.caregiver') },
];

export const getProvinceOptions = (t: TFunction): SelectOption[] => [
  { value: 'caba', label: t('jobs.provinces.caba') },
  { value: 'provincia de buenos aires', label: t('jobs.provinces.buenos_aires') },
  { value: 'provincia de misiones', label: t('jobs.provinces.misiones') },
];

export const getLocalityOptions = (): SelectOption[] => [
  { value: 'adrogué (internación) y boedo, caba', label: 'Adrogué (Internación) y Boedo, CABA' },
  { value: 'almagro', label: 'Almagro' },
  { value: 'avellaneda', label: 'Avellaneda' },
  { value: 'bahía blanca', label: 'Bahía Blanca' },
  { value: 'balvanera', label: 'Balvanera' },
  { value: 'balvanera/constitución', label: 'Balvanera/Constitución' },
  { value: 'belgrano', label: 'Belgrano' },
  { value: 'belgrano, cdad. autónoma de buenos aires', label: 'Belgrano, Cdad. Autónoma de Buenos Aires' },
  { value: 'boedo', label: 'Boedo' },
  { value: 'caba', label: 'CABA' },
  { value: 'caballito', label: 'Caballito' },
  { value: 'caballito/ almagro', label: 'Caballito/ Almagro' },
  { value: 'colegiales', label: 'Colegiales' },
  { value: 'congreso y flores', label: 'Congreso y Flores' },
  { value: 'florencio varela', label: 'Florencio Varela' },
  { value: 'flores', label: 'Flores' },
  { value: 'flores / palermo', label: 'Flores / Palermo' },
  { value: 'flores, caba', label: 'Flores, CABA' },
  { value: 'florida', label: 'Florida' },
  { value: 'gerli, avellaneda', label: 'Gerli, Avellaneda' },
  { value: 'ing. pablo nogués', label: 'Ing. Pablo Nogués' },
  { value: 'isidro casanova, la matanza', label: 'Isidro Casanova, La Matanza' },
  { value: 'ituzaingó', label: 'Ituzaingó' },
  { value: 'la boca', label: 'La Boca' },
  { value: 'lanús este', label: 'Lanús Este' },
  { value: 'leandro n. alem', label: 'Leandro N. Alem' },
  { value: 'lomas de zamora, provincia de buenos aires', label: 'Lomas de Zamora, Provincia de Buenos Aires' },
  { value: 'mar del plata', label: 'Mar del Plata' },
  { value: 'mataderos', label: 'Mataderos' },
  { value: 'morón', label: 'Morón' },
  { value: 'nordelta (tigre) y puerto madero (caba)', label: 'Nordelta (Tigre) y Puerto Madero (CABA)' },
  { value: 'nuñez', label: 'Nuñez' },
  { value: 'olivos', label: 'Olivos' },
  { value: 'palermo', label: 'Palermo' },
  { value: 'palermo, caba (escuela martin buber)', label: 'Palermo, CABA (Escuela Martin Buber)' },
  { value: 'parque avellaneda', label: 'Parque Avellaneda' },
  { value: 'presidente derqui', label: 'Presidente Derqui' },
  { value: 'quilmes', label: 'Quilmes' },
  { value: 'quilmes, buenos aires', label: 'Quilmes, Buenos Aires' },
  { value: 'recoleta', label: 'Recoleta' },
  { value: 'san cristóbal', label: 'San Cristóbal' },
  { value: 'san fernando', label: 'San Fernando' },
  { value: 'san isidro', label: 'San Isidro' },
  { value: 'san miguel', label: 'San Miguel' },
  { value: 'san nicolás', label: 'San Nicolás' },
  { value: 'sarandí', label: 'Sarandí' },
  { value: 'tandil', label: 'Tandil' },
  { value: 'temperley', label: 'Temperley' },
  { value: 'tortuguitas', label: 'Tortuguitas' },
  { value: 'tribunales, caba', label: 'Tribunales, CABA' },
  { value: 'turdera, provincia de buenos aires', label: 'Turdera, Provincia de Buenos Aires' },
  { value: 'versalles', label: 'Versalles' },
  { value: 'villa celina, la matanza', label: 'Villa Celina, La Matanza' },
  { value: 'villa crespo', label: 'Villa Crespo' },
  { value: 'villa real', label: 'Villa Real' },
  { value: 'villa urquiza', label: 'Villa Urquiza' },
];

/**
 * ⚠️ `getPathologyOptions()` foi REMOVIDA em 25/08/2026, e o que ela era importa mais que o
 * fato de ter saído.
 *
 * Eram **10 opções chumbadas** que não vinham de catálogo nenhum: eram valores de
 * `patients.diagnosis` **copiados literalmente** da base — com vírgula, minúscula e ponto
 * final ("autismo, retraso madurativo leve.", "trastorno disociativo, tlp, tca, estrés
 * postraumático."). Tinham de ser literais porque o filtro casava por `includes()` sobre o
 * texto armazenado.
 *
 * ⇒ Era uma TERCEIRA cópia de texto clínico, esta versionada no repositório git. Não
 * identificava ninguém sozinha, mas expunha o vocabulário clínico real da base.
 *
 * O filtro não foi substituído, e a decisão é deliberada: a tela **já** tem
 * `getWorkerTypeOptions()` (tipo de prestador). Trocar patologia por serviço/profissão criaria
 * um filtro quase idêntico ao que já existe, não devolveria capacidade nenhuma ao candidato.
 * Sobram busca livre, tipo, província, localidade e sexo.
 */

export const getSexOptions = (t: TFunction): SelectOption[] => [
  { value: 'femenino', label: t('jobs.sex.female') },
  { value: 'hombre', label: t('jobs.sex.male') },
  { value: 'indistinto', label: t('jobs.sex.indifferent') },
  { value: 'mujer', label: t('jobs.sex.woman') },
];

export const MOCK_JOBS: Job[] = [
  {
    code: '736',
    title: '736 - Acompañante Terapéutico - Provincia de Buenos Aires - Lanús Este',
    workerType: 'acompañante terapéutico',
    provincia: 'provincia de buenos aires',
    localidad: 'lanús este',
    barrio: '',
    workerSex: 'indistinto',
    description: 'prestación de servicios para acompañamiento terapéutico domiciliario en lanús. paciente joven con trastorno disociativo de la personalidad y tlp. se requiere experiencia previa y manejo de herramientas clínicas para el abordaje de trauma y tca.',
    service: 'domiciliario',
    daysAndHours: 'Lunes a viernes de 09:00 a 15:00 hs.',
    ageRange: '25 a 40 años',
    profile: 'AT con experiencia en casos complejos de salud mental y trastornos de personalidad.',
    whatsappLink: 'https://wa.me/5491127227852?text=Hola!%20Estoy%20interesado%20en%20la%20posición%20de%20CASO%20736',
    detailLink: 'https://jobs.enlite.health/es/vagas/736/',
  },
  {
    code: '732',
    title: '732 - Acompañante Terapéutico - Provincia de Buenos Aires - Nordelta (Tigre) y Puerto Madero (CABA)',
    workerType: 'acompañante terapéutico',
    provincia: 'provincia de buenos aires',
    localidad: 'nordelta (tigre) y puerto madero (caba)',
    barrio: '',
    workerSex: 'mujer',
    description: 'prestación de servicio de at para acompañar a una joven de 19 años durante sus traslados educativos. el objetivo es brindar soporte frente a su discapacidad intelectual leve y trastorno del lenguaje, promoviendo su seguridad y autonomía en la vía pública.',
    service: 'traslado',
    daysAndHours: 'Lunes y jueves de 11:00 a 14:00. (A partir de mayo se suma el viernes).',
    ageRange: '20 a 45 años (Sugerido)',
    profile: 'Profesional mujer con formación en AT y experiencia en discapacidad intelectual y comunicación.',
    whatsappLink: 'https://wa.me/5491127227852?text=Hola!%20Estoy%20interesado%20en%20la%20posición%20de%20CASO%20732',
    detailLink: 'https://jobs.enlite.health/es/vagas/732/',
  },
  {
    code: '735',
    title: '735 - Acompañante Terapéutico - Provincia de Buenos Aires - Lomas de Zamora',
    workerType: 'acompañante terapéutico',
    provincia: 'provincia de buenos aires',
    localidad: 'lomas de zamora',
    barrio: '',
    workerSex: 'indistinto',
    description: 'prestación de servicios de at para acompañamiento escolar de un niño con trastorno del lenguaje. el objetivo es brindar soporte pedagógico-vincular en lomas de zamora, integrándose a un equipo con supervisión clínica.',
    service: 'escolar',
    daysAndHours: 'Lunes, miércoles y viernes 8-12h; martes y jueves 10-14h.',
    ageRange: 'Adulto',
    profile: 'Profesional con experiencia en discapacidad infantil y entorno educativo.',
    whatsappLink: 'https://wa.me/5491127227852?text=Hola!%20Estoy%20interesado%20en%20la%20posición%20de%20CASO%20735',
    detailLink: 'https://jobs.enlite.health/es/vagas/735/',
  },
  {
    code: '734',
    title: '734 - Acompañante Terapéutico - CABA - Balvanera',
    workerType: 'acompañante terapéutico',
    provincia: 'caba',
    localidad: 'balvanera',
    barrio: '',
    workerSex: 'hombre',
    description: 'prestación de servicios para at masculino en domicilio. paciente adolescente con diagnóstico de tea. el foco está en el soporte post-internación y cumplimiento de objetivos terapéuticos.',
    service: 'domiciliario',
    daysAndHours: 'Lunes a sábados de 08:30 a 11:30.',
    ageRange: 'Adolescente (15 años)',
    profile: 'Profesional independiente masculino con experiencia en adolescentes.',
    whatsappLink: 'https://wa.me/5491127227852?text=Hola!%20Estoy%20interesado%20en%20la%20posición%20de%20CASO%20734',
    detailLink: 'https://jobs.enlite.health/es/vagas/734/',
  },
  {
    code: '733',
    title: '733 - Acompañante Terapéutico - Provincia de Buenos Aires - Quilmes',
    workerType: 'acompañante terapéutico',
    provincia: 'provincia de buenos aires',
    localidad: 'quilmes',
    barrio: '',
    workerSex: 'mujer',
    description: 'prestación de servicios para acompañamiento escolar de niña de 5 años con ansiedad por separación. se busca perfil con experiencia en integración escolar y manejo de vínculos en infancia.',
    service: 'escolar',
    daysAndHours: 'Lunes a viernes de 13:00 a 17:00.',
    ageRange: '20 a 30 años',
    profile: 'AT mujer con formación en discapacidad o integración escolar.',
    whatsappLink: 'https://wa.me/5491127227852?text=Hola!%20Estoy%20interesado%20en%20la%20posición%20de%20CASO%20733',
    detailLink: 'https://jobs.enlite.health/es/vagas/733/',
  },
];

export const USE_MOCK = false;

export interface JobsResponse {
  success: boolean;
  data: Job[];
  count: number;
  cached?: boolean;
}

/**
 * Rótulo do botão "Postularse" no card da vaga (Fase 4, DD5 · consome
 * F1/F2/F3). Usa `buildPendingRows` — a MESMA função que `PendingTasksCard`
 * usa pra montar a lista de tarefas da home — pra nunca contar duas vezes
 * (correção b do orquestrador, 11/09): o botão dizia "Completá N pasos"
 * com um N PRÓPRIO, que podia divergir do "Te faltan M pasos" da lista
 * logo acima, a MESMA classe de bug que os gates das fases 2/3 encontraram
 * dentro do próprio `PendingTasksCard` (entre o título e o "X de Y").
 *
 * `missingFields === null` (não apurado, D302/camada 0 — o GET ainda não
 * voltou, ou o backend não devolveu) → rótulo ORIGINAL "Postularse": não
 * dá pra nomear o que a tela não sabe. O clique já abre o aviso "No
 * pudimos verificar" (camada 0, `JobsEmbeddedSection`) — nada muda aqui.
 * `missingFields: []` (completo, conhecido) → 0 linhas → também
 * "Postularse" original.
 */
export function buildApplyLabel(
  missingFields: string[] | null,
  profession: string | null | undefined,
  t: TFunction,
): string {
  if (missingFields == null) return t('jobs.apply');

  const rows = buildPendingRows(missingFields, profession);
  if (rows.length === 0) return t('jobs.apply');

  if (rows.length === 1) {
    const [row] = rows;
    if (row.kind === 'registration') {
      return t('jobs.applyLabel.registration', { item: t(`profile.tabs.${row.tab}`) });
    }
    const doc = row.kind === 'document-generic'
      ? t('profile.tabs.documents')
      : t(`publicVacancy.incompleteModal.fields.${row.token}`, { defaultValue: row.token });
    return t('jobs.applyLabel.document', { doc });
  }

  return t('jobs.applyLabel.multiple', { count: rows.length });
}
