import { useTranslation } from 'react-i18next';
import { Eye, CalendarDays } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { resolveDateLocale, SHORT_DATE_OPTIONS } from '@presentation/utils/dateLocale';
import { toDisplayName } from '@domain/value-objects/displayName';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';

export interface PatientRow {
  id: string;
  firstName: string;
  lastName: string;
  /** Nome do responsável primário — mostrado sob o traço enquanto o paciente
   *  não tem nome próprio (D249). `null` quando não há responsável. */
  responsibleName?: string | null;
  documentType: string | null;
  documentNumber: string | null;
  caseNumber: number | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  serviceType: string[];
  needsAttention: boolean;
  attentionReasons: string[];
  createdAt: string | null;
}

interface PatientsTableProps {
  patients: PatientRow[];
  onRowClick?: (id: string) => void;
}

function StatusBadge({ needsAttention, reasons }: { needsAttention: boolean; reasons: string[] }) {
  const { t } = useTranslation();

  if (!needsAttention) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-green-100 text-green-700"
        title={t('admin.patients.statusBadge.complete')}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        <Text as="span" size="xs" weight="medium" color="inherit">
          {t('admin.patients.statusBadge.complete')}
        </Text>
      </span>
    );
  }

  const reasonLabels = reasons
    .map((r) => t(`admin.patients.reasonOptions.${r}`, r))
    .join(', ');

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-700 cursor-help"
      title={reasonLabels || t('admin.patients.statusBadge.needsAttention')}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      <Text as="span" size="xs" weight="medium" color="inherit">
        {t('admin.patients.statusBadge.needsAttention')}
      </Text>
    </span>
  );
}

/**
 * `||` e não `??`: o `??` só desvia de `null`/`undefined`, então com
 * `documentNumber: ''` a função devolvia STRING VAZIA e engolia o tipo — o
 * documento sumia da célula. O ramo `?? '—'` também era inalcançável (a 1ª
 * guarda já cobria os dois vazios) e era o único branch descoberto do arquivo.
 */
function formatDocument(type: string | null, number: string | null): string {
  if (type && number) return `${type} ${number}`;
  return number || type || '—';
}

/**
 * Servicio traz o ENUM canônico (AT, CAREGIVER, ...). A tela mostra o alias.
 * Reusa o mesmo dicionário do card "Servicios Contratados" do detalhe — uma
 * fonte só de alias por enum. Fallback: o próprio enum, se o alias não existir.
 */
function formatServiceType(t: ReturnType<typeof useTranslation>['t'], types: string[]): string {
  if (!types || types.length === 0) return '—';
  return types
    .map((svc) => t(`admin.patients.detail.contractedServicesCard.serviceTypes.${svc}`, svc))
    .join(' + ');
}

/**
 * Data do registro: dd/mm/aaaa no locale ativo.
 *
 * O mapa de locale vem do util compartilhado (`resolveDateLocale`); o
 * FALLBACK é local de propósito: aqui a data mora como linha extra da célula
 * do nome, então ausência vira `null` (linha some) e não `'—'` (traço solto).
 */
function formatRegisteredAt(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(resolveDateLocale(locale), SHORT_DATE_OPTIONS);
}

function formatDependency(t: ReturnType<typeof useTranslation>['t'], level: string | null): string {
  if (!level) return '—';
  return t(`admin.patients.dependencyOptions.${level}`, level);
}

function formatSpecialty(t: ReturnType<typeof useTranslation>['t'], specialty: string | null): string {
  if (!specialty) return '—';
  return t(`admin.patients.specialtyOptions.${specialty}`, specialty);
}

export function PatientsTable({ patients, onRowClick }: PatientsTableProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const safePatients = patients ?? [];

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-400">
      <Table className="min-w-[600px]">
        <TableHeader>
          <TableHead className="w-10" />
          <TableHead className="whitespace-nowrap">{t('admin.patients.table.name')}</TableHead>
          <TableHead className="whitespace-nowrap">{t('admin.patients.table.document')}</TableHead>
          <TableHead className="whitespace-nowrap">{t('admin.patients.table.code')}</TableHead>
          <TableHead className="whitespace-nowrap hidden md:table-cell">
            {t('admin.patients.table.dependency')}
          </TableHead>
          <TableHead className="whitespace-nowrap hidden xl:table-cell">
            {t('admin.patients.table.specialty')}
          </TableHead>
          <TableHead className="whitespace-nowrap hidden md:table-cell">
            {t('admin.patients.table.service')}
          </TableHead>
          <TableHead className="whitespace-nowrap">{t('admin.patients.table.status')}</TableHead>
        </TableHeader>
        <TableBody>
          {safePatients.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={8} className="h-[200px] bg-white text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.noPatients')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            safePatients.map((row) => {
              // O formato "Sobrenome, Nome" é o da tabela e fica como está.
              const fullName = [row.lastName, row.firstName]
                .filter(Boolean)
                .map((n) => toDisplayName(n))
                .join(', ');
              // D249: sem nome do paciente, o traço fica no lugar dele e quem
              // identifica a ficha é o responsável, na linha de baixo.
              const responsibleName = toDisplayName(row.responsibleName) || null;
              const registeredAt = formatRegisteredAt(row.createdAt, i18n.language);
              const serviceLabel = formatServiceType(t, row.serviceType);
              const specialtyLabel = formatSpecialty(t, row.clinicalSpecialty);
              const formattedCaseNumber = formatCaseNumber(row.caseNumber);
              const caseLabel = formattedCaseNumber != null
                ? `${t('admin.patients.codeColumn')} #${formattedCaseNumber}`
                : '—';
              return (
                <TableRow
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.id) : undefined}
                  className="bg-white h-[72px]"
                >
                  <TableCell unwrapped className="w-10">
                    <Eye className="w-5 h-5 text-gray-800" aria-label={t('admin.patients.table.view')} />
                  </TableCell>
                  <TableCell unwrapped className="max-w-[185px]">
                    <div className="flex flex-col">
                      {/* `truncate` e não `nowrap`: nome longo ("Rodríguez de la
                          Fuente, María Guadalupe") com nowrap alarga a tabela e
                          joga a coluna Estado para fora da tela — o mesmo defeito
                          que o `line-clamp` resolve no Servicio. Nome inteiro no
                          title. O átomo `Text` não repassa props extras — testid
                          e title vivem no span, como no PatientKanbanCard. */}
                      <span
                        className="block truncate"
                        data-testid={`patient-row-${row.id}-name`}
                        title={fullName || undefined}
                      >
                        <Text as="span" size="sm" weight="medium" color="inherit">
                          {fullName || '—'}
                        </Text>
                      </span>
                      {!fullName && responsibleName && (
                        <span className="block truncate" data-testid={`patient-row-${row.id}-responsible`}>
                          <Text as="span" size="xs" color="secondary">
                            {t('admin.patients.kanban.responsible')}: {responsibleName}
                          </Text>
                        </span>
                      )}
                      {registeredAt && (
                        <span
                          className="inline-flex items-center gap-1 text-gray-700"
                          title={`${t('admin.patients.table.registeredAt')}: ${registeredAt}`}
                          aria-label={`${t('admin.patients.table.registeredAt')}: ${registeredAt}`}
                        >
                          <CalendarDays className="w-3 h-3 shrink-0" aria-hidden="true" />
                          <Text as="span" size="xs" color="muted">
                            {registeredAt}
                          </Text>
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell weight="medium" className="whitespace-nowrap">
                    {formatDocument(row.documentType, row.documentNumber)}
                  </TableCell>
                  <TableCell weight="medium" className="whitespace-nowrap">
                    {caseLabel}
                  </TableCell>
                  <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                    {formatDependency(t, row.dependencyLevel)}
                  </TableCell>
                  <TableCell unwrapped className="hidden xl:table-cell max-w-[130px]">
                    {/* Era a coluna mais larga da tabela (198px, a única que ainda
                        tinha `nowrap`) e sozinha respondia pelos 47px que faziam
                        a linha do Estado ser cortada em 1280. Mesmo tratamento do
                        Servicio e do Nombre: 2 linhas no máximo, inteiro no title. */}
                    <Text as="span" size="sm" weight="medium" color="inherit" className="line-clamp-2" title={specialtyLabel}>
                      {specialtyLabel}
                    </Text>
                  </TableCell>
                  <TableCell unwrapped className="hidden md:table-cell max-w-[180px]">
                    {/* Alias é longo ("Acompañante Terapéutico + Cuidador"): com
                        nowrap ele empurrava a coluna Estado para fora da tela, e
                        solto ele esticava a linha. 2 linhas no máximo, o resto no
                        title — a linha continua com 72px. */}
                    <Text as="span" size="sm" weight="medium" color="inherit" className="line-clamp-2" title={serviceLabel}>
                      {serviceLabel}
                    </Text>
                  </TableCell>
                  <TableCell unwrapped className="whitespace-nowrap">
                    <StatusBadge
                      needsAttention={row.needsAttention}
                      reasons={row.attentionReasons}
                    />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
