import { FakeGifProvider } from './gifs.fake.js';
import { KlipyGifProvider } from './gifs.klipy.js';
import type { GifProvider } from './gifs.provider.js';

export interface GifProviderConfig {
  nodeEnv: 'development' | 'test' | 'production';
  provider: 'klipy' | 'fake';
  klipyApiKey?: string | undefined;
}

export function createGifProvider(config: GifProviderConfig): GifProvider | null {
  if (config.provider === 'fake') {
    if (config.nodeEnv === 'production') {
      throw new Error('GIF_PROVIDER=fake is not allowed in production');
    }
    return new FakeGifProvider();
  }

  return config.klipyApiKey ? new KlipyGifProvider(config.klipyApiKey) : null;
}
