var http = require('http');
var cp = require('child_process');
var events = require('events');

var async = require('async');

var RPC_TIMEOUT_MS = 10000;
var MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * The daemon interface interacts with the coin daemon by using the rpc interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts rpc connections
 * - 'user'    : username of the coin for the rpc interface
 * - 'password': password for the rpc interface of the coin
**/

function DaemonInterface(daemons, logger){

    //private members
    var _this = this;
    logger = logger || function(severity, message){
        console.log(severity + ': ' + message);
    };


    var instances = (function(){
        for (var i = 0; i < daemons.length; i++){
            daemons[i]['index'] = i;
            Object.defineProperty(daemons[i], 'password', {
                value: daemons[i].password, enumerable: false, writable: true, configurable: true
            });
        }
        return daemons;
    })();


    function init(){
        isOnline(function(online){
            if (online)
                _this.emit('online');
        });
    }

    function isOnline(callback){
        cmd('getpeerinfo', [], function(results){
            var allOnline = results.every(function(result){
                return !result.error;
            });
            callback(allOnline);
            if (!allOnline)
                _this.emit('connectionFailed', results);
        });
    }


    /* Completes exactly once. Transport and protocol failures are reported as {type, message} where type is
       'offline' or 'request error' (retryable), or 'unauthorized', 'http error' or 'parse error' (not retryable).
       Errors returned by the daemon itself keep their JSON-RPC shape and have no type. */
    function performHttpRequest(instance, jsonData, callback){
        var timeoutMs = instance.timeoutMs || RPC_TIMEOUT_MS;
        var finished = false;
        var deadline;

        var finish = function(error, dataJson, data){
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            callback(error, dataJson, data);
        };

        var options = {
            hostname: (typeof(instance.host) === 'undefined' ? '127.0.0.1' : instance.host),
            port    : instance.port,
            method  : 'POST',
            auth    : instance.user + ':' + instance.password,
            /* A request written to a reused keep-alive socket whose peer has vanished stays in the kernel send
               queue after the deadline and can reach the daemon once the network returns, so a block the pool
               reported as unsubmitted could still be accepted later. A new connection never has queued data. */
            agent   : false,
            headers : {
                'Content-Length': Buffer.byteLength(jsonData),
                'Connection': 'close'
            }
        };

        var handleResponse = function(res, data){
            if (res.statusCode === 401 || res.statusCode === 403){
                logger('error', 'Unauthorized RPC access to daemon instance ' + instance.index + ' - invalid RPC username or password');
                return finish({type: 'unauthorized', message: 'HTTP ' + res.statusCode}, null);
            }

            var dataJson;
            try{
                dataJson = JSON.parse(data.indexOf(':-nan') !== -1 ? data.replace(/:-nan,/g, ':0,') : data);
            }
            catch(e){
                dataJson = undefined;
            }

            var isRpcPayload = dataJson !== null && typeof(dataJson) === 'object';
            var httpOk = res.statusCode >= 200 && res.statusCode < 300;

            if (isRpcPayload && (httpOk || dataJson.error))
                return finish(dataJson.error || null, dataJson, data);

            if (!httpOk)
                return finish({type: 'http error', message: 'HTTP ' + res.statusCode}, null);

            logger('error', 'Could not parse rpc data from daemon instance ' + instance.index);
            finish({type: 'parse error', message: 'Daemon returned an empty or malformed response'}, null);
        };

        var req = http.request(options, function(res) {
            var data = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                data += chunk;
                if (data.length > MAX_RESPONSE_BYTES){
                    finish({type: 'parse error', message: 'Daemon response exceeded ' + MAX_RESPONSE_BYTES + ' bytes'}, null);
                    req.destroy();
                }
            });
            res.on('end', function(){
                handleResponse(res, data);
            });
            res.on('aborted', function(){
                finish({type: 'request error', message: 'Connection closed before the response completed'}, null);
            });
            res.on('error', function(e){
                finish({type: 'request error', message: e.message}, null);
            });
        });

        deadline = setTimeout(function(){
            finish({type: 'request error', message: 'RPC request timed out after ' + timeoutMs + ' ms'}, null);
            req.destroy();
        }, timeoutMs);

        req.on('error', function(e) {
            if (e.code === 'ECONNREFUSED')
                finish({type: 'offline', message: e.message}, null);
            else
                finish({type: 'request error', message: e.message}, null);
        });

        req.end(jsonData);
    }



    //Performs a batch JSON-RPC command - only uses the first configured rpc daemon
    /* First argument must have:
     [
         [ methodName, [params] ],
         [ methodName, [params] ]
     ]
     */

    function batchCmd(cmdArray, callback){

        var requestJson = [];

        for (var i = 0; i < cmdArray.length; i++){
            requestJson.push({
                method: cmdArray[i][0],
                params: cmdArray[i][1],
                id: Date.now() + Math.floor(Math.random() * 10) + i
            });
        }

        var serializedRequest = JSON.stringify(requestJson);

        performHttpRequest(instances[0], serializedRequest, function(error, result){
            callback(error, result);
        });

    }

    /* Sends a JSON RPC (http://json-rpc.org/wiki/specification) command to every configured daemon.
       The callback function is fired once with the result from each daemon unless streamResults is
       set to true. */
    function cmd(method, params, callback, streamResults, returnRawData){

        var results = [];

        async.each(instances, function(instance, eachCallback){

            var itemFinished = function(error, result, data){

                var returnObj = {
                    error: error,
                    response: (result || {}).result,
                    instance: instance
                };
                if (returnRawData) returnObj.data = data;
                if (streamResults) callback(returnObj);
                else results.push(returnObj);
                eachCallback();
                itemFinished = function(){};
            };

            var requestJson = JSON.stringify({
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10)
            });

            performHttpRequest(instance, requestJson, function(error, result, data){
                itemFinished(error, result, data);
            });


        }, function(){
            if (!streamResults){
                callback(results);
            }
        });

    }


    //public members

    this.init = init;
    this.isOnline = isOnline;
    this.cmd = cmd;
    this.batchCmd = batchCmd;
}

DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;

exports.interface = DaemonInterface;
