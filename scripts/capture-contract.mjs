import { pathToFileURL } from 'node:url';
const tools = [];
const pi = {
    on() {}, registerCommand() {}, registerFlag() {}, registerShortcut() {},
    registerTool(tool) {
        const { name, description, parameters, annotations } = tool;
        tools.push({ name, description, parameters, ...(annotations === undefined ? {} : { annotations }) });
    },
};
const module = await import(pathToFileURL(process.argv[2]).href);
await module.default(pi);
process.stdout.write(JSON.stringify(tools));
