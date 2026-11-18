import { describe, expect, it } from 'vitest';
import { scanHeadTags } from '@/modules/link-preview/link-preview.html.js';

describe('scanHeadTags', () => {
  it('collects the first value of each meta key and the title', () => {
    const { meta, title } = scanHeadTags(
      '<head><meta property="og:title" content="First"><meta property="og:title" content="Second"><title>Page</title></head>',
    );

    expect(meta.get('og:title')).toBe('First');
    expect(title).toBe('Page');
  });

  it('keeps a > inside a quoted attribute value', () => {
    const { meta } = scanHeadTags('<head><meta name="description" content="a > b"></head>');

    expect(meta.get('description')).toBe('a > b');
  });

  it('skips comments and script contents', () => {
    const { meta } = scanHeadTags(
      '<head><!-- <meta property="og:title" content="Comment"> --><script>var x = "<meta property=og:title content=Script>";</script><meta property="og:title" content="Real"></head>',
    );

    expect(meta.get('og:title')).toBe('Real');
  });

  it('stays linear on adversarial input far larger than the read limit', () => {
    const inputs = [
      '<meta name="og:title" '.repeat(100_000),
      `<meta content="${'x'.repeat(2_000_000)}`,
      '<title>' + '<'.repeat(1_000_000),
      '<meta a=b '.repeat(200_000) + '>',
    ];

    for (const input of inputs) {
      const startedAt = performance.now();
      scanHeadTags(input);
      expect(performance.now() - startedAt).toBeLessThan(1000);
    }
  });
});
