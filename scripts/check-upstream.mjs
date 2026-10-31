import { join } from "node:path";
import { githubOutput, isNewer, json, release, root } from "./upstream.mjs";

const current = (await json(join(root, "upstream.json"))).version;
const latest = (await release()).version;
const needsUpdate = isNewer(latest, current);
console.log(needsUpdate ? `billion-context-pi ${current} -> ${latest}` : `Already current: ${current} (npm latest: ${latest})`);
await githubOutput({ version: latest, needs_update: String(needsUpdate) });
