import { useTranslation } from 'react-i18next';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Text } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { areaPersonKey, type AreaPerson } from '@domain/entities/AreaMembership';
import { AreaMembershipChip } from './AreaMembershipChip';
import { AreaPersonKindBadge } from './AreaPersonKindBadge';

/** Larguras do desenho: com a coluna de ação (escrita) e sem ela (só leitura). `null` = o resto. */
const COLS_WRITE = ['w-[146px]', 'w-[252px]', 'w-[104px]', null, 'w-[112px]'];
const COLS_READ = ['w-[170px]', 'w-[260px]', 'w-[108px]', null];
/** Cabeçalho em #374151 (o do atom é #737373, 4,7:1) — só nesta aba. */
const HEAD = 'text-[#374151]';
const CELL_TEXT = 'block [overflow-wrap:anywhere]';

interface AreaPeopleTableProps {
  people: AreaPerson[];
  /** `area_membership:write` — sem ela a coluna de ação NÃO existe (nem o cabeçalho). */
  canWrite: boolean;
  onManage: (person: AreaPerson) => void;
}

/** A tabela de pessoas: nome, e-mail, tipo, chips dos vínculos vivos e (com escrita) "Gestionar". */
export function AreaPeopleTable({ people, canWrite, onManage }: AreaPeopleTableProps): JSX.Element {
  const { t } = useTranslation();
  const K = 'admin.access.areaMemberships';
  const cols = canWrite ? COLS_WRITE : COLS_READ;
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400" data-testid="people-card">
      <Table className="table-fixed" data-testid="area-people-table">
        <colgroup>{cols.map((c, i) => <col key={i} className={c ?? ''} />)}</colgroup>
        <TableHeader>
          <TableHead className={HEAD}>{t(`${K}.columns.name`)}</TableHead>
          <TableHead className={HEAD}>{t(`${K}.columns.email`)}</TableHead>
          <TableHead className={HEAD}>{t(`${K}.columns.kind`)}</TableHead>
          <TableHead className={HEAD}>{t(`${K}.columns.memberships`)}</TableHead>
          {canWrite && <TableHead unwrapped align="right" className={HEAD}><span className="sr-only">{t(`${K}.columns.actions`)}</span></TableHead>}
        </TableHeader>
        <TableBody>
          {people.map((p) => (
            <TableRow key={areaPersonKey(p)} data-testid="area-person-row">
              <TableCell unwrapped>
                <Text as="span" size="sm" weight="medium" color="primary" className={CELL_TEXT} title={p.displayName}>{p.displayName}</Text>
              </TableCell>
              <TableCell unwrapped>
                <Text as="span" size="sm" color="tertiary" className={CELL_TEXT} title={p.email ?? undefined}>{p.email ?? '—'}</Text>
              </TableCell>
              <TableCell unwrapped><AreaPersonKindBadge kind={p.kind} /></TableCell>
              <TableCell unwrapped>
                {p.memberships.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {p.memberships.map((m) => <AreaMembershipChip key={m.id} membership={m} />)}
                  </div>
                ) : (
                  <Text as="span" size="sm" color="tertiary">—</Text>
                )}
              </TableCell>
              {canWrite && (
                <TableCell unwrapped align="right">
                  <Button
                    type="button"
                    size="xs"
                    variant="quiet"
                    data-testid="area-person-manage"
                    aria-label={t(`${K}.manageAria`, { name: p.displayName })}
                    onClick={() => onManage(p)}
                  >
                    {t(`${K}.manage`)}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
