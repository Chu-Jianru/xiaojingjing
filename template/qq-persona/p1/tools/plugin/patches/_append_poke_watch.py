from pathlib import Path
REPO = next(p for p in Path(__file__).resolve().parents if (p / "bot-home").is_dir() and (p / "qq-persona").is_dir())

p = REPO / "bot-home/profiles/companion/node_modules/dsh-onebot-qq/lib/bridge.js"
t = p.read_text(encoding="utf-8")
marker = "function startPokeWatch"
if marker in t:
    print("already appended")
else:
    t += '''
// -- [dsh-p1] poke watch --------------------------------------------------------
// NapCat does not emit the OneBot poke notice on this setup, but it does receive
// the gray tip (busiId 1061). patch_napcat_poke_dump.py writes the resolved
// poker/target QQ numbers to poke-raw.jsonl; here we turn new lines into the
// same poke turn the notice handler would have produced.
const POKE_WATCH_MS = 5_000;
const pokeWatchState = new WeakMap();
const pokeWatchTimers = new WeakMap();

function pokeWatchPath(bridge) {
    return (bridge?.deps?.config?.mediaDir ?? '') + '/poke-raw.jsonl';
}

async function pokeWatchTick(bridge) {
    const st = pokeWatchState.get(bridge);
    if (st === undefined || st.offset < 0)
        return;
    let buf;
    try { buf = await readFile(pokeWatchPath(bridge)); }
    catch { return; }
    if (buf.length < st.offset)
        st.offset = 0;
    if (buf.length === st.offset)
        return;
    const chunk = buf.subarray(st.offset).toString('utf8');
    const nl = chunk.lastIndexOf('\\n');
    if (nl === -1)
        return;
    const complete = chunk.slice(0, nl + 1);
    st.offset += Buffer.byteLength(complete, 'utf8');
    const selfId = String(bridge?.deps?.connection?.selfId ?? '');
    if (selfId === '')
        return;
    for (const line of complete.split('\\n')) {
        if (line.trim() === '')
            continue;
        let entry;
        try { entry = JSON.parse(line); }
        catch { continue; }
        if (String(entry?.targetUin ?? '') !== selfId)
            continue;
        const userUin = String(entry?.userUin ?? '');
        if (userUin === '')
            continue;
        const chatType = Number(entry?.chatType);
        const groupId = chatType === 2 ? String(entry?.peerUid ?? '') : '';
        const evt = {
            post_type: 'notice',
            notice_type: 'notify',
            sub_type: 'poke',
            user_id: userUin,
            target_id: selfId,
            sender: { user_id: userUin, nickname: '' },
        };
        if (groupId !== '')
            evt.group_id = groupId;
        bridge.deps.log('info', 'poke gray-tip: ' + (groupId === '' ? 'private' : 'group:' + groupId) + ' from ' + userUin);
        await handlePokeNotice(bridge, evt);
    }
}

function startPokeWatch(bridge) {
    if (pokeWatchState.has(bridge))
        return;
    const st = { offset: -1 };
    pokeWatchState.set(bridge, st);
    const timer = setInterval(() => void pokeWatchTick(bridge).catch(() => undefined), POKE_WATCH_MS);
    timer.unref?.();
    pokeWatchTimers.set(bridge, timer);
    void (async () => {
        try { st.offset = (await readFile(pokeWatchPath(bridge))).length; }
        catch { st.offset = 0; }
    })();
}

function stopPokeWatch(bridge) {
    const timer = pokeWatchTimers.get(bridge);
    if (timer !== undefined) {
        clearInterval(timer);
        pokeWatchTimers.delete(bridge);
    }
    pokeWatchState.delete(bridge);
}
'''
    p.write_text(t, encoding="utf-8")
    print("appended poke watch")
