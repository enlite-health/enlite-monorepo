/**
 * useActiveCases Hook
 * Extracts and processes active cases from ClickUp data
 */

import { useMemo } from 'react';
import type { ClickUpRow, ActiveCase } from '@domain/entities/RecruitmentData';
import { getMatchingKey, extractNumbers, parseDate } from '@presentation/utils/recruitmentHelpers';
import { formatWallDate } from '@presentation/utils/dateTimeFormat';

export function useActiveCases(clickUpData: ClickUpRow[]): ActiveCase[] {
  return useMemo(() => {
    if (clickUpData.length === 0) return [];

    const statusCol = getMatchingKey(clickUpData, ['estado', 'status']);
    const casoNumCol = getMatchingKey(clickUpData, [
      'caso número (number)',
      'caso numero (number)',
      'caso numero',
      'caso número',
      'id',
    ]);
    const nameCol = getMatchingKey(clickUpData, ['task name', 'nombre', 'name', 'titulo']);
    const dateCreatedCol = getMatchingKey(clickUpData, [
      'date created',
      'fecha de creación',
      'fecha de creacion',
      'fecha creacion',
    ]);

    if (!statusCol || !casoNumCol) return [];

    const activeCases: ActiveCase[] = [];

    clickUpData.forEach((row) => {
      const status = String(row[statusCol] || '').toUpperCase().trim();
      
      if (status === 'BUSQUEDA' || status === 'BÚSQUEDA' || status === 'REEMPLAZO' || status === 'REEMPLAZOS') {
        const casoNumStr = String(row[casoNumCol] || '').trim();
        const parsed = parseFloat(casoNumStr);
        const id = !isNaN(parsed) ? Math.floor(parsed).toString() : extractNumbers(casoNumStr)[0];

        if (!id) return;

        const name = nameCol ? String(row[nameCol] || '').trim() : `Caso ${id}`;
        const dateStr = dateCreatedCol ? String(row[dateCreatedCol] || '').trim() : '';
        const dateObj = parseDate(dateStr);
        // `parseDate` monta a Date com o relógio LOCAL (planilha sem fuso): SÓ-DATA, sem conversão.
        const inicioBusqueda = formatWallDate(dateObj, {}, 'es-ES') ?? (dateStr || '-');

        const normalizedStatus = (status === 'BUSQUEDA' || status === 'BÚSQUEDA')
          ? 'BUSQUEDA'
          : status === 'REEMPLAZOS'
          ? 'REEMPLAZOS'
          : 'REEMPLAZO';

        activeCases.push({
          id,
          name,
          status: normalizedStatus as 'BUSQUEDA' | 'REEMPLAZOS' | 'REEMPLAZO',
          inicioBusqueda,
          inicioBusquedaObj: dateObj,
        });
      }
    });

    return activeCases;
  }, [clickUpData]);
}
