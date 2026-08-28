import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonFileStore<T> {
  constructor(private readonly filePath: string) {}

  async ensureFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, '[]', 'utf-8');
    }
  }

  async read(): Promise<T[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');

      if (!raw.trim()) {
        await fs.writeFile(this.filePath, '[]', 'utf-8');
        return [];
      }

      return JSON.parse(raw) as T[];
    } catch {
      await this.ensureFile();
      return [];
    }
  }

  async write(data: T[]): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
