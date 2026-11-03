import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export function executableFiles(files) {
    if (!files.has('package.json')) throw new Error('Archive package.json missing');
    return Object.fromEntries([...files.keys()]
        .filter((path) => path === 'package.json' || /\.(?:js|mjs|cjs)$/.test(path))
        .sort()
        .map((path) => [path, createHash('sha256').update(files.get(path)).digest('hex')]));
}

export function assertCompatibleContract(previous, next) {
    if (previous?.format !== 1 || previous.package !== 'billion-context-pi' || !Array.isArray(previous.tools)) {
        throw new Error('Invalid reviewed tool contract');
    }
    if (previous.tools.length !== next.tools.length || previous.tools.some((tool, i) =>
        tool.name !== next.tools[i].name || !isDeepStrictEqual(tool.parameters, next.tools[i].parameters))) {
        throw new Error('Tool names or parameter schemas changed; review required');
    }
}
