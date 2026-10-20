const { interface: DaemonInterface } = require('../vendor/stratum-pool/lib/daemon');
const { sanitizeLogMessage } = require('./logFormat');

// Resolves once every configured daemon answers an RPC call, retrying at a fixed interval. The pool must not
// listen for miners or hand out jobs before this resolves. Failure messages never include credentials: they
// are built from the daemon index, host, port and the transport error only.
function waitForDaemons(daemons, { intervalMs = 5000, logIntervalMs = 60000, log = () => {}, now = Date.now, signal } = {}) {
    // A private copy: the interface hides the password on the objects it is given and numbers them.
    const iface = new DaemonInterface(
        daemons.map(({ host, port, user, password }) => ({ host, port, user, password })),
        () => {}
    );
    let attempts = 0;
    let lastKey = null;
    let lastLogAt = 0;
    let suppressed = 0;

    const describe = (result, instance) => {
        const error = result.error;
        const where = `${instance.host}:${instance.port}`;
        if (error.type === 'unauthorized') {
            return `${where} refused the request (${error.message}); check the RPC credentials and the daemon's RPC allow-list`;
        }
        return `${where} ${error.type || `RPC error ${error.code}`}: ${error.message}`;
    };

    return new Promise((resolve, reject) => {
        let timer = null;
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('Waiting for the daemon was cancelled'));
        };
        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }
        const attempt = () => {
            if (signal && signal.aborted) return;
            attempts += 1;
            iface.cmd('getpeerinfo', [], (results) => {
                const failures = results
                    .map((result) => (result.error ? describe(result, result.instance) : null))
                    .filter(Boolean);
                if (failures.length === 0) {
                    if (lastKey !== null) log('info', `Daemon RPC is healthy after ${attempts} attempt(s)`);
                    if (signal) signal.removeEventListener('abort', onAbort);
                    return resolve();
                }
                const key = failures.join('; ');
                const time = now();
                if (key !== lastKey || time - lastLogAt >= logIntervalMs) {
                    const note = suppressed > 0 ? ` (${suppressed} identical attempt(s) not logged)` : '';
                    log('warning', `Waiting for daemon RPC, retrying every ${Math.round(intervalMs / 1000)}s: ${sanitizeLogMessage(key)}${note}`);
                    lastKey = key;
                    lastLogAt = time;
                    suppressed = 0;
                } else {
                    suppressed += 1;
                }
                timer = setTimeout(attempt, intervalMs);
            });
        };
        attempt();
    });
}

module.exports = { waitForDaemons };
