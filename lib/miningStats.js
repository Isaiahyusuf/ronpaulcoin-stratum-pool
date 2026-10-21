'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const HASHES_PER_DIFFICULTY = 2 ** 32;
const HASHRATE_WINDOW_SECONDS = 600;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COUNTERS = ['accepted', 'rejected', 'stale', 'connections', 'disconnections'];

function workerKey(login) {
    const value = typeof login === 'string' ? login : '';
    const worker = value.includes('.') ? value.slice(value.indexOf('.') + 1) : 'default';
    return crypto.createHash('sha256').update(worker || 'default').digest('hex');
}

function rejectionKind(error) {
    const message = typeof error === 'string' ? error : '';
    if (/stale|job not found/i.test(message)) return 'stale';
    return 'rejected';
}

class MiningStats {
    constructor(file, { now = Date.now } = {}) {
        if (!path.isAbsolute(file)) throw new Error('Mining statistics database path must be absolute');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.now = now;
        this.startedAt = now();
        this.connections = new Map();
        this.storageError = null;
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS share_events (
                id INTEGER PRIMARY KEY,
                event_time INTEGER NOT NULL,
                worker_key TEXT NOT NULL,
                difficulty REAL,
                status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'stale')),
                block_hash TEXT,
                block_height INTEGER
            );
            CREATE INDEX IF NOT EXISTS share_events_time_status
                ON share_events(event_time, status);
            CREATE INDEX IF NOT EXISTS share_events_worker_time
                ON share_events(worker_key, event_time);
            CREATE TABLE IF NOT EXISTS worker_sessions (
                id INTEGER PRIMARY KEY,
                worker_key TEXT NOT NULL,
                connected_at INTEGER NOT NULL,
                disconnected_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS worker_sessions_connected_time
                ON worker_sessions(connected_at);
            CREATE TABLE IF NOT EXISTS counters (
                name TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS confirmed_blocks (
                block_hash TEXT PRIMARY KEY,
                height INTEGER NOT NULL,
                found_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stats_metadata (
                name TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
        for (const counter of COUNTERS) {
            this.db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)').run(counter);
        }
        this.db.prepare('INSERT OR IGNORE INTO stats_metadata (name, value) VALUES (?, ?)').run('last_cleanup', '0');
        const abandoned = this.db.prepare('SELECT COUNT(*) AS count FROM worker_sessions WHERE disconnected_at IS NULL').get().count;
        if (abandoned > 0) {
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.db.prepare('UPDATE worker_sessions SET disconnected_at = ? WHERE disconnected_at IS NULL').run(this.startedAt);
                this.db.prepare("UPDATE counters SET value = value + ? WHERE name = 'disconnections'").run(abandoned);
                this.db.exec('COMMIT');
            } catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
        }
        try {
            fs.chmodSync(file, 0o600);
            fs.chmodSync(`${file}-wal`, 0o600);
            fs.chmodSync(`${file}-shm`, 0o600);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    connected(client) {
        this.connections.set(client, { authorized: false, workerKey: null, sessionId: null });
    }

    authorized(client, accepted, login) {
        const session = this.connections.get(client) || { authorized: false, workerKey: null, sessionId: null };
        if (session.authorized) this.finishSession(session, this.now());
        session.authorized = accepted === true;
        session.workerKey = session.authorized ? workerKey(login) : null;
        session.sessionId = null;
        if (session.authorized) {
            const connectedAt = this.now();
            this.db.exec('BEGIN IMMEDIATE');
            try {
                const result = this.db.prepare(`
                    INSERT INTO worker_sessions (worker_key, connected_at) VALUES (?, ?)
                `).run(session.workerKey, connectedAt);
                session.sessionId = Number(result.lastInsertRowid);
                this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'connections'").run();
                this.db.exec('COMMIT');
            } catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
            this.cleanup(connectedAt);
        }
        this.connections.set(client, session);
    }

    disconnected(client) {
        const session = this.connections.get(client);
        if (session && session.authorized) this.finishSession(session, this.now());
        this.connections.delete(client);
    }

    finishSession(session, disconnectedAt) {
        if (session.sessionId === null) return;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = this.db.prepare(`
                UPDATE worker_sessions SET disconnected_at = ?
                WHERE id = ? AND disconnected_at IS NULL
            `).run(disconnectedAt, session.sessionId);
            if (result.changes > 0) {
                this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'disconnections'").run();
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        session.sessionId = null;
        this.cleanup(disconnectedAt);
    }

    recordShare(isValidShare, data) {
        const now = this.now();
        const status = isValidShare ? 'accepted' : rejectionKind(data && data.error);
        const worker = workerKey(data && data.worker);
        const difficulty = Number(data && data.difficulty);
        const validDifficulty = Number.isFinite(difficulty) && difficulty > 0 ? difficulty : null;
        const blockHash = data && data.blockStatus === 'accepted' && /^[a-f0-9]{64}$/i.test(data.blockHash || '')
            ? data.blockHash.toLowerCase()
            : null;
        const blockHeight = blockHash && Number.isInteger(data.height) ? data.height : null;

        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare(`
                INSERT INTO share_events (event_time, worker_key, difficulty, status, block_hash, block_height)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(now, worker, validDifficulty, status, blockHash, blockHeight);
            this.db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(status);
            if (blockHash && blockHeight !== null) {
                this.db.prepare(`
                    INSERT OR IGNORE INTO confirmed_blocks (block_hash, height, found_at)
                    VALUES (?, ?, ?)
                `).run(blockHash, blockHeight, now);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }

        this.cleanup(now);
    }

    cleanup(now) {
        const lastCleanup = Number(this.db.prepare("SELECT value FROM stats_metadata WHERE name = 'last_cleanup'").get().value);
        if (now - lastCleanup >= 24 * 60 * 60 * 1000) {
            this.db.prepare('DELETE FROM share_events WHERE event_time < ?').run(now - EVENT_RETENTION_MS);
            this.db.prepare('DELETE FROM worker_sessions WHERE disconnected_at IS NOT NULL AND disconnected_at < ?')
                .run(now - EVENT_RETENTION_MS);
            this.db.prepare("UPDATE stats_metadata SET value = ? WHERE name = 'last_cleanup'").run(String(now));
        }
    }

    summary() {
        const now = this.now();
        const counters = Object.fromEntries(
            this.db.prepare('SELECT name, value FROM counters').all().map(({ name, value }) => [name, value])
        );
        const sessions = [...this.connections.values()].filter((session) => session.authorized);
        const activeWorkers = new Set(sessions.map((session) => session.workerKey));
        const activeWindow = this.db.prepare(`
            SELECT COUNT(DISTINCT worker_key) AS workers
            FROM share_events
            WHERE event_time >= ? AND status = 'accepted'
        `).get(now - 24 * 60 * 60 * 1000).workers;
        const recentActivity = this.db.prepare(`
            SELECT event_time, status, difficulty, block_height
            FROM share_events
            ORDER BY id DESC LIMIT 10
        `).all().map((event) => ({
            at: new Date(event.event_time).toISOString(),
            status: event.status,
            difficulty: event.difficulty,
            blockHeight: event.block_height
        }));
        const blocks = this.db.prepare(`
            SELECT block_hash, height, found_at
            FROM confirmed_blocks
            ORDER BY found_at DESC LIMIT 1
        `).get();
        const lastShare = this.db.prepare('SELECT MAX(event_time) AS timestamp FROM share_events').get().timestamp;
        const recentWorkerSessions = this.db.prepare(`
            SELECT connected_at, disconnected_at FROM worker_sessions
            ORDER BY id DESC LIMIT 10
        `).all().map((session) => ({
            connectedAt: new Date(session.connected_at).toISOString(),
            disconnectedAt: session.disconnected_at === null ? null : new Date(session.disconnected_at).toISOString()
        }));
        const elapsedSeconds = Math.floor((now - this.startedAt) / 1000);
        const completeWindow = elapsedSeconds >= HASHRATE_WINDOW_SECONDS;
        const difficultySum = completeWindow
            ? this.db.prepare(`
                SELECT COALESCE(SUM(difficulty), 0) AS total
                FROM share_events
                WHERE event_time >= ? AND status = 'accepted' AND difficulty IS NOT NULL
            `).get(now - HASHRATE_WINDOW_SECONDS * 1000).total
            : null;

        return {
            trackingSince: new Date(this.startedAt).toISOString(),
            storage: this.storageError ? 'degraded' : 'available',
            poolHashrate: completeWindow ? difficultySum * HASHES_PER_DIFFICULTY / HASHRATE_WINDOW_SECONDS : null,
            hashrateWindowSeconds: HASHRATE_WINDOW_SECONDS,
            connectedMiners: sessions.length,
            connectedWorkers: activeWorkers.size,
            activeWorkers24h: activeWindow,
            workerConnections: counters.connections || 0,
            workerDisconnections: counters.disconnections || 0,
            submittedShares: (counters.accepted || 0) + (counters.rejected || 0) + (counters.stale || 0),
            recentWorkerSessions,
            acceptedShares: counters.accepted || 0,
            rejectedShares: counters.rejected || 0,
            staleShares: counters.stale || 0,
            blocksFound: this.db.prepare('SELECT COUNT(*) AS count FROM confirmed_blocks').get().count,
            lastShareAt: lastShare === null ? null : new Date(lastShare).toISOString(),
            lastBlock: blocks ? {
                hash: blocks.block_hash,
                height: blocks.height,
                at: new Date(blocks.found_at).toISOString()
            } : null,
            recentActivity
        };
    }

    markStorageError(error) {
        this.storageError = error;
    }

    close() {
        this.db.close();
    }
}

module.exports = { MiningStats, HASHRATE_WINDOW_SECONDS, HASHES_PER_DIFFICULTY };
