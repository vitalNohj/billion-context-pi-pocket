import { join } from "node:path";
import { githubOutput, isNewer, json, release, reviewedFork, root } from "./upstream.mjs";

const upstream = await json(join(root, "upstream.json"));
const fork = reviewedFork(upstream);
const latest = (await release()).version;
// A higher npm version might not include the patch. Resume automatic refresh after a reviewed return to npm.
const current = upstream.version;
const needsUpdate = !fork && isNewer(latest, current);
console.log(fork ? `Keeping reviewed speed fix ${fork.version} (npm latest: ${latest})`
    : needsUpdate ? `billion-context-pi ${current} -> ${latest}` : `Already current: ${current} (npm latest: ${latest})`);
await githubOutput({ version: latest, needs_update: String(needsUpdate) });
