var net = require('net');
var events = require('events');

var util = require('./util.js');

var monotonicMs = function(){ return Number(process.hrtime.bigint() / 1000000n); };


var SubscriptionCounter = function(){
    var count = 0;
    var padding = 'deadbeefcafebabe';
    return {
        next: function(){
            count++;
            if (Number.MAX_VALUE === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Defining each client that connects to the stratum server. 
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
**/
var StratumClient = function(options){
    var pendingDifficulty = null;
    //private members
    this.socket = options.socket;

    this.remoteAddress = options.socket.remoteAddress;

    var banning = options.banning;

    var _this = this;

    this.lastActivity = Date.now();

    this.shares = {valid: 0, invalid: 0};

    var considerBan = (!banning || !banning.enabled) ? function(){ return false } : function(shareValid){
        if (shareValid === true) _this.shares.valid++;
        else _this.shares.invalid++;
        var totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold){
            var percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent) //reset shares
                _this.shares = {valid: 0, invalid: 0};
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    var protocolErrors = 0;

    /* Counts behaviour no well-behaved miner produces; returns true when the connection was closed. */
    function recordProtocolError(){
        if (_this.socket.destroyed) return true;
        protocolErrors++;
        if (options.maxProtocolErrors > 0 && protocolErrors >= options.maxProtocolErrors){
            _this.emit('protocolErrorLimit', protocolErrors);
            _this.socket.destroy();
            return true;
        }
        return false;
    }

    function startHandshakeTimer(){
        if (!(options.handshakeTimeout > 0)) return;
        var timer = setTimeout(function(){
            if (_this.authorized && _this.extraNonce1) return;
            _this.emit('handshakeTimeout');
            _this.socket.destroy();
        }, options.handshakeTimeout * 1000);
        _this.socket.once('close', function(){ clearTimeout(timer); });
    }

    this.init = function init(){
        setupSocket();
        startHandshakeTimer();
    };

    function hasRequestId(message){
        return message.id !== undefined && message.id !== null;
    }

    function replyUnsupported(message){
        if (hasRequestId(message))
            sendJson({id: message.id, result: null, error: [20, "Unsupported method", null]});
    }

    /* BIP310: a server that supports none of the requested extensions answers each one with false. */
    function handleConfigure(message){
        var result = Object.create(null);
        if (Array.isArray(message.params[0])){
            message.params[0].forEach(function(name){
                if (typeof name === 'string') result[name] = false;
            });
        }
        sendJson({id: message.id, result: result, error: null});
    }

    function handleMessage(message){
        if (!Array.isArray(message.params)) message.params = [];
        switch(message.method){
            case 'mining.subscribe':
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                handleAuthorize(message, true /*reply to socket*/);
                break;
            case 'mining.submit':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.configure':
                handleConfigure(message);
                break;
            case 'mining.extranonce.subscribe':
                sendJson({id: message.id, result: false, error: [20, "mining.extranonce.subscribe is not supported", null]});
                break;
            case 'mining.get_transactions':
            case 'mining.suggest_difficulty':
            case 'mining.suggest_target':
                replyUnsupported(message);
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                replyUnsupported(message);
                recordProtocolError();
                break;
        }
    }

    function handleSubscribe(message){
        if (_this.extraNonce1 && recordProtocolError()) return;
        if (! _this._authorized ) {
            _this.requestedSubscriptionBeforeAuth = true;
        }
        _this.emit('subscription',
            {},
            function(error, extraNonce1, extraNonce2Size){
                if (error){
                    sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }
                _this.extraNonce1 = extraNonce1;
                sendJson({
                    id: message.id,
                    result: [
                        [
                            ["mining.set_difficulty", options.subscriptionId],
                            ["mining.notify", options.subscriptionId]
                        ],
                        extraNonce1,
                        extraNonce2Size
                    ],
                    error: null
                });
            }
        );
    }

    function handleAuthorize(message, replyToSocket){
        _this.workerName = message.params[0];
        _this.workerPass = message.params[1];
        options.authorizeFn(_this.remoteAddress, options.socket.localPort, _this.workerName, _this.workerPass, function(result) {
            _this.authorized = (!result.error && result.authorized);
            
            if (replyToSocket) {
                sendJson({
                        id     : message.id,
                        result : _this.authorized,
                        error  : result.error
                    });
            }

            if (replyToSocket && !_this.authorized && recordProtocolError()) return;

            // If the authorizer wants us to close the socket lets do it.
            if (result.disconnect === true) {
                options.socket.destroy();
            }
        });
    }

    function handleSubmit(message){
        if (!_this.authorized){
            sendJson({
                id    : message.id,
                result: null,
                error : [24, "unauthorized worker", null]
            });
            if (!recordProtocolError()) considerBan(false);
            return;
        }
        if (!_this.extraNonce1){
            sendJson({
                id    : message.id,
                result: null,
                error : [25, "not subscribed", null]
            });
            if (!recordProtocolError()) considerBan(false);
            return;
        }
        if (message.params.length < 5 || !message.params.slice(0, 5).every(function(p){ return typeof p === 'string'; })){
            sendJson({
                id    : message.id,
                result: null,
                error : [20, "malformed submission", null]
            });
            if (!recordProtocolError()) considerBan(false);
            return;
        }
        _this.emit('submit',
            {
                name        : _this.workerName,
                jobId       : message.params[1],
                extraNonce2 : message.params[2],
                nTime       : message.params[3],
                nonce       : message.params[4]
            },
            function(error, result){
                if (!considerBan(result)){
                    sendJson({
                        id: message.id,
                        result: result,
                        error: error
                    });
                }
            }
        );
        
    }

    function sendJson(){
        var socket = options.socket;
        if (socket.destroyed) return;
        var response = '';
        for (var i = 0; i < arguments.length; i++){
            response += JSON.stringify(arguments[i]) + '\n';
        }
        socket.write(response);
        if (options.maxOutputBuffer > 0 && socket.writableLength > options.maxOutputBuffer){
            _this.emit('outputBufferLimit', socket.writableLength);
            socket.destroy();
        }
    }

    var windowStart = -Infinity;
    var windowCount = 0;

    /* Fixed window over every received line, so it needs no timer; returns true when the connection was closed. */
    function rateLimitExceeded(){
        if (!(options.messageRateLimit > 0)) return false;
        var now = monotonicMs();
        if (now - windowStart >= options.messageRateWindow * 1000){
            windowStart = now;
            windowCount = 0;
        }
        if (++windowCount <= options.messageRateLimit) return false;
        _this.emit('rateLimitExceeded', windowCount);
        _this.socket.destroy();
        return true;
    }

    function setupSocket(){
        var socket = options.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        if (options.tcpProxyProtocol === true) {
            socket.once('data', function (d) {
                if (d.indexOf('PROXY') === 0) {
                    _this.remoteAddress = d.split(' ')[2];
                }
                else{
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        }
        else{
            _this.emit('checkBan');
        }
        socket.on('data', function(d){
            dataBuffer += d;
            var messages = dataBuffer.split('\n');
            var incomplete = messages.pop();
            if (Buffer.byteLength(incomplete, 'utf8') > 10240){ //10KB for a single unfinished message
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (messages.length > 0){
                messages.forEach(function(message){
                    if (socket.destroyed || rateLimitExceeded() || message === '') return;
                    if (Buffer.byteLength(message, 'utf8') > 10240){
                        _this.emit('socketFlooded');
                        socket.destroy();
                        return;
                    }
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch(e) {
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0){
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }
                        return;
                    }

                    if (messageJson) {
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function() {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function(err){
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }


    this.getLabel = function(){
        return String(_this.workerName || '(unauthorized)').slice(0, 64) + ' [' + _this.remoteAddress + ']';
    };

    this.enqueueNextDifficulty = function(requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    //public members

    /**
     * IF the given difficulty is valid and new it'll send it to the client.
     * returns boolean
     **/
    this.sendDifficulty = function(difficulty){
        if (difficulty === this.difficulty)
            return false;

        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;
        sendJson({
            id    : null,
            method: "mining.set_difficulty",
            params: [difficulty]//[512],
        });
        return true;
    };

    this.sendMiningJob = function(jobParams){

        var lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000){
            _this.emit('socketTimeout', 'last submitted a share was ' + (lastActivityAgo / 1000 | 0) + ' seconds ago');
            _this.socket.destroy();
            return;
        }

        if (pendingDifficulty !== null){
            var result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }
        sendJson({
            id    : null,
            method: "mining.notify",
            params: jobParams
        });

    };

    this.manuallyAuthClient = function (username, password) {
        handleAuthorize({id: 1, params: [username, password]}, false /*do not reply to miner*/);
    };

    this.manuallySetValues = function (otherClient) {
        _this.extraNonce1        = otherClient.extraNonce1;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty         = otherClient.difficulty;
    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;




/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
var StratumServer = exports.Server = function StratumServer(options, authorizeFn){

    //private members

    //ports, connectionTimeout, jobRebroadcastTimeout, banning, haproxy, authorizeFn

    var bannedMS = options.banning ? options.banning.time * 1000 : null;

    var _this = this;
    var stratumClients = {};
    var subscriptionCounter = SubscriptionCounter();
    var rebroadcastTimeout;
    var bannedIPs = {};
    var connectionsByIp = {};
    var totalConnections = 0;

    function normalizeAddress(address){
        return typeof address === 'string' ? address.replace(/^::ffff:/i, '') : 'unknown';
    }

    function connectionLimitReached(ip){
        if (options.maxConnections > 0 && totalConnections >= options.maxConnections)
            return 'server connection limit of ' + options.maxConnections + ' reached';
        if (options.maxConnectionsPerIp > 0 && (connectionsByIp[ip] || 0) >= options.maxConnectionsPerIp)
            return 'limit of ' + options.maxConnectionsPerIp + ' connections per address reached';
        return null;
    }


    function checkBan(client){
        if (options.banning && options.banning.enabled && client.remoteAddress in bannedIPs){
            var bannedTime = bannedIPs[client.remoteAddress];
            var bannedTimeAgo = Date.now() - bannedTime;
            var timeLeft = bannedMS - bannedTimeAgo;
            if (timeLeft > 0){
                client.socket.destroy();
                client.emit('kickedBannedIP', timeLeft / 1000 | 0);
            }
            else {
                delete bannedIPs[client.remoteAddress];
                client.emit('forgaveBannedIP');
            }
        }
    }

    this.handleNewClient = function (socket){

        var ip = normalizeAddress(socket.remoteAddress);
        var rejection = connectionLimitReached(ip);
        if (rejection){
            socket.destroy();
            _this.emit('connectionRejected', ip, rejection);
            return null;
        }
        totalConnections++;
        connectionsByIp[ip] = (connectionsByIp[ip] || 0) + 1;

        socket.setKeepAlive(true);
        var subscriptionId = subscriptionCounter.next();
        var client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                authorizeFn: authorizeFn,
                socket: socket,
                banning: options.banning,
                connectionTimeout: options.connectionTimeout,
                tcpProxyProtocol: options.tcpProxyProtocol,
                maxProtocolErrors: options.maxProtocolErrors,
                handshakeTimeout: options.handshakeTimeout,
                messageRateLimit: options.messageRateLimit,
                messageRateWindow: options.messageRateWindow,
                maxOutputBuffer: options.maxOutputBuffer
            }
        );

        stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);
        client.on('socketDisconnect', function() {
            _this.removeStratumClientBySubId(subscriptionId);
            totalConnections--;
            if (--connectionsByIp[ip] <= 0) delete connectionsByIp[ip];
            _this.emit('client.disconnected', client);
        }).on('checkBan', function(){
            checkBan(client);
        }).on('triggerBan', function(){
            if (bannedMS > 0) _this.addBannedIP(client.remoteAddress);
        }).init();
        return subscriptionId;
    };


    this.broadcastMiningJobs = function(jobParams){
        for (var clientId in stratumClients) {
            var client = stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }
        /* Some miners will consider the pool dead if it doesn't receive a job for around a minute.
           So every time we broadcast jobs, set a timeout to rebroadcast in X seconds unless cleared. */
        scheduleRebroadcast();
    };

    /* The timer re-arms itself so that a failed template refresh (daemon outage) does not stop rebroadcasts. */
    function scheduleRebroadcast(){
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(function(){
            _this.emit('broadcastTimeout');
            scheduleRebroadcast();
        }, options.jobRebroadcastTimeout * 1000);
    }



    (function init(){

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (options.banning && options.banning.enabled){
            setInterval(function(){
                for (ip in bannedIPs){
                    var banTime = bannedIPs[ip];
                    if (Date.now() - banTime > options.banning.time)
                        delete bannedIPs[ip];
                }
            }, 1000 * options.banning.purgeInterval).unref();
        }


        //SetupBroadcasting();


        var serversStarted = 0;
        Object.keys(options.ports).forEach(function(port){
            net.createServer({allowHalfOpen: false}, function(socket) {
                _this.handleNewClient(socket);
            }).listen(parseInt(port), function() {
                serversStarted++;
                if (serversStarted == Object.keys(options.ports).length)
                    _this.emit('started');
            });
        });
    })();


    //public members

    this.addBannedIP = function(ipAddress){
        bannedIPs[ipAddress] = Date.now();
        /*for (var c in stratumClients){
            var client = stratumClients[c];
            if (client.remoteAddress === ipAddress){
                _this.emit('bootedBannedWorker');
            }
        }*/
    };

    this.getStratumClients = function () {
        return stratumClients;
    };

    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    this.manuallyAddStratumClient = function(clientObj) {
        var subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) { // not banned!
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };

};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
