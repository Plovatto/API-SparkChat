import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    env: {
      LOG_LEVEL: 'silent',
      RECOVERY_FILE_SECRET: '0000000000000000000000000000000000000000000000000000000000000000',
      GEMINI_API_KEY: 'test',
      AI_ASSISTANT_PRIVATE_KEY: 'test',
      R2_ACCOUNT_ID: 'test',
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      R2_BUCKET_NAME: 'test',
      R2_PUBLIC_BASE_URL: 'https://fake-object-storage.test',
    },
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
