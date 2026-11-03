/** Executed only by an explicit owner installation, in a temporary home with no install scripts. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [directory, version] = process.argv.slice(2);
if (!directory || !version) throw new Error('Expected a verified package directory and version');
process.env.PI_ACP_FORK_HOST = '1';
process.env.ACP_AUTO_UPDATE = '0';
const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
if (metadata.name !== 'billion-context-pi' || metadata.version !== version) throw new Error('Runtime package identity changed');
const runtime = await import(pathToFileURL(join(directory, 'dist/index.js')).href);
if (typeof runtime.default !== 'function' || typeof runtime.deriveChildState !== 'function') {
    throw new Error('This billion-context-pi release does not expose the required integration API');
}
console.log('Verified billion-context-pi ' + version);
