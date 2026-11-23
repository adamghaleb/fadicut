// JSON clipboard: survives reloads and works across tool instances. type tags what was copied.
export const copyObjects = (type, data) => navigator.clipboard?.writeText(JSON.stringify({ fadikit: type, data })).catch(() => {});
export async function pasteObjects(type) { try { const o = JSON.parse(await navigator.clipboard.readText()); return o && o.fadikit === type ? o.data : null; } catch { return null; } }
