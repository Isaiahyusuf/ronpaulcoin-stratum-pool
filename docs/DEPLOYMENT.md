# Railway deployment runbook

Status: **the Railway production daemon answers RPC but is not ready to mine; `stratum-pool` exists as an idle, unlinked service placeholder.**
The daemon reports mainnet mode, block height 0 and zero peers; `getblocktemplate` returns
`RonPaulCoin is not connected!`. Attempts to connect the pinned mainnet seed addresses did not establish a
peer. There is no pool TCP proxy or public Stratum endpoint. Pool and daemon behavior has been tested together
on local regtest only (see "What was verified"). Payouts are disabled and not implemented. Do not expose
daemon RPC or P2P ports publicly. The live daemon's RPC allow-list currently covers a private-network range,
not only the future pool address; narrow it to the pool's resolved private address before connecting the
services.

## Services

| Service | Source | Volume | Public networking |
|---|---|---|---|
| `ronpaulcoind` | deployed daemon, Dockerfile `docker/daemon/Dockerfile` | `/data` | **none** (no domain, no TCP proxy) |
| `stratum-pool` | idle placeholder; connect this repo, branch `main`, root `Dockerfile` after blockers are resolved | `/data` (block journal) | TCP proxy to port 3333 only after the daemon and pool address are ready |

Railway's TCP proxy ([docs](https://docs.railway.com/networking/tcp-proxy)) gives the pool a public
`<name>.proxy.rlwy.net:<port>` that forwards raw TCP, so Stratum works there. The port number is chosen
by Railway, not by you; miners use `stratum+tcp://<name>.proxy.rlwy.net:<port>`. A custom domain can be
CNAMEd to the proxy host (DNS only, no Cloudflare proxying) but the port stays Railway's. Ordinary HTTP
domains cannot carry Stratum. The daemon is reached only over private networking
(`ronpaulcoind.railway.internal:9026`). Never generate a public domain or TCP proxy for it.

Railway Docker health checks are HTTP-only and the pool has no HTTP server (by design, no dashboard), so
configure none. Set the restart policy of both services as described in "Restart policy" below.

## Settings that need your decision before deploying

1. **Daemon sync and the pool start order.** The pool does not exit when its daemon is down, refuses
   credentials or is still starting: it retries RPC every `DAEMON_RETRY_SECONDS` (default 5), logs a
   repeated identical failure at most once a minute, and opens no Stratum port and issues no jobs until
   every daemon answers. After that it still waits for `getblocktemplate`, which the 0.9.1 daemon only
   answers with at least one peer and after initial download. So the services can be started in any order.
   Invalid or missing pool configuration still exits immediately (a retry cannot fix it). Wrong RPC
   credentials are retried, not treated as fatal, so that a credential rotation converges; the log names
   the refusal (HTTP 401/403) but never the password.
2. **Volumes and `RAILWAY_RUN_UID=0`.** The images run as non-root users, and Railway volumes are mounted
   root-owned, so Railway's documented workaround is `RAILWAY_RUN_UID=0` on both services. This runs the
   processes as root inside the container: a weaker posture than the tested non-root runs. If you do not
   accept that, the pool can run without a journal volume (block outcomes then live only in logs) and the
   daemon cannot run without a volume (it would re-sync on every deploy).
3. **Daemon RPC allow-list.** The daemon matches `-rpcallowip` as an exact string (`*` and `?` are
   wildcards) against the caller's address; loopback is always allowed, and IPv4-mapped IPv6 callers are
   matched in their IPv4 form (pinned source, `rpcserver.cpp` `ClientAllowed`). Railway documents no
   private address range (`<service>.railway.internal` resolves to internal IPv6, plus IPv4 in
   environments created after 2025-10-16), so no prefix is trusted. Set `RPC_ALLOW_HOST` on the daemon to
   the pool's private name, `stratum-pool.railway.internal`. At startup the entrypoint resolves it (IPv4 and
   IPv6, mapped entries dropped) and writes one exact `rpcallowip=<address>` line per address. If the name
   does not resolve within `RPC_ALLOW_HOST_WAIT_SECONDS` (default 60) the daemon exits with status 3 and the
   restart policy retries; it never starts with a broad or default pattern. `RPC_ALLOW_IP` (an explicit
   pattern; leading wildcards are refused) is the alternative; set exactly one of the two.
   **Address changes:** the pinned daemon cannot reload `-rpcallowip` (`SIGHUP` only reopens `debug.log`;
   there is no reload RPC), so the list is fixed while it runs. While `RPC_ALLOW_HOST` is used, the entrypoint
   re-resolves it every `RPC_ALLOW_HOST_REFRESH_SECONDS` (default 30, `0` disables). A non-empty answer that
   differs from the active list and repeats on two consecutive checks makes it send the daemon `SIGTERM`
   (a clean shutdown that flushes the chain database to the volume) and exit with status 1; the restart
   policy then starts a fresh container whose list is current. A failed or empty lookup never changes
   anything (the current list stays and one warning is logged), and a single differing answer (DNS flap) is
   ignored. Until the restart completes the pool receives HTTP 403 and keeps retrying; nothing is ever left
   open. Expect about a minute of daemon downtime per address change, and a normal start-up time for the
   daemon afterwards. Cold start: the pool stays up waiting for the daemon, so its private name resolves;
   the daemon waits up to `RPC_ALLOW_HOST_WAIT_SECONDS` for that name and otherwise exits with status 3 and
   is restarted. Whether Railway resolves a service's private name while its container is crash-looping
   is not documented and has not been verified.
4. **Per-IP limits.** Railway's TCP proxy is not documented as preserving client addresses and the pool
   does not parse PROXY protocol. Assume every miner appears from the proxy's address and set
   `MAX_CONNECTIONS_PER_IP=0` until a test with two real client addresses shows otherwise. The
   per-connection limits (protocol errors, invalid-share ratio, message rate, output buffer) still apply.
5. **Pool address and difficulty.** `POOL_ADDRESS` must be a real mainnet address you control (the
   daemon has no wallet here). `STRATUM_DIFFICULTY` must be tuned for the real network and expected miner
   hashrate; the default of 1 is untested on mainnet. A share rate above about 100 messages per second per
   connection exceeds the default `MESSAGE_RATE_LIMIT`.

## Variables

`ronpaulcoind` (all values: letters, digits and `. _ : * @ % + = / -` only; the entrypoint refuses others):

| Variable | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `docker/daemon/Dockerfile` |
| `RAILWAY_RUN_UID` | `0` (see above) |
| `RPC_USER`, `RPC_PASSWORD` | random strings, for example `openssl rand -hex 24` for the password |
| `RPC_ALLOW_HOST` | `stratum-pool.railway.internal` (resolved to exact addresses at startup) |
| `RPC_ALLOW_HOST_WAIT_SECONDS` | optional, default 60: how long to wait for the name at start before exiting 3 |
| `RPC_ALLOW_HOST_REFRESH_SECONDS` | optional, default 30, `0` disables re-resolution |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | e.g. `60`: time between SIGTERM and SIGKILL so the daemon can flush its database (see below) |
| `RPC_ALLOW_IP` | alternative to `RPC_ALLOW_HOST`: an explicit address or pattern; set only one |
| `DAEMON_NETWORK` | `mainnet` (default), `testnet` or `regtest` |
| `RPC_PORT` | leave unset on mainnet (default 9026) |

Mainnet ports come from the pinned source: P2P 9027, RPC 9026. P2P is outbound only (`listen=0`).
The credentials are written to a mode-0600 config file in the container's temporary directory, not onto
the volume and not onto the command line.

`pool` (see the README table for every option):

| Variable | Value |
|---|---|
| `RAILWAY_RUN_UID` | `0` (only if you attach the journal volume) |
| `POOL_NETWORK` | `mainnet` |
| `POOL_ADDRESS` | your payout/coinbase address |
| `DAEMON_HOSTS` | `ronpaulcoind.railway.internal:9026` |
| `DAEMON_RPC_USER`, `DAEMON_RPC_PASSWORD` | Railway reference variables to the daemon's `RPC_USER` and `RPC_PASSWORD` |
| `STRATUM_PORT` | `3333` (the TCP proxy target) |
| `STRATUM_DIFFICULTY` | chosen for mainnet |
| `DAEMON_RETRY_SECONDS` | optional, default 5 |
| `MAX_CONNECTIONS_PER_IP` | `0` until real client addresses are confirmed |
| `BLOCK_JOURNAL_PATH` | `/data/blocks.jsonl` |

## Restart policy

Railway's [restart policy](https://docs.railway.com/deployments/restart-policy) is `Always`, `On Failure` or
`Never`; the default is `On Failure` with at most 10 restarts, and `Always` is not available on the Free or
trial plans. It is set per service in the dashboard (Service settings, Deploy). Required for this project:

| Service | Policy | Why |
|---|---|---|
| `ronpaulcoind` | `Always` | it deliberately exits (status 3 when the pool name is unresolved, status 1 after a confirmed pool-address change) and must come back every time, not only 10 times |
| `stratum-pool` | `Always` | it exits on invalid configuration or if the daemon fails right after the readiness check; `Always` keeps retrying after a corrected variable |

No CLI flag for the restart policy exists in the Railway CLI 5.49.1 installed here (`railway --help`,
`service`, `variable` and `up` list none; `railway service restart` only restarts a deployment). The only
documented code route is `deploy.restartPolicyType` in `railway.json`/`railway.toml`, which is deprecated
(legacy services keep working until 2026-12-01) and would apply to both services if placed in this repository,
so none is shipped. Set it in the dashboard. Also set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` on the daemon:
Railway sends SIGTERM and force-stops after the draining time, and a daemon killed mid-write risks its chain
database. Railway's variables reference gives the default as `0` (its config-as-code example shows `10`), so
set it explicitly and confirm the value in the dashboard. It only controls the SIGTERM-to-SIGKILL window;
it does not guarantee the daemon finishes flushing, so check the logs for `Shutdown : done` after a redeploy.
Note that a pool redeploy that changes the pool's private address makes the daemon restart itself about a
minute later (see the allow-list section), which is also a shutdown that needs this window.

## Block journal and recovery

With `BLOCK_JOURNAL_PATH` set, every solved block is written before `submitblock` (`submitting`, with the
full block hex), again with its outcome, and re-checked with `getblock` every
`BLOCK_RECHECK_INTERVAL_SECONDS` until it has `BLOCK_RECHECK_CONFIRMATIONS` confirmations or
`BLOCK_RECHECK_MAX_HOURS` pass. Lines are JSON, one per state change:

- `accepted`: on the main chain when checked. A later `REORG` log line and a `side chain` or
  `unresolved` line mean it left the main chain. Nothing is ever labelled `rejected`, because "Block not
  found" and `"rejected"` do not prove invalidity on this daemon.
- `unresolved`: not in the index when checked. The line keeps the hex. Recovery: run `getblock <hash>` on
  every daemon; if all answer "Block not found" and the block's parent is still the tip, run
  `submitblock <hex>`.
- After a restart, unfinished blocks are re-checked and a warning lists them.

`ronpaulcoin-cli` exists in the daemon image (`railway ssh` into the daemon service). The journal is
append-only and not rotated; at mainnet block rates it stays small. It is not a backup of anything but
block outcomes.

## Backups and recovery

- **Daemon volume:** holds the chain only (no wallet). It can be rebuilt by re-syncing, which costs time
  and CPU; use Railway volume backups only if re-sync time matters.
- **Pool volume:** the journal. Back it up (`railway volume` tooling or periodic copy) if you rely on it.
- **Credentials:** rotate by changing both services' variables and redeploying the daemon first.

## Resources and cost (estimates, not measurements)

Pool and daemon resource use has not been measured on mainnet. Assumed: daemon about 1 GB RAM and 0.5
vCPU average, higher CPU during first sync; pool about 0.25 GB RAM and 0.1 vCPU. Railway rates at the
time of writing ([pricing](https://docs.railway.com/pricing/plans)): RAM $10/GB/month, CPU $20/vCPU/month,
volume $0.15/GB/month, egress $0.05/GB, Hobby plan $5/month with that amount credited to usage.
Rough monthly total: about $25-30 plus egress, dominated by the daemon. The chain size is unknown
because no mainnet data was downloaded; check the existing node's data directory size before choosing a
volume (Hobby volumes start at 5 GB and can be enlarged). Replicas cannot be used with volumes, so
neither service scales out, and redeploying a service with a volume has a short downtime.

## What was verified

- Railway RPC is reachable with the existing credentials; `getinfo` reports mainnet mode
  (`testnet=false`), block height 0 and zero connections. `getpeerinfo` is empty, and
  `getblocktemplate` fails with `RonPaulCoin is not connected!`. The pinned mainnet seed
  addresses were tried with `addnode ... onetry`; no peer connected. This is a live daemon
  observation, not evidence that the mainnet is unavailable everywhere.
- The idle pool placeholder has its `/data` journal volume, mainnet/RPC host/port variables and RPC credentials
  referenced from the daemon variables; the references were verified without displaying values. It has no
  source, deployment or `POOL_ADDRESS`. No TCP proxy is configured, and no Stratum listener is public.
- The active daemon RPC allow-list is restricted to a private-network range but is not yet specific to the
  pool service. The pool currently has no deployed private IP to allow-list.

- `docker build` of the pool image (root `Dockerfile`) and of the daemon `deploy` stage.
- The daemon entrypoint refuses missing variables, unsafe characters and unknown networks.
- A regtest daemon started by the entrypoint with its credentials in a 0600 file answers RPC; a second
  node peered to it; the pool image started against it, wrote its journal to a mounted volume, and a real
  cpuminer 2.5.1 mined blocks that both nodes accepted.
- Unit tests: `npm test` (181 passed). Regtest integration: `npm run test:integration` (52 passed).
- The scrypt implementation matched all five pinned-daemon header/hash vectors on Node.js 24
  running on ARM64.

## Not verified

Railway TCP proxy behavior and client-address forwarding, pool volume permissions with `RAILWAY_RUN_UID`,
the daemon's mainnet chain synchronization and a usable block template, a public Stratum endpoint,
any live mainnet miner or accepted share, ASIC or GPU behavior, and sustained load.
