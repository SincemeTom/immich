import { fireEvent, render } from '@testing-library/svelte';
import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';

vi.mock('$lib/utils/sw-messaging', () => ({
  cancelImageUrl: vi.fn(),
}));

describe('ImageThumbnail component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an img element with correct attributes', () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    const img = baseElement.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('/test-thumbnail.jpg');
    expect(img!.getAttribute('alt')).toBe('');
  });

  it('shows BrokenAsset on error', async () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    const img = baseElement.querySelector('img')!;
    await fireEvent.error(img);

    expect(baseElement.querySelector('img')).toBeNull();
    expect(baseElement.querySelector('span')?.textContent).toEqual('error_loading_image');
  });

  it('calls onComplete with false on successful load', async () => {
    const onComplete = vi.fn();
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      onComplete,
    });
    const img = baseElement.querySelector('img')!;
    await fireEvent.load(img);
    expect(onComplete).toHaveBeenCalledWith(false);
  });

  it('calls onComplete with true on error', async () => {
    const onComplete = vi.fn();
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      onComplete,
    });
    const img = baseElement.querySelector('img')!;
    await fireEvent.error(img);
    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it('applies hidden classes when hidden is true', () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
      hidden: true,
    });
    const img = baseElement.querySelector('img')!;
    const className = img.getAttribute('class') ?? '';
    expect(className).toContain('grayscale');
    expect(className).toContain('opacity');
  });

  it('sets alt text after loading', async () => {
    const { baseElement } = render(ImageThumbnail, {
      url: '/test-thumbnail.jpg',
      altText: 'Test image',
      widthStyle: '200px',
    });
    const img = baseElement.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('');

    await fireEvent.load(img);
    expect(img.getAttribute('alt')).toBe('Test image');
  });

  it('loads a new url, as a person thumbnail after a new featured photo', async () => {
    const props = { url: '/people/1/thumbnail?updatedAt=1', altText: 'Test image', widthStyle: '200px' };
    const { baseElement, rerender } = render(ImageThumbnail, props);
    await fireEvent.load(baseElement.querySelector('img')!);

    await rerender({ ...props, url: '/people/1/thumbnail?updatedAt=2' });

    const img = baseElement.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/people/1/thumbnail?updatedAt=2');
    expect(img.getAttribute('alt')).toBe('');
    await fireEvent.load(img);
    expect(img.getAttribute('alt')).toBe('Test image');
  });

  it('shows a new url that loads after one that failed', async () => {
    const props = { url: '/a.jpg', altText: 'Test image', widthStyle: '200px' };
    const { baseElement, rerender } = render(ImageThumbnail, props);
    await fireEvent.error(baseElement.querySelector('img')!);
    expect(baseElement.querySelector('img')).toBeNull();

    await rerender({ ...props, url: '/b.jpg' });

    expect(baseElement.querySelector('img')?.getAttribute('src')).toBe('/b.jpg');
  });
});
