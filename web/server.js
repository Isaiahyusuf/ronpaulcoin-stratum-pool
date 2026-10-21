'use strict';

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const PUBLIC_FILES = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

function readConfig(env) {
    const host = env.STRATUM_PUBLIC_HOST;
    const port = Number(env.STRATUM_PUBLIC_PORT);
    const address = env.POOL_ADDRESS;
    if (!host || !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('STRATUM_PUBLIC_HOST must be a hostname');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STRATUM_PUBLIC_PORT must be an integer from 1 to 65535');
    if (!address || !/^[A-Za-z0-9]+$/.test(address)) throw new Error('POOL_ADDRESS must be configured');
    const webPort = env.PORT === undefined ? 3000 : Number(env.PORT);
    if (!Number.isInteger(webPort) || webPort < 0 || webPort > 65535) throw new Error('PORT must be an integer from 0 to 65535');
    const statsUrl = env.POOL_STATS_URL || '';
    const statsToken = env.POOL_STATS_TOKEN || '';
    if (Boolean(statsUrl) !== Boolean(statsToken)) throw new Error('POOL_STATS_URL and POOL_STATS_TOKEN must be configured together');
    let statsEndpoint = null;
    if (statsUrl) {
        let parsed;
        try {
            parsed = new URL(statsUrl);
        } catch {
            throw new Error('POOL_STATS_URL must be a private Railway HTTP endpoint');
        }
        if (parsed.protocol !== 'http:' || !parsed.hostname.endsWith('.railway.internal') || parsed.username || parsed.password
            || parsed.search || parsed.hash || parsed.pathname !== '/internal/stats') {
            throw new Error('POOL_STATS_URL must be a private Railway HTTP endpoint');
        }
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(statsToken)) throw new Error('POOL_STATS_TOKEN must be 32-256 URL-safe characters');
        statsEndpoint = { url: parsed.toString(), token: statsToken };
    }
    return { host, port, address, webPort, statsEndpoint };
}

async function fetchPoolStats(endpoint) {
    if (!endpoint) throw new Error('Pool activity feed is not configured');
    const response = await fetch(endpoint.url, {
        headers: { Authorization: `Bearer ${endpoint.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) throw new Error(`Private stats endpoint returned ${response.status}`);
    return response.json();
}

function normalizeMiningStats(stats) {
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const recentActivity = Array.isArray(stats.recentActivity) ? stats.recentActivity.slice(0, 10).map((event) => ({
        at: validTime(event.at),
        status: ['accepted', 'rejected', 'stale'].includes(event.status) ? event.status : 'unavailable',
        difficulty: finite(event.difficulty),
        blockHeight: count(event.blockHeight)
    })) : null;
    const recentWorkerSessions = Array.isArray(stats.recentWorkerSessions) ? stats.recentWorkerSessions.slice(0, 10).map((session) => ({
        connectedAt: validTime(session.connectedAt),
        disconnectedAt: validTime(session.disconnectedAt)
    })) : null;
    const lastBlock = stats.lastBlock && typeof stats.lastBlock === 'object'
        && /^[a-f0-9]{64}$/i.test(stats.lastBlock.hash || '') && count(stats.lastBlock.height) !== null
        ? { hash: stats.lastBlock.hash.toLowerCase(), height: stats.lastBlock.height, at: validTime(stats.lastBlock.at) }
        : null;
    return {
        trackingStatus: stats.storage === 'available' || stats.storage === 'degraded' ? stats.storage : 'unavailable',
        trackingSince: validTime(stats.trackingSince),
        poolHashrate: finite(stats.poolHashrate),
        hashrateWindowSeconds: count(stats.hashrateWindowSeconds),
        connectedMiners: count(stats.connectedMiners),
        connectedWorkers: count(stats.connectedWorkers),
        activeWorkers24h: count(stats.activeWorkers24h),
        workerConnections: count(stats.workerConnections),
        workerDisconnections: count(stats.workerDisconnections),
        submittedShares: count(stats.submittedShares),
        acceptedShares: count(stats.acceptedShares),
        rejectedShares: count(stats.rejectedShares),
        staleShares: count(stats.staleShares),
        blocksFound: count(stats.blocksFound),
        lastShareAt: validTime(stats.lastShareAt),
        lastBlock,
        recentActivity,
        recentWorkerSessions,
        unavailableReason: stats.storage === 'degraded'
            ? 'Statistics storage reported an error; values may not include recent activity.'
            : null
    };
}

function probeStratum(host, port, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        let settled = false;
        let buffer = '';
        const finish = (connected) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(connected);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => {
            socket.write(`${JSON.stringify({ id: 1, method: 'mining.subscribe', params: [] })}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            if (buffer.length > 16_384) {
                finish(false);
                return;
            }
            const newline = buffer.indexOf('\n');
            if (newline === -1) return;
            try {
                const reply = JSON.parse(buffer.slice(0, newline));
                finish(reply.id === 1 && reply.error == null && Object.hasOwn(reply, 'result'));
            } catch {
                finish(false);
            }
        });
        socket.once('error', () => finish(false));
    });
}

function sendJson(response, status, value) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(value));
}

function createRateLimiter({ maxRequests = 60, windowMs = 60_000, now = Date.now } = {}) {
    const clients = new Map();
    return (key) => {
        const currentTime = now();
        let entry = clients.get(key);
        if (!entry || currentTime >= entry.expiresAt) {
            entry = { count: 0, expiresAt: currentTime + windowMs };
            clients.set(key, entry);
        }
        entry.count += 1;
        if (clients.size > 1000) {
            for (const [client, state] of clients) {
                if (currentTime >= state.expiresAt) clients.delete(client);
            }
        }
        return entry.count <= maxRequests;
    };
}

function createDashboardServer({ env = process.env, probe = probeStratum, statsFetch = fetchPoolStats, now = () => new Date() } = {}) {
    const config = readConfig(env);
    const allowApiRequest = createRateLimiter();
    const publicDir = path.join(__dirname, 'public');

    return http.createServer(async (request, response) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        response.setHeader('Strict-Transport-Security', 'max-age=31536000');

        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.setHeader('Allow', 'GET, HEAD');
            response.writeHead(405);
            response.end();
            return;
        }

        if (pathname === '/healthz') {
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(request.method === 'HEAD' ? undefined : 'ok');
            return;
        }

        if (pathname === '/api/status') {
            const client = request.socket.remoteAddress || 'unknown';
            if (!allowApiRequest(client)) {
                sendJson(response, 429, { error: 'Rate limit exceeded. Retry shortly.' });
                return;
            }

            let reachable = false;
            let probeFailed = false;
            try {
                reachable = await probe(config.host, config.port);
            } catch {
                probeFailed = true;
            }
            let mining;
            try {
                mining = normalizeMiningStats(await statsFetch(config.statsEndpoint));
            } catch {
                mining = {
                    trackingStatus: 'unavailable',
                    trackingSince: null,
                    poolHashrate: null,
                    hashrateWindowSeconds: null,
                    connectedMiners: null,
                    connectedWorkers: null,
                    activeWorkers24h: null,
                    workerConnections: null,
                    workerDisconnections: null,
                    submittedShares: null,
                    acceptedShares: null,
                    rejectedShares: null,
                    staleShares: null,
                    blocksFound: null,
                    lastShareAt: null,
                    lastBlock: null,
                    recentActivity: null,
                    recentWorkerSessions: null,
                    unavailableReason: 'The private pool activity feed is unavailable; activity metrics cannot be updated.'
                };
            }
            const checkedAt = now().toISOString();
            sendJson(response, 200, {
                generatedAt: checkedAt,
                pool: {
                    status: probeFailed ? 'unavailable' : reachable ? 'reachable' : 'offline',
                    error: probeFailed ? 'The Stratum subscribe health check could not complete.' : null,
                    checkedAt,
                    check: 'mining.subscribe',
                    endpoint: { host: config.host, port: config.port, protocol: 'Stratum TCP' }
                },
                mining,
                network: {
                    daemonRpc: 'unavailable',
                    synchronization: 'unverified',
                    height: null,
                    bestHash: null,
                    latestBlockTime: null,
                    difficulty: null,
                    blockReward: null,
                    peers: null,
                    template: 'unavailable',
                    warning: 'The dashboard intentionally has no daemon RPC access. Mainnet synchronization and canonical-chain status are not independently verified.'
                },
                connection: {
                    host: config.host,
                    port: config.port,
                    protocol: 'Stratum TCP',
                    loginFormat: `${config.address}.<worker>`,
                    workerRule: 'Worker names may contain letters, digits, underscore, and hyphen (1-32 characters).',
                    passwordFormat: 'Any password string; the pool does not use it for authentication.',
                    rewardAddress: config.address
                },
                solo: {
                    payout: 'A successfully mined block pays the configured reward address.',
                    distribution: 'This pool does not distribute rewards to miners or account for proportional payouts.',
                    probability: 'Finding a block is probabilistic and is not guaranteed.'
                }
            });
            return;
        }

        const file = PUBLIC_FILES.get(pathname);
        if (!file) {
            response.writeHead(404, { 'Cache-Control': 'no-store' });
            response.end();
            return;
        }
        const [name, contentType] = file;
        fs.readFile(path.join(publicDir, name), (error, content) => {
            if (error) {
                response.writeHead(500, { 'Cache-Control': 'no-store' });
                response.end();
                return;
            }
            response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
            response.end(request.method === 'HEAD' ? undefined : content);
        });
    });
}

if (require.main === module) {
    const server = createDashboardServer();
    const port = Number(process.env.PORT || 3000);
    server.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on port ${port}`));
}

module.exports = { createDashboardServer, createRateLimiter, probeStratum, readConfig, normalizeMiningStats };
