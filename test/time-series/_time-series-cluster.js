// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var tapeCluster = require('tape-cluster');
var setTimeout = require('timers').setTimeout;
var parallel = require('run-parallel');
var tape = require('tape');
var nodeAssert = require('assert');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var process = require('process');
var metrics = require('metrics');

var HyperbahnCluster = require('../lib/test-cluster.js');

var startOfFile = Date.now();

TimeSeriesCluster.test = tapeCluster(tape, TimeSeriesCluster);

TimeSeriesCluster.buildString = function buildString(size) {
    var tempArray = [];

    for (var i = 0; i < size; i++) {
        tempArray.push('A');
    }

    return tempArray.join('');
};

module.exports = TimeSeriesCluster;

function TimeSeriesCluster(opts) {
    /* eslint max-statements: [2, 40] */
    if (!(this instanceof TimeSeriesCluster)) {
        return new TimeSeriesCluster(opts);
    }

    var self = this;

    nodeAssert(opts && opts.buckets, 'requires buckets');
    nodeAssert(opts && opts.clientTimeout, 'requires clientTimeout');
    nodeAssert(opts && opts.endpointToRequest, 'requires endpointToRequest');
    self.buckets = opts.buckets;
    self.clientTimeout = opts.clientTimeout;
    self.endpointToRequest = opts.endpointToRequest;

    self.clientBatchDelay = opts.clientBatchDelay || 100;
    self.numBatchesInBucket = opts.numBatchesInBucket || 5;
    self.clientRequestsPerBatch = opts.clientRequestsPerBatch || 15;
    self.serverInstances = opts.serverInstances || 10;
    self.clientInstances = opts.clientInstances || 5;
    self.requestBody = opts.requestBody || '';

    self.serverServiceName = 'time-series-server';
    self.clientServiceName = 'time-series-client';

    self.namedRemotes = [];
    for (var sIndex = 0; sIndex < self.serverInstances; sIndex++) {
        self.namedRemotes.push(self.serverServiceName);
    }
    for (var cIndex = 0; cIndex < self.clientInstances; cIndex++) {
        self.namedRemotes.push(self.clientServiceName);
    }

    self.clusterOptions = null;
    self.setupClusterOptions(opts);

    self._cluster = HyperbahnCluster(self.clusterOptions);
    self.logger = self._cluster.logger;

    self.timeWindow = TimeWindow({
        start: Date.now(),

        buckets: self.buckets,
        interval: self.clientBatchDelay * self.numBatchesInBucket
    });

    self.batchClient = null;
}

TimeSeriesCluster.prototype.setupClusterOptions =
function setupClusterOptions(opts) {
    var self = this;

    self.clusterOptions = opts.cluster || {};
    if (!self.clusterOptions.size) {
        self.clusterOptions.size = 10;
    }
    if (!self.clusterOptions.remoteConfig) {
        self.clusterOptions.remoteConfig = {};
    }
    if (!self.clusterOptions.remoteConfig['kValue.default']) {
        self.clusterOptions.remoteConfig['kValue.default'] = 4;
    }
    if (!('rateLimiting.enabled' in self.clusterOptions.remoteConfig)) {
        self.clusterOptions.remoteConfig['rateLimiting.enabled'] = false;
    }
    self.clusterOptions.namedRemotes = self.namedRemotes;
    if (!('hyperbahn.circuits' in self.clusterOptions.remoteConfig)) {
        self.clusterOptions.remoteConfig['hyperbahn.circuits'] = {
            period: 100,
            maxErrorRate: 0.5,
            minRequests: 5,
            probation: 5,
            enabled: false
        };
    }
};

TimeSeriesCluster.prototype.bootstrap = function bootstrap(cb) {
    var self = this;

    self._cluster.logger.whitelist(
        'info', '[remote-config] config file changed'
    );

    self._cluster.bootstrap(onCluster);

    function onCluster(err) {
        if (err) {
            return cb(err);
        }

        var serverRemotes = self._cluster.namedRemotes.slice(
            0, self.serverInstances
        );

        for (var i = 0; i < serverRemotes.length; i++) {
            TimeSeriesRemote(serverRemotes[i], self.timeWindow, 'remote ' + i);
        }

        var clientRemotes = self._cluster.namedRemotes.slice(
            self.serverInstances, self.serverInstances + self.clientInstances
        );

        self.batchClient = BatchClient({
            remotes: clientRemotes,
            requestsPerBatch: self.clientRequestsPerBatch,
            clientBatchDelay: self.clientBatchDelay,
            clientTimeout: self.clientTimeout,
            numBatchesInBucket: self.numBatchesInBucket,
            numBuckets: self.buckets.length,
            endpoint: self.endpointToRequest,
            clientServiceName: self.clientServiceName,
            serverServiceName: self.serverServiceName,
            body: self.requestBody
        });

        cb(null);
    }
};

TimeSeriesCluster.prototype.sendRequests = function sendRequests(cb) {
    var self = this;

    self.timeWindow.setTimer();
    self.batchClient.sendRequests(Date.now(), cb);
};

TimeSeriesCluster.prototype.close = function close(cb) {
    var self = this;

    self._cluster.close(cb);
};

TimeSeriesCluster.prototype.assertRange = function assertRange(assert, options) {
    assert.ok(options.value >= options.min,
        'count (' + options.value + ') for ' +
        'reqs with timeout of ' + options.name +
        ' should have >= ' + options.min + ' errors');
    assert.ok(options.value <= options.max,
        'count (' + options.value + ') for ' +
        'reqs with timeout of ' + options.name +
        ' should have <= ' + options.max + ' errors');
};

function BatchClient(options) {
    if (!(this instanceof BatchClient)) {
        return new BatchClient(options);
    }

    var self = this;
    EventEmitter.call(self);

    self.serverServiceName = options.serverServiceName;
    self.clientServiceName = options.clientServiceName;
    self.requestsPerBatch = options.requestsPerBatch;
    self.clientBatchDelay = options.clientBatchDelay;
    self.numBuckets = options.numBuckets;

    self.numBatchesInBucket = options.numBatchesInBucket;

    self.clientTimeout = options.clientTimeout;
    self.endpoint = options.endpoint;

    self.timeWindow = options.timeWindow;
    self.channels = [];
    for (var i = 0; i < options.remotes.length; i++) {
        self.channels.push(options.remotes[i].clientChannel);
    }

    self.requestVolume = self.numBuckets * (
        self.numBatchesInBucket * self.requestsPerBatch
    );

    self.body = options.body || '';
    self.requestOptions = {
        serviceName: self.serverServiceName,
        timeout: self.clientTimeout,
        headers: {
            'as': 'raw',
            'cn': self.clientServiceName
        }
    };

    self.freeList = new Array(self.requestVolume);
    for (var j = 0; j < self.requestVolume; j++) {
        self.freeList[j] = new BatchClientRequestResult();
    }
}
util.inherits(BatchClient, EventEmitter);

BatchClient.prototype.sendRequests = function sendRequests(now, cb) {
    var self = this;

    var loop = new BatchClientLoop(now, self, cb);
    loop.runNext();
};

function BatchClientLoop(now, batchClient, onFinish) {
    var self = this;

    self.batchClient = batchClient;
    self.startTime = now;
    self.onFinish = onFinish;

    self.resultBuckets = new Array(self.batchClient.numBuckets);
    self.bucketIndex = 0;
    self.currentBatch = 0;
    self.responseCounter = 0;

    var size = self.batchClient.requestsPerBatch * self.batchClient.numBatchesInBucket;
    for (var k = 0; k < self.batchClient.numBuckets; k++) {
        self.resultBuckets[k] = new BatchClientResult(size);
    }

    self.boundSendRequest = boundSendRequest;
    self.boundRunAgain = boundRunAgain;

    function boundSendRequest(callback) {
        self.batchClient._sendRequest(callback);
    }

    function boundRunAgain() {
        self.runNext();
    }
}

BatchClientLoop.prototype.runNext = function runNext() {
    var self = this;

    if (self.bucketIndex >= self.batchClient.numBuckets) {
        return null;
    }

    var thunks = [];
    for (var i = 0; i < self.batchClient.requestsPerBatch; i++) {
        thunks.push(self.boundSendRequest);
    }

    var batchResult = self.resultBuckets[self.bucketIndex];

    self.batchClient.emit('batch-updated', {
        index: self.bucketIndex,
        batch: batchResult
    });
    batchResult.touch();

    self.currentBatch += 1;
    if (self.currentBatch % self.batchClient.numBatchesInBucket === 0) {
        self.bucketIndex++;
    }

    parallel(thunks, onResults);

    var targetTime = self.startTime + (
        self.currentBatch * self.batchClient.clientBatchDelay
    );
    var delta = targetTime - Date.now();

    setTimeout(self.boundRunAgain, delta);

    function onResults(err, responses) {
        if (err) {
            return self.onFinish(err);
        }

        for (var j = 0; j < responses.length; j++) {
            self.responseCounter++;
            batchResult.push(responses[j]);
        }

        if (self.responseCounter >= self.batchClient.requestVolume) {
            self.onFinish(null, self.resultBuckets);
        }
    }
};

BatchClient.prototype._sendRequest = function _sendRequest(cb) {
    var self = this;

    var start = Date.now();
    var randomClient = self.channels[
        Math.floor(Math.random() * self.channels.length)
    ];

    var req = randomClient.request(self.requestOptions);
    req.send(self.endpoint, '', self.body, onResponse);

    function onResponse(err, resp) {
        var result = self.freeList.pop();

        result.error = err || null;
        result.responseOk = resp ? resp.ok : false;
        result.duration = Date.now() - start;

        // console.log('got response', {
        //     err: !!err
        // });
        cb(null, result);
    }
};

function BatchClientRequestResult() {
    var self = this;

    self.error = null;
    self.responseOk = null;
    self.duration = null;
}

function asMegaBytes(num) {
    return Math.ceil(num / (1024 * 1024));
}

function BatchClientResult(size) {
    if (!(this instanceof BatchClientResult)) {
        return new BatchClientResult(size);
    }

    var self = this;

    self._results = new Array(size);

    self.totalCount = 0;
    self.errorCount = 0;
    self.successCount = 0;
    self.timeoutCount = 0;
    self.declinedCount = 0;

    self.byType = {};

    self.processMetrics = {
        rss: null,
        heapTotal: null,
        heapUsed: null
    };
    self._latencyHistogram = new metrics.Histogram();
}

BatchClientResult.prototype.touch = function touch() {
    var self = this;

    var memoryUsage = process.memoryUsage();

    self.processMetrics.rss = asMegaBytes(memoryUsage.rss);
    self.processMetrics.heapTotal = asMegaBytes(memoryUsage.heapTotal);
    self.processMetrics.heapUsed = asMegaBytes(memoryUsage.heapUsed);
};

BatchClientResult.prototype.push = function push(result) {
    var self = this;

    self._results.push(result);
    self._latencyHistogram.update(result.duration);

    self.totalCount++;
    if (result.error) {
        self.errorCount++;

        if (self.byType[result.error.type] === undefined) {
            self.byType[result.error.type] = 0;
        }
        self.byType[result.error.type]++;
        // console.log('err type', result.error.type);
    } else {
        self.successCount++;
    }
};

BatchClientResult.prototype.inspect = function inspect() {
    var self = this;

    var latencyObject = self._latencyHistogram.printObj();

    return require('util').inspect({
        totalCount: self.totalCount,
        errorCount: self.errorCount,
        successCount: self.successCount,
        timeoutCount: self.timeoutCount,
        declinedCount: self.declinedCount,
        byType: self.byType,
        processMetrics: self.processMetrics,
        secondsElapsed: Math.ceil((Date.now() - startOfFile) / 1000),
        latency: {
            min: latencyObject.min,
            median: latencyObject.median,
            p75: Math.ceil(latencyObject.p75),
            p95: Math.ceil(latencyObject.p95),
            p99: Math.ceil(latencyObject.p99),
            max: latencyObject.max
        }
    });
};

function TimeSeriesRemote(remote, timers, name) {
    if (!(this instanceof TimeSeriesRemote)) {
        return new TimeSeriesRemote(remote, timers, name);
    }

    var self = this;

    self.timers = timers;
    self.channel = remote.serverChannel;
    self.name = name;

    self.channel.register('slow-endpoint', slowEndpoint);
    self.channel.register('echo-endpoint', echoEndpoint);
    self.channel.register('health-endpoint', healthEndpoint);

    function slowEndpoint(req, res, arg2, arg3) {
        self.slowEndpoint(req, res, arg2, arg3);
    }

    function echoEndpoint(req, res, arg2, arg3) {
        self.echoEndpoint(req, res, arg2, arg3);
    }

    function healthEndpoint(req, res, arg2, arg3) {
        self.healthEndpoint(req, res, arg2, arg3);
    }
}

TimeSeriesRemote.prototype.echoEndpoint =
function echoEndpoint(req, res, arg2, arg3) {
    res.headers.as = 'raw';
    res.sendOk(arg2, arg3);
};

TimeSeriesRemote.prototype.healthEndpoint = function healthEndpoint(req, res) {
    var self = this;

    res.headers.as = 'raw';
    res.sendOk('', 'served by ' + self.name);
};

TimeSeriesRemote.prototype.slowEndpoint = function slowEndpoint(req, res) {
    var self = this;

    var delay = self.fuzzedDelay(self.timers.now());
    // console.log('delay?', delay);
    setTimeout(respond, delay);

    function respond() {
        res.headers.as = 'raw';
        res.sendOk('', 'served by ' + self.name);
    }
};

// time +- 25%
TimeSeriesRemote.prototype.fuzzedDelay = function fuzzedDelay(time) {
    var rand = Math.floor((Math.random() - 0.5) * (time / 2));

    return time + rand;
};

function TimeWindow(options) {
    if (!(this instanceof TimeWindow)) {
        return new TimeWindow(options);
    }

    var self = this;

    self.start = options.start;
    self.buckets = options.buckets;
    self.interval = options.interval;

    self.index = 0;
    self.currentTime = self.buckets[self.index];

    self.boundAdvance = boundAdvance;

    function boundAdvance() {
        self.advance();
    }
}

TimeWindow.prototype.setTimer = function setTimer() {
    var self = this;

    setTimeout(self.boundAdvance, self.interval);
};

TimeWindow.prototype.advance = function advance() {
    var self = this;

    self.index++;

    self.currentTime = self.buckets[self.index];

    if (self.index < self.buckets.length) {
        self.setTimer();
    }
};

TimeWindow.prototype.now = function now() {
    var self = this;

    return self.currentTime;
};