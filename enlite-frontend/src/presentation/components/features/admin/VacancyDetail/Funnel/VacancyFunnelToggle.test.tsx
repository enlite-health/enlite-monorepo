import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFunnelToggle } from './VacancyFunnelToggle';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('VacancyFunnelToggle', () => {
  it('renders Lista and Kanban buttons', () => {
    render(
      <VacancyFunnelToggle
        view="list"
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText('admin.vacancyDetail.funnelView.viewToggle.list'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.funnelView.viewToggle.kanban'),
    ).toBeInTheDocument();
  });

  it('Lista button is active when view=list', () => {
    render(<VacancyFunnelToggle view="list" onChange={vi.fn()} />);
    const listBtn = screen
      .getByText('admin.vacancyDetail.funnelView.viewToggle.list')
      .closest('button');
    expect(listBtn).toHaveClass('bg-primary');
  });

  it('Kanban button is active when view=kanban', () => {
    render(<VacancyFunnelToggle view="kanban" onChange={vi.fn()} />);
    const kanbanBtn = screen
      .getByText('admin.vacancyDetail.funnelView.viewToggle.kanban')
      .closest('button');
    expect(kanbanBtn).toHaveClass('bg-primary');
  });

  it('calls onChange with "kanban" when Kanban button is clicked', async () => {
    const onChange = vi.fn();
    render(<VacancyFunnelToggle view="list" onChange={onChange} />);
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.funnelView.viewToggle.kanban'),
    );
    expect(onChange).toHaveBeenCalledWith('kanban');
  });

  it('calls onChange with "list" when Lista button is clicked', async () => {
    const onChange = vi.fn();
    render(<VacancyFunnelToggle view="kanban" onChange={onChange} />);
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.funnelView.viewToggle.list'),
    );
    expect(onChange).toHaveBeenCalledWith('list');
  });

  it('has role=group on container', () => {
    render(<VacancyFunnelToggle view="list" onChange={vi.fn()} />);
    expect(screen.getByRole('group')).toBeInTheDocument();
  });
});
