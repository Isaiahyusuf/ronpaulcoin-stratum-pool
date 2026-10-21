'use strict';

const values = {};
let toastTimer;

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function formatTime(value) {
    if (!value) return 'Update time unavailable';
    return `UPDATED ${new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function formatNumber(value) {
    return value === null || value === undefined ? 'Unavailable' : new Intl.NumberFormat().format(value);
}

function formatHashrate(value) {
    if (value === null || value === undefined) return 'Collecting data';
    const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let rate = value;
    let unit = 0;
    while (rate >= 1000 && unit < units.length - 1) {
        rate /= 1000;
        unit += 1;
    }
    return `${new Intl.NumberFormat([], { maximumFractionDigits: 2 }).format(rate)} ${units[unit]}`;
}

function renderMining(mining) {
    const online = mining.trackingStatus === 'available' || mining.trackingStatus === 'degraded';
    const hashrate = formatHashrate(mining.poolHashrate);
    setText('pool-hashrate', hashrate);
    setText('hashrate-foot', mining.poolHashrate === null
        ? 'A full 10-minute observation window is required'
        : `Estimated from accepted shares over ${Math.floor((mining.hashrateWindowSeconds || 600) / 60)} minutes`);
    setText('connected-miners', formatNumber(mining.connectedMiners));
    setText('connected-workers', `${formatNumber(mining.connectedWorkers)} · ${formatNumber(mining.workerConnections)} total connections / ${formatNumber(mining.workerDisconnections)} disconnects`);
    setText('accepted-shares', formatNumber(mining.acceptedShares));
    setText('last-share', mining.lastShareAt ? `Last share: ${new Date(mining.lastShareAt).toLocaleString()}` : 'Last share: none recorded');
    setText('rejected-shares', formatNumber(mining.rejectedShares));
    setText('rejected-count', formatNumber(mining.rejectedShares));
    setText('stale-count', formatNumber(mining.staleShares));
    setText('blocks-found', formatNumber(mining.blocksFound));
    setText('block-foot', mining.lastBlock
        ? `Last confirmed: height ${formatNumber(mining.lastBlock.height)} · ${mining.lastBlock.at ? new Date(mining.lastBlock.at).toLocaleString() : 'time unavailable'}`
        : 'Only daemon-confirmed main-chain blocks');
    setText('activity-note', online
        ? mining.trackingStatus === 'degraded' ? 'Telemetry persistence degraded' : `Tracking since ${mining.trackingSince ? new Date(mining.trackingSince).toLocaleString() : 'startup'}`
        : 'Activity feed unavailable');
    setText('activity-disclaimer', mining.unavailableReason
        || 'Historical totals begin when this telemetry deployment started; no earlier activity is inferred. A connected miner or delivered job is not an accepted share.');
    const activity = document.getElementById('recent-activity');
    activity.replaceChildren();
    if (!online) {
        const item = document.createElement('li');
        item.className = 'activity-empty';
        item.textContent = 'Share activity is currently unavailable.';
        activity.append(item);
    } else if (!mining.recentActivity || mining.recentActivity.length === 0) {
        const item = document.createElement('li');
        item.className = 'activity-empty';
        item.textContent = 'No share submissions recorded since tracking began.';
        activity.append(item);
    } else {
        for (const event of mining.recentActivity) {
            const item = document.createElement('li');
            item.className = `activity-event ${event.status}`;
            const outcome = document.createElement('span');
            outcome.className = 'activity-outcome';
            outcome.textContent = event.status === 'accepted' ? 'ACCEPTED'
                : event.status === 'stale' ? 'STALE JOB'
                    : event.status === 'rejected' ? 'REJECTED' : 'OUTCOME UNAVAILABLE';
            const detail = document.createElement('span');
            detail.className = 'activity-detail';
            detail.textContent = event.difficulty === null ? 'Difficulty unavailable' : `Share difficulty ${event.difficulty}`;
            const time = document.createElement('time');
            time.className = 'activity-time';
            time.textContent = event.at ? new Date(event.at).toLocaleString() : 'Time unavailable';
            item.append(outcome, detail, time);
            activity.append(item);
        }
    }
}

function render(data) {
    values.host = data.connection.host;
    values.port = String(data.connection.port);
    values.login = data.connection.loginFormat.replace('<worker>', 'worker1');
    values.password = 'x';
    values.address = data.connection.rewardAddress;
    values.command = `cpuminer -a scrypt -o stratum+tcp://${values.host}:${values.port} -u ${values.login} -p x`;

    setText('endpoint-host', `${values.host}:${values.port}`);
    setText('connect-host', values.host);
    setText('connect-port', values.port);
    setText('connect-login', values.login);
    setText('connect-password', 'Any string');
    setText('reward-address', values.address);
    setText('command-text', values.command);
    setText('last-check', formatTime(data.pool.checkedAt));
    setText('pool-status', data.pool.status === 'reachable' ? 'STRATUM READY' : data.pool.status === 'offline' ? 'OFFLINE' : 'CHECK FAILED');
    setText('rpc-status', data.network.daemonRpc === 'unavailable' ? 'Private / unavailable' : data.network.daemonRpc);
    renderMining(data.mining);

    const dot = document.getElementById('status-dot');
    dot.classList.toggle('online', data.pool.status === 'reachable');
    dot.classList.toggle('offline', data.pool.status !== 'reachable');
}

async function refresh() {
    try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Dashboard status request returned ${response.status}`);
        render(await response.json());
    } catch {
        setText('pool-status', 'STATUS UNAVAILABLE');
        setText('last-check', 'Health check failed');
        setText('endpoint-host', 'Unable to load endpoint status');
        document.getElementById('status-dot').classList.add('offline');
    }
}

async function copyValue(key) {
    const value = values[key];
    if (!value) return;
    try {
        await navigator.clipboard.writeText(value);
        const toast = document.getElementById('toast');
        toast.textContent = 'Copied to clipboard';
        toast.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('visible'), 1500);
    } catch {
        const toast = document.getElementById('toast');
        toast.textContent = 'Clipboard access unavailable';
        toast.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
    }
}

document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyValue(button.dataset.copy));
});

refresh();
setInterval(refresh, 15_000);
