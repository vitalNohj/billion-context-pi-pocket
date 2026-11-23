/** Synthetic transcript with the frozen message objects Pi Durable reuses across requests. */
export function freezeJson(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) freezeJson(child);
        Object.freeze(value);
    }
    return value;
}

export function longContext() {
    const paragraph = 'The output includes several lines of diagnostics, a result, and a description of the check.\n';
    const text = (text) => ({ type: 'text', text });
    const messages = Array.from({ length: 400 }, (_, i) => {
        const time = 1_750_000_000_000 + i * 10;
        const ref = `m${String(i + 10).padStart(5, '0')}`;
        const tag = `<acp example="true">${ref}</acp>`;
        const body = `Report ${i}\n${paragraph.repeat(48)}`;
        const toolName = i % 2 ? 'artifact_inline' : 'artifact';
        return [
            { role: 'user', content: '[m00001]\nRetry the check.', timestamp: time },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'Inspect the output.' }, text(`${tag}\n${body}`)], timestamp: time + 1 },
            { role: 'user', content: [text('Retry the check.'), text(`[${ref}]`)], timestamp: time + 2 },
            { role: 'assistant', content: [text(`Reading report ${i}`), { type: 'toolCall', id: `read-${i}`, name: 'read', arguments: { path: `report-${i}.log`, offset: 0 } }], timestamp: time + 3 },
            { role: 'toolResult', toolName: 'read', toolCallId: `read-${i}`, content: [text(`${body}\n[${ref}]`)], details: { info: { lines: [48, 49], category: 'report' } }, timestamp: time + 4, isError: false },
            { role: 'assistant', content: [text('Rendering the report.'), { type: 'toolCall', id: `report-${i}`, name: toolName, arguments: { title: `Report ${i}`, content: body, ...(toolName === 'artifact' ? { inline: true } : {}) } }], timestamp: time + 5 },
            { role: 'toolResult', toolName, toolCallId: `report-${i}`, content: [text(`Saved report ${i}`)], details: { artifact: { version: 1, id: `report-${i}` } }, timestamp: time + 6 },
            { role: 'user', content: [text(`${tag}\nWhat did the report show?`)], timestamp: time + 7 },
            { role: 'assistant', content: [text(body), text(tag)], timestamp: time + 8 },
            { role: 'user', content: `Continue after report ${i}.`, timestamp: time + 9 },
        ];
    }).flat();
    return freezeJson(messages);
}
