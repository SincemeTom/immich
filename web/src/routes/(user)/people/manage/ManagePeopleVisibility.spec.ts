import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import { vi } from 'vitest';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { personFactory } from '@test-data/factories/person-factory';
import ManagePeoplePage from './+page.svelte';
import ManagePeoplePageTestWrapper from './ManagePeopleVisibility.test-wrapper.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: {} } as never,
  };
});

vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => {
  return await import('@test-data/mocks/UserPageLayout.mock.svelte');
});

const getData = (
  people: ReturnType<typeof personFactory.build>[],
  hasNextPage = false,
): ComponentProps<typeof ManagePeoplePage>['data'] => ({
  error: undefined,
  meta: { title: 'Manage people visibility' },
  asset: undefined,
  people: {
    people,
    total: people.length,
    hidden: people.filter((person) => person.isHidden).length,
    hasNextPage,
  },
});

describe('People manage page', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });

  it('keeps toggled hidden state when loading more people', async () => {
    const [personA, personB, personC] = [
      personFactory.build({ id: 'a', isHidden: false }),
      personFactory.build({ id: 'b', isHidden: false }),
      personFactory.build({ id: 'c', isHidden: true }),
    ];

    const { container, rerender } = render(ManagePeoplePageTestWrapper, { data: getData([personA, personB], true) });
    const user = userEvent.setup();

    let personButtons = container.querySelectorAll('button[aria-pressed]');
    expect(personButtons).toHaveLength(2);

    await user.click(personButtons[0]);
    expect(personButtons[0].getAttribute('aria-pressed')).toBe('true');

    await rerender({ data: getData([personA, personB, personC], false) });

    personButtons = container.querySelectorAll('button[aria-pressed]');
    expect(personButtons).toHaveLength(3);
    expect(personButtons[0].getAttribute('aria-pressed')).toBe('true');
    expect(personButtons[2].getAttribute('aria-pressed')).toBe('true');
  });

  it('shows newly loaded hidden people as hidden', async () => {
    const [personA, personB, personC] = [
      personFactory.build({ id: 'a', isHidden: false }),
      personFactory.build({ id: 'b', isHidden: false }),
      personFactory.build({ id: 'c', isHidden: true }),
    ];

    const { container, rerender } = render(ManagePeoplePageTestWrapper, { data: getData([personA, personB], true) });

    await rerender({ data: getData([personA, personB, personC], false) });

    const personButtons = container.querySelectorAll('button[aria-pressed]');
    expect(personButtons).toHaveLength(3);
    expect(personButtons[2].getAttribute('aria-pressed')).toBe('true');
  });

  it('hides all the unnamed, not only those loaded so far', async () => {
    const named = personFactory.build({ id: 'a', name: 'Alice', isHidden: false });
    const unnamed = personFactory.build({ id: 'b', name: '', isHidden: false });
    const further = personFactory.build({ id: 'c', name: '', isHidden: false });
    sdkMock.getAllPeople.mockResolvedValue({ people: [further], total: 3, hidden: 0, hasNextPage: false });
    sdkMock.updatePeople.mockResolvedValue([
      { id: 'b', success: true },
      { id: 'c', success: true },
    ]);

    const { getByLabelText, getByText } = render(ManagePeoplePageTestWrapper, {
      data: getData([named, unnamed], true),
    });
    const user = userEvent.setup();

    await user.click(getByLabelText('hide_unnamed_people'));
    expect(sdkMock.getAllPeople).toHaveBeenCalledWith({ withHidden: true, page: 2 });

    await user.click(getByText('done'));
    expect(sdkMock.updatePeople).toHaveBeenCalledWith({
      peopleUpdateDto: {
        people: [
          { id: 'b', isHidden: true },
          { id: 'c', isHidden: true },
        ],
      },
    });
  });
});
