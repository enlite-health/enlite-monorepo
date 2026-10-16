/**
 * Spec 046 F4 / A17 — o `<thead>` da lista de Pacientes (usa `atoms/Table` SEM props de ordenação)
 * tem de continuar byte a byte igual. Se o `TableHead` sem props mudar o render, este teste MORRE.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { PatientsTable } from '../PatientsTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'es' } }),
}));

describe('PatientsTable <thead> (A17)', () => {
  it('renderiza o thead igual ao de antes da F4', () => {
    const { container } = render(<PatientsTable patients={[]} />);
    expect(container.querySelector('thead')).toMatchInlineSnapshot(`
      <thead
        class=""
      >
        <tr
          class="bg-gray-300 text-gray-800"
        >
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg w-10"
          />
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap"
          >
            <span
              class="font-lexend text-sm leading-snug font-medium"
            >
              admin.patients.table.name
            </span>
          </th>
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap"
          >
            <span
              class="font-lexend text-sm leading-snug font-medium"
            >
              admin.patients.table.document
            </span>
          </th>
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap"
          >
            <span
              class="font-lexend text-sm leading-snug font-medium"
            >
              admin.patients.table.code
            </span>
          </th>
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap hidden md:table-cell"
          >
            <span
              class="font-lexend text-sm leading-snug font-medium"
            >
              admin.patients.table.dependency
            </span>
          </th>
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap hidden xl:table-cell"
          >
            <span
              class="font-lexend text-sm leading-snug font-medium"
            >
              admin.patients.table.specialty
            </span>
          </th>
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap hidden md:table-cell"
          >
            <span
              class="font-lexend text-sm leading-snug font-medium"
            >
              admin.patients.table.service
            </span>
          </th>
          <th
            class="text-left px-3 py-2 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap"
          >
            <span
              class="font-lexend text-sm leading-snug font-medium"
            >
              admin.patients.table.status
            </span>
          </th>
        </tr>
      </thead>
    `);
  });
});
