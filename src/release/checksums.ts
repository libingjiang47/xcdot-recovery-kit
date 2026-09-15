import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { sha256Hex } from '../snapshot/digest.js';
import { compareCanonicalStrings } from '../utils/order.js';

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path).split('\\').join('/'));
    }
  }
  await visit(root);
  return files.sort(compareCanonicalStrings);
}

export async function writeReleaseSums(projectRoot: string, dataDirectory: string): Promise<void> {
  const files = await listFiles(dataDirectory);
  const lines = [] as string[];
  for (const file of files)
    lines.push(`${sha256Hex(await readFile(join(dataDirectory, file)))}  data/${file}`);
  await writeFile(join(resolve(projectRoot), 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
}
