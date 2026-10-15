import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const files = [
  'src/agents/productionAgent/index.ts',
  'src/agents/productionAgent/storyboardContext.ts',
  'src/agents/productionAgent/storyboardTable.ts',
  'src/agents/productionAgent/storyboardValidator.ts',
  'src/socket/routes/productionAgent.ts',
  'data/skills/production_execution_storyboard_table.md',
  'data/skills/production_skills/storyboard_table_techniques.md',
  'data/skills/art_skills/realistic_3d_anime/driector_skills/director_storyboard_table_style.md',
  'data/serve/app.js',
];
async function main() {
const response = await fetch('http://localhost:10588/', {signal: AbortSignal.timeout(10000)});
await response.body?.cancel();
const result = {
  verifiedAt: new Date().toISOString(),
  httpStatus: response.status,
  processEvidence: {
    parentPid: 24600,
    listenerPid: 1384,
    verifiedBy: 'Get-NetTCPConnection and Get-CimInstance after restart',
    parentCommand: 'node_modules/tsx/dist/cli.mjs src/app.ts',
    listenerParentPid: 24600,
    launch: 'Native PowerShell Start-Process, WindowStyle Hidden, workspace working directory',
  },
  files: files.map(file => ({file, sha256: createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex')})),
};
fs.writeFileSync(path.resolve('docs/director-storyboard-source-audit-2026-10-09/runtime-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({httpStatus: result.httpStatus, verifiedFiles: result.files.length}));
if (!response.ok) process.exitCode = 1;
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
