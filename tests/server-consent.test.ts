import { describe, expect, it, vi } from 'vitest';
import { noConsentMessage, serverConsented } from '@/shared/server-consent';

const url = 'https://tts.example.com/v1';

describe("asking again before text goes to the reader's own server", () => {
  it('Firefox: the host and the website-content consent, both', async () => {
    const contains = vi.fn(async (p: { origins?: string[]; data_collection?: string[] }) => !!p.data_collection?.includes('websiteContent'));
    expect(await serverConsented(url, { contains }, true)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://tts.example.com/*'], data_collection: ['websiteContent'] });
  });

  it('Firefox: consent taken back in the add-on settings is a no', async () => {
    expect(await serverConsented(url, { contains: async () => false }, true)).toBe(false);
  });

  it('a Firefox without data-collection permissions asks for the host alone, as Connect did', async () => {
    const contains = vi.fn(async (p: { origins?: string[]; data_collection?: string[] }) => {
      if (p.data_collection) throw new TypeError('Unexpected property "data_collection"');
      return true;
    });
    expect(await serverConsented(url, { contains }, true)).toBe(true);
  });

  it('Chrome: the host permission (never data_collection, which it does not know)', async () => {
    const contains = vi.fn(async (p: { origins?: string[]; data_collection?: string[] }) => !p.data_collection);
    expect(await serverConsented(url, { contains }, false)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://tts.example.com/*'] });
  });

  it('a backup restored on a device that never connected: no permission, nothing sent', async () => {
    expect(await serverConsented(url, { contains: async () => false }, false)).toBe(false);
    expect(await serverConsented(url, undefined, false)).toBe(false);
    expect(await serverConsented('', { contains: async () => true }, false)).toBe(false);
    expect(noConsentMessage(url)).toMatch(/Connect the server again/);
  });
});
