import { spawn } from 'node:child_process';
const children = ['@quiet/server', '@quiet/web'].map(workspace =>
  spawn('npm', ['run', 'dev', '-w', workspace], { stdio: 'inherit' }));
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', code => stop(code ?? 0));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
