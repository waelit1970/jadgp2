class SafeStorage {
  private inMemoryDb: Record<string, string> = {};

  constructor() {
    // Try to pre-populate in-memory from localStorage if accessible
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          this.inMemoryDb[key] = localStorage.getItem(key) || '';
        }
      }
    } catch (e) {
      console.warn('[SafeStorage] Warning: Real localStorage is not fully accessible due to iframe privacy partitioning.', e);
    }
  }

  getItem(key: string): string | null {
    try {
      const val = localStorage.getItem(key);
      if (val !== null) {
        this.inMemoryDb[key] = val;
      }
      return val;
    } catch (e) {
      return this.inMemoryDb[key] !== undefined ? this.inMemoryDb[key] : null;
    }
  }

  setItem(key: string, value: string): void {
    const cleanValue = String(value);
    this.inMemoryDb[key] = cleanValue;
    try {
      localStorage.setItem(key, cleanValue);
    } catch (e) {
      console.warn(`[SafeStorage] Could not write key "${key}" to real localStorage. Saved in-memory instead.`, e);
    }
  }

  removeItem(key: string): void {
    delete this.inMemoryDb[key];
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn(`[SafeStorage] Could not remove key "${key}" from real localStorage.`, e);
    }
  }

  clear(): void {
    this.inMemoryDb = {};
    try {
      localStorage.clear();
    } catch (e) {
      console.warn('[SafeStorage] Could not clear real localStorage.', e);
    }
  }
}

export const safeStorage = new SafeStorage();
