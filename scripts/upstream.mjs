import { readFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const repository = "ranxianglei/billion-context-pi";
export const json = async (path) => JSON.parse(await readFile(path, "utf8"));

export function stableVersion(value) {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
        throw new Error(`Expected a stable x.y.z version, got ${JSON.stringify(value)}`);
    }
    return value;
}

export function isNewer(candidate, current) {
    const a = stableVersion(candidate).split(".").map((part) => BigInt(part));
    const b = stableVersion(current).split(".").map((part) => BigInt(part));
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

export async function fetchJSON(url) {
    const response = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_048_576) throw new Error(`${url}: metadata exceeds 1 MiB`);
    return JSON.parse(text);
}

export async function release(version = "latest") {
    if (version !== "latest") stableVersion(version);
    const metadata = await fetchJSON(`https://registry.npmjs.org/billion-context-pi/${version}`);
    stableVersion(metadata.version);
    if (metadata.name !== "billion-context-pi" || (version !== "latest" && metadata.version !== version)) {
        throw new Error("Unexpected npm package or version");
    }
    if (!/^[a-f0-9]{40}$/.test(metadata.gitHead ?? "")) throw new Error("npm release has no full gitHead");
    if (metadata.license !== "MIT") throw new Error(`Review changed upstream license: ${metadata.license}`);
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist?.integrity ?? "")) {
        throw new Error("npm release has no SHA-512 integrity");
    }
    return metadata;
}

export function npm(args) {
    // Node's npm-cli path also works on Windows, where npm.cmd needs a shell.
    const cli = process.env.npm_execpath;
    const result = cli
        ? spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" })
        : spawnSync("npm", args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.status ?? result.signal})`);
}

export async function githubOutput(values) {
    if (!process.env.GITHUB_OUTPUT) return;
    // Values are validated versions or booleans, never arbitrary registry text.
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}
