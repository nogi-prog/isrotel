#!/usr/bin/env node
/**
 * מריץ במקביל את השרת (API) ואת ה־Vite dev server.
 * שימוש: npm run dev
 */
import { spawn } from 'node:child_process';

// On Windows, npm is a .cmd shim; spawn() can't run .cmd/.bat files directly
// (plain 'npm' ENOENTs, 'npm.cmd' without a shell EINVALs), so route through
// cmd.exe explicitly there — this avoids the unescaped-args shell:true warning
// since the argv passed to cmd.exe is fully static.
const isWindows = process.platform === 'win32';
const spawnNpm = (args, options) =>
  isWindows
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { ...options, windowsVerbatimArgs: true })
    : spawn('npm', args, options);

const targets = [
  { name: 'server', color: '[36m', args: ['run', 'dev', '--workspace=server'] },
  { name: 'web   ', color: '[35m', args: ['run', 'dev', '--workspace=web'] },
];

const RESET = '[0m';
const children = [];
let shuttingDown = false;

for (const target of targets) {
  const child = spawnNpm(target.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);

  const prefix = `${target.color}[${target.name}]${RESET} `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
    stream.on('end', () => {
      if (buffer) out.write(prefix + buffer + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`${prefix}exited with code ${code}`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
