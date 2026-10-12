import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { rubenPath } from './paths.js';

/** One JSON file under the RUBEN home, read with a fallback and written whole. */
export function jsonFile<T>(name: string, fallback: T) {
  const path = () => rubenPath(name);
  return {
    read(): T {
      if (!existsSync(path())) return structuredClone(fallback);
      try {
        return { ...structuredClone(fallback), ...JSON.parse(readFileSync(path(), 'utf8')) };
      } catch {
        return structuredClone(fallback);
      }
    },
    write(value: T): void {
      mkdirSync(dirname(path()), { recursive: true });
      writeFileSync(path(), JSON.stringify(value, null, 2), 'utf8');
    },
  };
}
