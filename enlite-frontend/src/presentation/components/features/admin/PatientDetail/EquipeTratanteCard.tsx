import { useTranslation } from 'react-i18next';
import { Plus, Search } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientProfessionalDetail } from '@domain/entities/PatientDetail';

interface EquipeTratanteCardProps {
  professionals: PatientProfessionalDetail[];
}

export function EquipeTratanteCard({ professionals }: EquipeTratanteCardProps) {
  const { t } = useTranslation();
  const safeProfessionals = professionals ?? [];

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="equipe-tratante-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.treatingTeamCard.title')}
        </Heading>
        <Button variant="outline" size="sm" disabled className="flex items-center gap-1">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.new')}
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
        <input
          type="text"
          readOnly
          placeholder={t('admin.patients.detail.searchPlaceholder')}
          className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg font-lexend text-sm text-gray-700 bg-gray-50 cursor-default outline-none"
        />
      </div>

      {/* lex C2.1: nome de profissional é texto — o Clarity (Balanced) não o mascara sozinho. */}
      <div data-clarity-mask="True">
      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.treatingTeamCard.tableFullName')}</TableHead>
          <TableHead>{t('admin.patients.detail.treatingTeamCard.tablePhoneNumber')}</TableHead>
          <TableHead>{t('admin.patients.detail.treatingTeamCard.tableProfile')}</TableHead>
        </TableHeader>
        <TableBody>
          {safeProfessionals.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={3} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            safeProfessionals.map((prof) => (
              <TableRow key={prof.id}>
                <TableCell>{prof.name ?? '—'}</TableCell>
                <TableCell>{prof.phone ?? '—'}</TableCell>
                {/* lex C2.2: não há coluna de especialidade — Perfil é o is_team da tabela, nunca derivado. */}
                <TableCell>{t(`admin.patients.detail.treatingTeamCard.${prof.isTeam ? 'isTeam' : 'professional'}`)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
