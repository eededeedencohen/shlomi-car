/**
 * bundleClient.js - builds the React client and copies the bundle into Server/public,
 * so `npm start` serves the app and the API from one process.
 *   npm run bundle
 */
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '../..');
const clientDir = path.resolve(serverDir, '../Client');
const dist = path.join(clientDir, 'dist');
const publicDir = path.join(serverDir, 'public');

if (!fs.existsSync(path.join(clientDir, 'package.json'))) {
  console.error(`Client folder not found at ${clientDir}`);
  process.exit(1);
}

console.log(`Building client in ${clientDir} ...`);
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = spawnSync(npmCmd, ['run', 'build'], { cwd: clientDir, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) {
  console.error('Client build failed');
  process.exit(build.status || 1);
}

fs.rmSync(publicDir, { recursive: true, force: true });
fs.cpSync(dist, publicDir, { recursive: true });
console.log(`Copied ${dist} -> ${publicDir}`);
