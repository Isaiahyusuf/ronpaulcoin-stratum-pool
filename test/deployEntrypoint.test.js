const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'docker', 'daemon', 'deploy-entrypoint.sh');

// Runs the real entrypoint with stub getent/stdbuf/ronpaulcoind. The stub daemon prints its arguments and the
// generated config file, which is what the daemon would read.
function run(env, { ahostsv4 = '', ahostsv6 = '' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-'));
    try {
        const write = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        write('getent', `case "$1" in ahostsv4) printf '%s' "$FAKE_V4";; ahostsv6) printf '%s' "$FAKE_V6";; esac; exit 0`);
        write('stdbuf', 'shift 2; exec "$@"');
        write('sleep', 'exit 0');
        write('ronpaulcoind', 'echo "ARGS: $*"; for a in "$@"; do case "$a" in -conf=*) cat "${a#-conf=}";; esac; done');
        const result = spawnSync('/bin/sh', [script, ...(env.EXTRA_ARGS || [])], {
            env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_V4: ahostsv4, FAKE_V6: ahostsv6, RPC_USER: 'rpcpool', RPC_PASSWORD: 'secretvalue', ...env },
            encoding: 'utf8'
        });
        const allowed = (result.stdout.match(/^rpcallowip=.*$/gm) || []).map((line) => line.slice('rpcallowip='.length));
        return { ...result, allowed };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const v4 = '10.0.0.5        STREAM stratum-pool.railway.internal\n10.0.0.5        DGRAM\n10.0.0.5        RAW\n';
const v6 = 'fd12:aaaa:bbbb:1::5 STREAM stratum-pool.railway.internal\nfd12:aaaa:bbbb:1::5 DGRAM\n';

test('RPC_ALLOW_HOST allows exactly the resolved IPv4 and IPv6 addresses', () => {
    const r = run({ RPC_ALLOW_HOST: 'stratum-pool.railway.internal' }, { ahostsv4: v4, ahostsv6: v6 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.allowed.sort(), ['10.0.0.5', 'fd12:aaaa:bbbb:1::5']);
    assert.ok(!r.stdout.includes('*'), 'no wildcard may be written');
    assert.match(r.stderr, /re-checked every 30s; a changed answer restarts the daemon cleanly/);
    assert.ok(!r.stderr.includes('secretvalue'));
});

test('IPv4-mapped IPv6 entries are dropped and duplicates collapsed', () => {
    const r = run({ RPC_ALLOW_HOST: 'stratum-pool.railway.internal' }, {
        ahostsv4: v4,
        ahostsv6: '::ffff:10.0.0.5 STREAM stratum-pool.railway.internal\n'
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.allowed, ['10.0.0.5']);
});

test('an IPv6-only environment is supported', () => {
    const r = run({ RPC_ALLOW_HOST: 'stratum-pool.railway.internal' }, { ahostsv6: v6 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.allowed, ['fd12:aaaa:bbbb:1::5']);
});

test('a host that does not resolve fails closed and never starts the daemon', () => {
    const r = run({ RPC_ALLOW_HOST: 'stratum-pool.railway.internal', RPC_ALLOW_HOST_WAIT_SECONDS: '0' });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /did not resolve/);
    assert.ok(!r.stdout.includes('ARGS:'));
});

test('resolver output that is not an address literal is ignored', () => {
    const r = run({ RPC_ALLOW_HOST: 'stratum-pool.railway.internal', RPC_ALLOW_HOST_WAIT_SECONDS: '0' }, { ahostsv4: '*.* STREAM x\n10.0.0.* STREAM y\n' });
    assert.equal(r.status, 3);
    assert.deepEqual(r.allowed, []);
});

test('with neither RPC_ALLOW_HOST nor RPC_ALLOW_IP the daemon is not started', () => {
    const r = run({});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /RPC stays closed/);
    assert.ok(!r.stdout.includes('ARGS:'));
});

test('both RPC_ALLOW_HOST and RPC_ALLOW_IP is rejected', () => {
    const r = run({ RPC_ALLOW_HOST: 'a.internal', RPC_ALLOW_IP: '10.0.0.5' }, { ahostsv4: v4 });
    assert.equal(r.status, 2);
});

test('RPC_ALLOW_IP accepts an exact address but not a leading wildcard', () => {
    const ok = run({ RPC_ALLOW_IP: '10.0.0.5' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.allowed, ['10.0.0.5']);
    for (const bad of ['*', '*.*', '*:*', '?.0.0.1']) {
        const r = run({ RPC_ALLOW_IP: bad });
        assert.equal(r.status, 2, `${bad} must be refused`);
        assert.ok(!r.stdout.includes('ARGS:'));
    }
});

test('invalid hostnames, characters, network and wait values are refused', () => {
    assert.equal(run({ RPC_ALLOW_HOST: 'bad host;rm' }, { ahostsv4: v4 }).status, 2);
    assert.equal(run({ RPC_ALLOW_HOST: 'a.internal', RPC_PASSWORD: 'bad pass' }, { ahostsv4: v4 }).status, 2);
    assert.equal(run({ RPC_ALLOW_HOST: 'a.internal', DAEMON_NETWORK: 'moon' }, { ahostsv4: v4 }).status, 2);
    assert.equal(run({ RPC_ALLOW_HOST: 'a.internal', RPC_ALLOW_HOST_WAIT_SECONDS: 'x' }, { ahostsv4: v4 }).status, 2);
    assert.equal(run({ RPC_ALLOW_HOST: 'a.internal', RPC_PASSWORD: '' }, { ahostsv4: v4 }).status, 1);
});

test('network flag, listen=0 and credentials reach the daemon without leaking to stderr', () => {
    const r = run({ RPC_ALLOW_HOST: 'a.internal', DAEMON_NETWORK: 'mainnet' }, { ahostsv4: v4 });
    assert.match(r.stdout, /ARGS: -conf=\S+ -datadir=\/data -printtoconsole\n/);
    assert.match(r.stdout, /^listen=0$/m);
    assert.match(r.stdout, /^rpcuser=rpcpool$/m);
    assert.ok(!r.stderr.includes('secretvalue'));
    assert.ok(!r.stdout.split('\n').some((l) => l.startsWith('ARGS:') && l.includes('secretvalue')));
});

// Long-running variant: a stub daemon that stays up until it receives SIGTERM, and a resolver whose answers
// the test changes while the entrypoint runs. Every resolver call is recorded so the test can wait for a
// specific number of re-resolutions instead of sleeping.
function startLongRunning(env, { v4 = v4Default, v6 = '' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-live-'));
    const write = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'v4'), v4);
    fs.writeFileSync(path.join(dir, 'v6'), v6);
    fs.writeFileSync(path.join(dir, 'calls'), '');
    write('getent', `echo "$1" >> "${dir}/calls"; case "$1" in ahostsv4) cat "${dir}/v4";; ahostsv6) cat "${dir}/v6";; esac; exit 0`);
    write('stdbuf', 'shift 2; exec "$@"');
    write('ronpaulcoind', `for a in "$@"; do case "$a" in -conf=*) grep '^rpcallowip=' "\${a#-conf=}";; esac; done
echo DAEMON-STARTED
trap 'echo DAEMON-STOPPED-CLEANLY; exit "\${STUB_EXIT:-0}"' TERM
[ -z "\${STUB_CRASH:-}" ] || { sleep 1; exit "$STUB_CRASH"; }
while :; do sleep 0.1; done`);
    const child = spawn('/bin/sh', [script], {
        env: { PATH: `${dir}:/usr/bin:/bin`, RPC_USER: 'rpcpool', RPC_PASSWORD: 'secretvalue', RPC_ALLOW_HOST: 'stratum-pool.railway.internal', RPC_ALLOW_HOST_REFRESH_SECONDS: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = { text: '', exit: null };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { out.text += chunk; });
    const exited = new Promise((resolve) => child.on('exit', (code) => { out.exit = code; resolve(code); }));
    const resolutions = () => fs.readFileSync(path.join(dir, 'calls'), 'utf8').split('\n').filter((l) => l === 'ahostsv4').length;
    const set = (answers) => { for (const [name, value] of Object.entries(answers)) fs.writeFileSync(path.join(dir, name), value); };
    const until = async (check, what, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (check()) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`timed out waiting for ${what}\n${out.text}`);
    };
    const cleanup = async () => {
        if (out.exit === null) { child.kill('SIGTERM'); await exited; }
        fs.rmSync(dir, { recursive: true, force: true });
    };
    return { child, out, exited, resolutions, set, until, cleanup };
}

const v4Default = '10.0.0.5 STREAM stratum-pool.railway.internal\n';
const v4Moved = '10.0.0.99 STREAM stratum-pool.railway.internal\n';

test('a confirmed change of the pool address stops the daemon cleanly and exits non-zero so it restarts', async () => {
    const live = startLongRunning({});
    try {
        await live.until(() => live.out.text.includes('DAEMON-STARTED'), 'the daemon to start');
        assert.match(live.out.text, /^rpcallowip=10\.0\.0\.5$/m);
        live.set({ v4: v4Moved });
        assert.equal(await live.exited, 1);
        assert.match(live.out.text, /DAEMON-STOPPED-CLEANLY/);
        assert.match(live.out.text, /now resolves to 10\.0\.0\.99 .*restarts with the new allow-list/);
        assert.ok(!live.out.text.includes('secretvalue'));
    } finally {
        await live.cleanup();
    }
});

test('restart recovery: the next start allows exactly the new address', async () => {
    const live = startLongRunning({}, { v4: v4Moved });
    try {
        await live.until(() => live.out.text.includes('DAEMON-STARTED'), 'the daemon to start');
        assert.deepEqual(live.out.text.match(/^rpcallowip=.*$/gm), ['rpcallowip=10.0.0.99']);
    } finally {
        await live.cleanup();
    }
});

test('a single differing lookup (DNS flap) does not restart the daemon', async () => {
    const live = startLongRunning({});
    try {
        await live.until(() => live.out.text.includes('DAEMON-STARTED'), 'the daemon to start');
        const base = live.resolutions();
        live.set({ v4: v4Moved });
        await live.until(() => live.resolutions() >= base + 1, 'one differing lookup');
        live.set({ v4: v4Default });
        const settled = live.resolutions();
        await live.until(() => live.resolutions() >= settled + 3, 'three more lookups');
        assert.equal(live.out.exit, null);
        assert.ok(!live.out.text.includes('DAEMON-STOPPED-CLEANLY'));
    } finally {
        await live.cleanup();
    }
});

test('a failed or empty lookup while running keeps the current allow-list and logs once', async () => {
    const live = startLongRunning({});
    try {
        await live.until(() => live.out.text.includes('DAEMON-STARTED'), 'the daemon to start');
        const base = live.resolutions();
        live.set({ v4: '', v6: '' });
        await live.until(() => live.resolutions() >= base + 3, 'three empty lookups');
        assert.equal(live.out.exit, null);
        assert.equal((live.out.text.match(/did not resolve; keeping the current allow-list/g) || []).length, 1);
        live.set({ v4: v4Default });
        const after = live.resolutions();
        await live.until(() => live.resolutions() >= after + 2, 'lookups after recovery');
        assert.equal(live.out.exit, null);
    } finally {
        await live.cleanup();
    }
});

test('SIGTERM is forwarded to the daemon for a clean shutdown and the entrypoint exits 0', async () => {
    const live = startLongRunning({});
    try {
        await live.until(() => live.out.text.includes('DAEMON-STARTED'), 'the daemon to start');
        live.child.kill('SIGTERM');
        assert.equal(await live.exited, 0);
        assert.match(live.out.text, /DAEMON-STOPPED-CLEANLY/);
    } finally {
        await live.cleanup();
    }
});

test('a daemon crash is passed through as the exit status', async () => {
    const live = startLongRunning({ STUB_CRASH: '7' });
    try {
        assert.equal(await live.exited, 7);
        assert.ok(!live.out.text.includes('DAEMON-STOPPED-CLEANLY'));
    } finally {
        await live.cleanup();
    }
});

test('RPC_ALLOW_HOST_REFRESH_SECONDS=0 disables re-resolution', async () => {
    const live = startLongRunning({ RPC_ALLOW_HOST_REFRESH_SECONDS: '0' });
    try {
        await live.until(() => live.out.text.includes('DAEMON-STARTED'), 'the daemon to start');
        const base = live.resolutions();
        live.set({ v4: v4Moved });
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(live.resolutions(), base);
        assert.equal(live.out.exit, null);
    } finally {
        await live.cleanup();
    }
});

test('RPC_ALLOW_IP mode never starts a watcher', async () => {
    const live = startLongRunning({ RPC_ALLOW_HOST: '', RPC_ALLOW_IP: '10.0.0.5' });
    try {
        await live.until(() => live.out.text.includes('DAEMON-STARTED'), 'the daemon to start');
        await new Promise((resolve) => setTimeout(resolve, 1800));
        assert.equal(live.resolutions(), 0);
    } finally {
        await live.cleanup();
    }
});

test('a non-numeric RPC_ALLOW_HOST_REFRESH_SECONDS is refused', () => {
    const r = run({ RPC_ALLOW_HOST: 'a.internal', RPC_ALLOW_HOST_REFRESH_SECONDS: '-1' }, { ahostsv4: v4 });
    assert.equal(r.status, 2);
    assert.ok(!r.stdout.includes('ARGS:'));
});
