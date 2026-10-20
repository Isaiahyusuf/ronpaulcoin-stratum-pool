const fs = require('node:fs');
const path = require('node:path');

const MAIN = 'accepted';
const SIDE = 'side chain';
const UNRESOLVED = 'unresolved';

/*
Append-only JSONL record of every block the pool solved. A "submitting" line is written before submitblock,
so a crash mid-submission leaves a trace with the full block hex. After the first outcome the journal keeps
re-checking each block with getblock until it is buried deeply enough or its window ends, and records every
change of state (notably accepted -> not on the main chain after a reorg). "Block not found" never proves
invalidity, so a missing block is reported as unresolved, never as rejected.
*/
function classify(results, hash) {
    const counts = { main: 0, side: 0, absent: 0, silent: 0, total: results.length };
    let confirmations = 0;
    for (const result of results) {
        const block = result.response;
        if (block && block.hash === hash && typeof block.confirmations === 'number') {
            if (block.confirmations > 0) {
                counts.main++;
                confirmations = Math.max(confirmations, block.confirmations);
            } else counts.side++;
        } else if (result.error && result.error.code === -5) counts.absent++;
        else counts.silent++;
    }
    let status = null;
    if (counts.main > 0) status = MAIN;
    else if (counts.side > 0) status = SIDE;
    else if (counts.absent > 0) status = UNRESOLVED;
    return { status, confirmations, counts };
}

function createBlockJournal({ file, daemonCmd, log, confirmDepth = 100, intervalMs = 60000, maxAgeMs = 48 * 3600 * 1000, now = Date.now }) {
    const tracked = new Map();
    let timer = null;
    let running = false;
    let stopped = false;

    const append = (entry) => {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, JSON.stringify({ time: new Date(now()).toISOString(), ...entry }) + '\n', { mode: 0o600 });
            return true;
        } catch (error) {
            log('error', `Block journal write failed (${error.code || error.message}); block ${entry.hash} is NOT recorded on disk`);
            return false;
        }
    };

    const load = () => {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return;
            log('error', `Block journal unreadable (${error.code || error.message}); previous blocks are not being re-checked`);
            return;
        }
        const latest = new Map();
        let bad = 0;
        for (const line of text.split('\n')) {
            if (!line) continue;
            try {
                const entry = JSON.parse(line);
                if (typeof entry.hash !== 'string' || typeof entry.status !== 'string') throw new Error('shape');
                const previous = latest.get(entry.hash);
                latest.set(entry.hash, { ...entry, hex: entry.hex || (previous && previous.hex), firstSeen: previous ? previous.firstSeen : Date.parse(entry.time) });
            } catch (error) {
                bad++;
            }
        }
        if (bad > 0) log('warning', `Block journal has ${bad} unreadable line(s), which were skipped`);
        for (const [hash, entry] of latest) if (!entry.final) tracked.set(hash, entry);
        const pending = [...tracked.values()].filter((entry) => entry.status !== MAIN);
        if (pending.length > 0) {
            log('warning', `Block journal: ${pending.length} block(s) were not confirmed on the main chain before the last shutdown: ` +
                pending.map((entry) => `${entry.hash} (${entry.status})`).join(', '));
        }
    };

    const record = (entry) => {
        const previous = tracked.get(entry.hash);
        const hex = entry.hex || (previous && previous.hex);
        const line = {
            hash: entry.hash,
            height: entry.height,
            worker: String(entry.worker).slice(0, 128),
            status: entry.status,
            ...(entry.reason ? { reason: entry.reason } : {}),
            ...(entry.status === MAIN ? {} : { hex })
        };
        append(line);
        tracked.set(entry.hash, { ...line, hex, live: entry.status === 'submitting', firstSeen: previous ? previous.firstSeen : now() });
    };

    const describe = (status) => (status === MAIN ? 'on the main chain' : status === SIDE ? 'on a side chain' : 'not in the block index');

    async function checkOne(entry) {
        if (entry.live) return;
        const results = await new Promise((resolve) => daemonCmd('getblock', [entry.hash], resolve));
        if (stopped || tracked.get(entry.hash) !== entry) return;
        const { status, confirmations, counts } = classify(results, entry.hash);

        if (status && status !== entry.status) {
            const reason = status === UNRESOLVED
                ? `not in the block index on ${counts.absent} of ${counts.total} daemon(s) when re-checked; this does not prove the block is invalid`
                : undefined;
            record({ ...entry, status, reason });
            if (entry.status === MAIN) {
                log('error', `REORG: block ${entry.hash} (height ${entry.height}) is no longer on the main chain; it is now ${describe(status)}. ` +
                    'Any reward for it will not be paid out by the network.');
            } else if (status === MAIN) {
                log('warning', `Block ${entry.hash} (height ${entry.height}) is now on the main chain after being ${entry.status}`);
            } else {
                log('error', `Block ${entry.hash} (height ${entry.height}) changed from ${entry.status} to ${status}` +
                    (status === UNRESOLVED ? `; to recover, run getblock on each daemon and, if every one answers "Block not found" and its parent is still the chain tip, submitblock ${entry.hex}` : ''));
            }
            return;
        }

        if (entry.status === MAIN && status === MAIN && confirmations >= confirmDepth) {
            append({ hash: entry.hash, height: entry.height, worker: entry.worker, status: MAIN, final: true, confirmations });
            tracked.delete(entry.hash);
            return;
        }

        if (now() - entry.firstSeen > maxAgeMs) {
            append({ hash: entry.hash, height: entry.height, worker: entry.worker, status: entry.status, final: true, reason: 'recheck window ended', ...(entry.hex && entry.status !== MAIN ? { hex: entry.hex } : {}) });
            tracked.delete(entry.hash);
            if (entry.status !== MAIN) {
                log('error', `Block ${entry.hash} (height ${entry.height}) was still ${entry.status} when re-checking stopped. ` +
                    `It is kept in ${file}; resolve it by hand with getblock on each daemon.`);
            }
        }
    }

    async function recheck() {
        if (running || stopped) return;
        running = true;
        try {
            for (const entry of [...tracked.values()]) {
                if (stopped) break;
                try {
                    await checkOne(entry);
                } catch (error) {
                    log('error', `Block journal re-check failed for ${entry.hash}: ${error.message}`);
                }
            }
        } finally {
            running = false;
        }
    }

    return {
        record,
        recheck,
        tracked: () => [...tracked.values()],
        start() {
            load();
            recheck();
            timer = setInterval(recheck, intervalMs);
            timer.unref();
        },
        stop() {
            stopped = true;
            clearInterval(timer);
        }
    };
}

module.exports = { createBlockJournal, classify };
