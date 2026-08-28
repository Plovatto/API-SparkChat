import type { JsonFileStore } from './json-file-store.js';

export abstract class JsonRepository<T extends { id: string }> {
  constructor(protected readonly store: JsonFileStore<T>) {}

  findAll(): Promise<T[]> {
    return this.store.read();
  }

  async findById(id: string): Promise<T | null> {
    const items = await this.store.read();
    return items.find((item) => item.id === id) ?? null;
  }

  async insert(item: T): Promise<T> {
    const items = await this.store.read();
    items.push(item);
    await this.store.write(items);
    return item;
  }

  async update(id: string, patch: Partial<T>): Promise<T | null> {
    const items = await this.store.read();
    const index = items.findIndex((item) => item.id === id);
    const current = items[index];

    if (index === -1 || !current) {
      return null;
    }

    const updated: T = { ...current, ...patch };
    items[index] = updated;
    await this.store.write(items);
    return updated;
  }

  async replaceAll(items: T[]): Promise<void> {
    await this.store.write(items);
  }
}
