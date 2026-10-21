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
