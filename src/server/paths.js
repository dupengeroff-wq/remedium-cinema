import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Root-relative paths remain independent of process.cwd().
export const projectDir = fileURLToPath(new URL('../../', import.meta.url));
export const publicDir = path.join(projectDir, 'public');
