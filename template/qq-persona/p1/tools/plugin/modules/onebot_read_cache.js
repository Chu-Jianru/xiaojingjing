/** Short-lived public reads only. No conversation, private data or write caching. */
export class ReadCache {
    constructor({ now = Date.now, max = 32 } = {}) { this.now = now; this.max = max; this.entries = new Map(); }
    async get(key, load, ttl, fresh = false) {
        if (fresh) return await load();
        const old = this.entries.get(key);
        if (old && (old.pending || old.until > this.now())) return await old.value;
        if (old) this.entries.delete(key);
        // Bound both pending and completed keys. If all slots are busy, skip caching.
        for (const [id, row] of this.entries) {
            if (this.entries.size < this.max) break;
            if (!row.pending) this.entries.delete(id);
        }
        if (this.entries.size >= this.max) return await load();
        const row = { pending: true, until: 0, value: Promise.resolve().then(load) };
        this.entries.set(key, row);
        try {
            const value = await row.value;
            row.pending = false; row.until = this.now() + ttl;
            return value;
        }
        catch (error) { if (this.entries.get(key) === row) this.entries.delete(key); throw error; }
    }
}

export function cachedWebTool(tool) {
    const cache = new ReadCache();
    return { ...tool, parameters: { ...tool.parameters, properties: { ...tool.parameters?.properties,
        fresh: { type: 'boolean', description: '明确要求重新查/最新结果时设true，绕过短缓存；默认搜索60秒、网页30秒、天气5秒。' } } },
        execute: async (args, exec) => {
            const search = tool.name === 'web_search';
            const input = String(search ? args?.query ?? '' : args?.url ?? '').trim();
            const count = search ? Math.min(8, Math.max(1, Math.floor(Number.isFinite(args?.count) ? args.count : 5))) : 0;
            const key = JSON.stringify([input, count]);
            const weather = !search && /^https?:\/\/(?:www\.)?wttr\.in(?:[/:]|$)/i.test(input);
            return cache.get(key, () => tool.execute(args, exec), search ? 60_000 : weather ? 5_000 : 30_000, args?.fresh === true);
        } };
}
