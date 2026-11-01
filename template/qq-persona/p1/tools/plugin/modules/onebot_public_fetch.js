/** Public-page/image requests cannot reach the local management network. */
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let root = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(root, 'bot-home')) && dirname(root) !== root) root = dirname(root);
const require = createRequire(join(root, 'bot-home/web-runtime/package.json'));
const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(address,prefix,'ipv4');
const fakeIP = new BlockList(); fakeIP.addSubnet('198.18.0.0',15,'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::',3,'ipv6');
for (const [address,prefix] of [['2001:db8::',32],['2001::',32],['2002::',16]]) denied.addSubnet(address,prefix,'ipv6');
export function publicAddress(address) {
    const family = isIP(address);
    return family === 4 ? !denied.check(address,'ipv4')
        : family === 6 && global6.check(address,'ipv6') && !denied.check(address,'ipv6');
}
export function publicUrl(input) {
    const url = new URL(input);
    const host = url.hostname.replace(/^\[|\]$/g,'');
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password
        || host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !publicAddress(host))) throw new Error('public_url_required');
    return url;
}
const dnsCache = new Map(), dnsPending = new Map();
export async function resolvePublicHost(host) {
    const old = dnsCache.get(host);
    if (old?.until > Date.now()) return old.rows;
    if (dnsPending.has(host)) return await dnsPending.get(host);
    const work = (async () => {
        let last;
        for (const resolver of ['1.1.1.1','1.0.0.1']) {
            try {
                // Fixed public-IP bootstrap avoids a second synthetic DNS lookup.
                // Only the public hostname is sent; no URL path, query or chat text.
                const r = await fetch('https://' + resolver + '/dns-query?name=' + encodeURIComponent(host) + '&type=A',
                    {headers:{accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(3000)});
                if (!r.ok) throw new Error('public_dns_http');
                const data = await r.json();
                const records = (data.Answer ?? []).filter(row => row.type === 1);
                const rows = records.map(row => ({address:row.data,family:4}));
                if (data.Status !== 0 || !rows.length || rows.some(row => !publicAddress(row.address))) throw new Error('private_network_blocked');
                const ttl = Math.max(0,Math.min(60,...records.map(row => Number(row.TTL) || 0)))*1000;
                if (dnsCache.size >= 64) dnsCache.delete(dnsCache.keys().next().value);
                dnsCache.set(host,{rows,until:Date.now()+ttl});
                return rows;
            } catch(error) { last=error; }
        }
        throw last;
    })();
    // Avoid retaining an unbounded number of concurrent hostname keys.
    if (dnsPending.size >= 64) return await work;
    dnsPending.set(host,work);
    try { return await work; } finally { if (dnsPending.get(host)===work) dnsPending.delete(host); }
}
export async function publicLookup(host, options, callback, resolve = lookup, resolveFake = resolvePublicHost) {
    try {
        let rows = await resolve(host,{all:true,verbatim:true});
        // TUN clients synthesize 198.18/15 addresses for public hostnames. Resolve
        // those through DoH, then connect to the validated public answer instead
        // of either allowing private addresses or disabling the URL guard.
        if (rows.length && rows.every(row => row.family===4 && fakeIP.check(row.address,'ipv4'))) rows = await resolveFake(host);
        if (!rows.length || rows.some(row => !publicAddress(row.address))) throw new Error('private_network_blocked');
        if (options?.all) callback(null,rows);
        else callback(null,rows[0].address,rows[0].family);
    } catch(error) { callback(error); }
}
let dispatcher;
export async function publicFetch(input, options = {}) {
    dispatcher ??= new (require('undici').Agent)({connect:{lookup:publicLookup},connections:2,keepAliveTimeout:5000,keepAliveMaxTimeout:10000});
    let url = publicUrl(input);
    const signal = options.signal ?? AbortSignal.timeout(12_000);
    for (let i=0;i<=3;i++) {
        // Validation happens in the connector lookup itself, preventing a second
        // unchecked DNS resolution between validation and the actual connection.
        const response = await fetch(url.href,{...options,signal,dispatcher,redirect:'manual'});
        if (![301,302,303,307,308].includes(response.status)) return response;
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || i===3) throw new Error('web_redirect_limit');
        url = publicUrl(new URL(location,url));
    }
}
