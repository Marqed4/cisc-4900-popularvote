// Starts the Flask backend and the Vite frontend together for local dev.
// Used by the root `npm run dev`. Ctrl+C stops both.
//
// Python is picked in this order: $PYTHON, a repo .venv, then every `python`/`python3`
// on PATH. The first one that can import the backend's packages wins, so a stray
// Python without Flask (e.g. MSYS) earlier on PATH doesn't break startup.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

function pythonCandidates() {
  const found = [];
  if (process.env.PYTHON) found.push(process.env.PYTHON);
  found.push(resolve(ROOT, '.venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python'));
  for (const name of ['python', 'python3']) {
    const lookup = spawnSync(IS_WIN ? 'where' : 'which', IS_WIN ? [name] : ['-a', name], { encoding: 'utf8' });
    found.push(...(lookup.stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  }
  return [...new Set(found)].filter(p => existsSync(p));
}

function findPython() {
  for (const py of pythonCandidates()) {
    const check = spawnSync(py, ['-c', 'import flask, flask_socketio, dotenv, supabase'], { stdio: 'ignore' });
    if (check.status === 0) return py;
  }
  return null;
}

const python = findPython();
if (!python) {
  console.error('[dev] No Python with the backend packages found.');
  console.error('[dev] Run: pip install -r src/backend/requirements.txt  (or set PYTHON=<path to python>)');
  process.exit(1);
}

const children = [];

function run(label, command, args) {
  const child = spawn(command, args, { cwd: ROOT, shell: false, env: process.env });
  const prefix = line => `[${label}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) console.log(prefix(line));
    });
  }
  child.on('exit', code => {
    console.log(prefix(`exited with code ${code}`));
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    // Windows: kill the whole tree, otherwise npm leaves Vite running.
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`[dev] backend python: ${python}`);
run('backend', python, ['-u', '-m', 'src.backend.app']);
run('frontend', IS_WIN ? 'cmd.exe' : 'npm', IS_WIN ? ['/c', 'npm', 'run', 'dev', '--prefix', 'src/frontend'] : ['run', 'dev', '--prefix', 'src/frontend']);
