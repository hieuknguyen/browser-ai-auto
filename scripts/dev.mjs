import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const python = resolve(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
if (!existsSync(python)) {
  console.error('Thiếu môi trường Python. Chạy: uv sync --python 3.12');
  process.exit(1);
}
const backendOnly = process.argv.includes('--backend');
const children = [spawn(python, ['-m', 'backend'], { stdio: 'inherit', windowsHide: false })];
if (!backendOnly) children.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', windowsHide: false }));
let closing = false;
const stop = code => {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = typeof code === 'number' ? code : 0;
};
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
