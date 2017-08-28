/*
   Copyright 2016-2017 Smart-Tech Controle e Automação

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

module.exports = function(RED) {
    "use strict";

    var util = require('util');
    var nodepccc = require('nodepccc');
    var EventEmitter = require('events').EventEmitter;

    // ---------- pccc Endpoint ----------

    function createTranslationTable(vars) {
        var res = {};

        vars.forEach(function(elm) {
            res[elm.name] = elm.addr;
        });

        return res;
    }

    function generateStatus(status, val) {
        var obj;

        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._("pccc.endpoint.status.online");
        }

        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'badvalues':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._("pccc.endpoint.status.badvalues")
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._("pccc.endpoint.status.offline")
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._("pccc.endpoint.status.unknown")
                };
        }
        return obj;
    }

    function pcccEndpoint(config) {
        EventEmitter.call(this);
        var node = this;
        var oldValues = {};
        var connOpts;
        var status;
        var readInProgress = false;
        var readDeferred = false;
        var vars = config.vartable;
        var isVerbose = !!RED.settings.get('verbose');
        node.writeInProgress = false;
        node.writeQueue = [];

        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of pcccIn nodes
        this.setMaxListeners(0);

        connOpts = {
            host: config.address,
            port: config.port
        }

        if(config.userouting) {
            connOpts.routing = new Buffer((config.routing || '').replace(/(0x|,|\.)/g, ''), 'hex');
        }

        node._vars = createTranslationTable(vars);
        node._conn = new nodepccc({
            silent: !isVerbose,
            debug: isVerbose
        });
        node._conn.globalTimeout = parseInt(config.timeout) || 4500;

        node.getStatus = function getStatus() {
            return status;
        }

        node.writeVar = function writeVar(obj) {
            node.writeQueue.push(obj);

            if(!node.writeInProgress) {
                writeNext();
            }

        };

        function onWritten(err) {
            node.writeInProgress = false;

            writeNext();

            if (err) {
                manageStatus('badvalues');
                node.error(RED._("pccc.error.badvalues"));
                return;
            }

            manageStatus('online');
        }

        function writeNext() {
            var nextElm = node.writeQueue.shift();
            if(nextElm) {
                node._conn.writeItems(nextElm.name, nextElm.val, onWritten);
                node.writeInProgress = true;
            }
        }

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            node.emit('__STATUS__', {
                status: status
            });
        }

        function cycleCallback(err, values) {
            readInProgress = false;

            if(readDeferred) {
                doCycle();
                readDeferred = false;
            }

            if (err) {
                manageStatus('badvalues');
                node.error(RED._("pccc.error.badvalues"));
                return;
            }

            manageStatus('online');

            var changed = false;
            node.emit('__ALL__', values);
            Object.keys(values).forEach(function(key) {
                if (oldValues[key] !== values[key]) {
                    changed = true;
                    node.emit(key, values[key]);
                    node.emit('__CHANGED__', {key: key, value: values[key]});
                    oldValues[key] = values[key];
                }
            });
            if (changed) node.emit('__ALL_CHANGED__', values);
        }

        function doCycle() {
            if(!readInProgress) {
                node._conn.readAllItems(cycleCallback);
                readInProgress = true;
            } else {
                readDeferred = true;
            }
        }

        function onConnect(err) {
            if (err) {
                manageStatus('offline');
                node.error(RED._("pccc.error.onconnect") + err.toString());
                return;
            }

            manageStatus('online');

            node._conn.setTranslationCB(function(tag) {
                return node._vars[tag];
            });
            node._conn.addItems(Object.keys(node._vars));
            node._td = setInterval(doCycle, config.cycletime);
        }

        node.on('close', function(done) {
            clearInterval(node._td);
            node._conn.dropConnection(function() {
                done();
            });
        });

        manageStatus('offline');

        node._conn.initiateConnection(connOpts, onConnect);
    }
    RED.nodes.registerType("pccc endpoint", pcccEndpoint);

    // ---------- pccc In ----------

    function pcccIn(config) {
        var node = this;
        var statusVal;
        RED.nodes.createNode(this, config);

        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            return node.error(RED._("pccc.in.error.missingconfig"));
        }

        function sendMsg(data, key, status) {
            if (key === undefined) key = '';
            var msg = {
                payload: data,
                topic: key
            };
            statusVal = status !== undefined ? status : data;
            node.send(msg);
            node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        }

        function onChanged(variable) {
            sendMsg(variable.value, variable.key, null);
        }

        function onDataSplit(data) {
            Object.keys(data).forEach(function(key) {
                sendMsg(data[key], key, null)
            });
        }

        function onData(data) {
            sendMsg(data, config.mode == 'single' ? config.variable : '')
        }

        function onDataSelect(data) {
            onData(data[config.variable]);
        }

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));
        }

        node.endpoint.on('__STATUS__', onEndpointStatus);

        if (config.diff) {
            switch (config.mode) {
                case 'all-split':
                    node.endpoint.on('__CHANGED__', onChanged);
                    break;
                case 'single':
                    node.endpoint.on(config.variable, onData);
                    break;
                case 'all':
                default:
                    node.endpoint.on('__ALL_CHANGED__', onData);
            }
        } else {
            switch (config.mode) {
                case 'all-split':
                    node.endpoint.on('__ALL__', onDataSplit);
                    break;
                case 'single':
                    node.endpoint.on('__ALL__', onDataSelect);
                    break;
                case 'all':
                default:
                    node.endpoint.on('__ALL__', onData);
            }
        }

        node.on('close', function(done) {
            node.endpoint.removeListener('__ALL__', onDataSelect);
            node.endpoint.removeListener('__ALL__', onDataSplit);
            node.endpoint.removeListener('__ALL__', onData);
            node.endpoint.removeListener('__ALL_CHANGED__', onData);
            node.endpoint.removeListener('__CHANGED__', onChanged);
            node.endpoint.removeListener('__STATUS__', onEndpointStatus);
            node.endpoint.removeListener(config.variable, onData);
            done();
        });
    }
    RED.nodes.registerType("pccc in", pcccIn);

    // ---------- pccc Out ----------

    function pcccOut(config) {
        var node = this;
        var statusVal;
        RED.nodes.createNode(this, config);

        node.endpoint = RED.nodes.getNode(config.endpoint);
        if (!node.endpoint) {
            return node.error(RED._("pccc.in.error.missingconfig"));
        }

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));
        }

        function onNewMsg(msg) {
            var writeObj = {
                name: config.variable || msg.variable,
                val: msg.payload
            }

            if(!writeObj.name) return;

            statusVal = writeObj.val;
            node.endpoint.writeVar(writeObj);
            node.status(generateStatus(node.endpoint.getStatus(), statusVal));
        }

        node.on('input', onNewMsg);
        node.endpoint.on('__STATUS__', onEndpointStatus);

        node.on('close', function(done) {
            node.endpoint.removeListener('__STATUS__', onEndpointStatus);
            done();
        });
    }
    RED.nodes.registerType("pccc out", pcccOut);
};
