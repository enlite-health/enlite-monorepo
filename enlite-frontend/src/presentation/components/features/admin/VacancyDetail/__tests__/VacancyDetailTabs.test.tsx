import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyDetailTabs } from '../VacancyDetailTabs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const onTabChange = vi.fn();

function renderTabs(activeTab: 'encuadres' | 'talentum' | 'links' | 'notes' = 'encuadres') {
  return render(<VacancyDetailTabs activeTab={activeTab} onTabChange={onTabChange} />);
}

function getTabButton(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

beforeEach(() => {
  onTabChange.mockClear();
});

describe('VacancyDetailTabs — rendering', () => {
  it('renders exactly 4 tab buttons', () => {
    renderTabs();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
  });

  it('renders Encuadres tab with i18n key', () => {
    renderTabs();
    expect(screen.getByText('admin.vacancyDetail.tabs.encuadres')).toBeInTheDocument();
  });

  it('renders Talentum tab with i18n key', () => {
    renderTabs();
    expect(screen.getByText('admin.vacancyDetail.tabs.talentum')).toBeInTheDocument();
  });

  it('renders Links tab with i18n key', () => {
    renderTabs();
    expect(screen.getByText('admin.vacancyDetail.tabs.links')).toBeInTheDocument();
  });

  it('renders Notes tab with i18n key', () => {
    renderTabs();
    expect(screen.getByText('admin.vacancyDetail.tabs.notes')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-tab-notes')).toBeInTheDocument();
  });
});

describe('VacancyDetailTabs — active tab styling', () => {
  it('active tab has bg-primary class', () => {
    renderTabs('encuadres');
    const activeButton = getTabButton('admin.vacancyDetail.tabs.encuadres');
    expect(activeButton.className).toContain('bg-primary');
    expect(activeButton.className).toContain('text-white');
  });

  it('inactive tabs do NOT have bg-primary class', () => {
    renderTabs('encuadres');
    const talentumButton = getTabButton('admin.vacancyDetail.tabs.talentum');
    const linksButton = getTabButton('admin.vacancyDetail.tabs.links');
    expect(talentumButton.className).not.toContain('bg-primary');
    expect(linksButton.className).not.toContain('bg-primary');
  });

  it('talentum tab is active when activeTab is talentum', () => {
    renderTabs('talentum');
    const talentumButton = getTabButton('admin.vacancyDetail.tabs.talentum');
    expect(talentumButton.className).toContain('bg-primary');

    const encuadresButton = getTabButton('admin.vacancyDetail.tabs.encuadres');
    expect(encuadresButton.className).not.toContain('bg-primary');
  });

  it('links tab is active when activeTab is links', () => {
    renderTabs('links');
    const linksButton = getTabButton('admin.vacancyDetail.tabs.links');
    expect(linksButton.className).toContain('bg-primary');
  });

  it('active tab has shadow class', () => {
    renderTabs('encuadres');
    const activeButton = getTabButton('admin.vacancyDetail.tabs.encuadres');
    expect(activeButton.className).toContain('shadow-');
  });
});

describe('VacancyDetailTabs — interaction', () => {
  it('clicking Talentum tab calls onTabChange with "talentum"', async () => {
    renderTabs('encuadres');
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.talentum'));
    expect(onTabChange).toHaveBeenCalledWith('talentum');
  });

  it('clicking Links tab calls onTabChange with "links"', async () => {
    renderTabs('encuadres');
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.links'));
    expect(onTabChange).toHaveBeenCalledWith('links');
  });

  it('clicking Encuadres tab calls onTabChange with "encuadres"', async () => {
    renderTabs('talentum');
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.encuadres'));
    expect(onTabChange).toHaveBeenCalledWith('encuadres');
  });
});

describe('VacancyDetailTabs — accessibility', () => {
  it('all tabs are <button> elements', () => {
    renderTabs();
    const buttons = screen.getAllByRole('button');
    buttons.forEach((btn) => {
      expect(btn.tagName).toBe('BUTTON');
    });
  });
});
