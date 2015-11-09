'use strict';

var Scheduler      = require('./scheduler');
var Transport      = require('../transport/transport');
var Channel        = require('./channel');
var PublisherMixin = require('../mixins/publisher');
var TransportPool  = require('./transport-pool');
var uri            = require('../util/uri');
var extend         = require('../util/externals').extend;
var debug          = require('debug')('halley:dispatcher');
var Promise        = require('bluebird');
var globalEvents   = require('../util/global-events');

var MAX_REQUEST_SIZE = 2048;

/**
 * The dispatcher sits between the client and the transport.
 *
 * It's responsible for tracking sending messages to the transport,
 * tracking in-flight messages
 */
function Dispatcher(endpoint, advice, options) {
  this._advice = advice;
  this._envelopes = {};
  this._scheduler = options.scheduler || Scheduler;
  this._state = 0;
  this._pool = new TransportPool(this, uri.parse(endpoint), advice, options.disabled, Transport.getRegisteredTransports());
  this.maxRequestSize = MAX_REQUEST_SIZE;

  this.listenTo(globalEvents, 'beforeunload', this.disconnecting);
}

Dispatcher.prototype = {

  UP: 1,
  DOWN: 2,

  destroy: function() {
    debug('destroy');

    this.stopListening();
    this.disconnecting();
    this.close();
  },

  /**
   * Called when the client no longer wants the dispatcher to reopen
   * the connection after a disconnect
   */
  disconnecting: function() {
    debug('disconnecting');
    this._pool.closing();
  },

  close: function() {
    debug('_close');

    this._cancelPending();

    debug('Dispatcher close requested');
    this._pool.close();
  },

  _cancelPending: function() {
    debug('_cancelPending');

    var envelopes = this._envelopes;
    this._envelopes = {};
    Object.keys(envelopes).forEach(function(id) {
      var envelope = envelopes[id];
      envelope.promise.cancel();
    }, this);
  },

  getConnectionTypes: function() {
    return Transport.getConnectionTypes();
  },

  selectTransport: function(allowedTransportTypes, cleanup) {
    return this._pool.setAllowed(allowedTransportTypes, cleanup);
  },

  /**
   * Returns a promise of the response
   */
  sendMessage: function(message, timeout, options) {
    debug('sendMessage: message=%j, timeout = %s, options=%j', message, timeout, options);
    var id = message.id;
    var envelope = this._envelopes[id];

    // Already inflight
    if (envelope) {
      debug('sendMessage: already in-flight');
      return envelope.promise;
    }

    envelope = this._envelopes[id] = {};

    var scheduler = new this._scheduler(message, {
      timeout: timeout,
      interval: this._advice.retry,
      attempts: options && options.attempts
    });

    var promise = envelope.promise = this._attemptSend(envelope, message, scheduler)
      .bind(this)
      .timeout(options && options.deadline || 60000)
      .then(function(response) {
        scheduler.succeed();
        return response;
      })
      .catch(function(err) {
        scheduler.abort();
        throw err;
      })
      .finally(function() {
        debug('sendMessage complete: message=%j', message);
        delete this._envelopes[id];
      });

    return promise;
  },

  _attemptSend: function(envelope, message, scheduler) {
    if (!scheduler.isDeliverable()) {
      return Promise.reject(new Error('No longer deliverable'));
    }

    scheduler.send();
    return this._pool.get()
      .bind(this)
      .timeout(scheduler.getTimeout())
      .then(function(transport) {

        if (message.channel === Channel.CONNECT) {
          message.connectionType = transport.connectionType;
        }

        // If the response didn't win the race we know that we have a
        // transport
        var responsePromise = new Promise(function(resolve) {
          envelope.resolve = resolve;
        })
        .finally(function() {
          envelope.resolve = null;
        });

        var sendPromise = transport.sendMessage(message)
          .then(function() {
            // Note that if the send has other listeners
            // for example on batched transports, we need to
            // chain the promise in order to prevent other
            // listeners from being cancelled.
            // In other words, the send will only
            // cancel if all the subscribers cancel it
          });

        return Promise.join(responsePromise, sendPromise, function(response) {
            return response;
          })
          .timeout(scheduler.getTimeout())
          .catch(Promise.TimeoutError, function(err) {
            // Cancel the send
            sendPromise.cancel();

            throw err;
          });
      })
      .catch(function(e) {
        debug('Error while attempting to send message: %j: %s', message, e);

        scheduler.fail();

        if (!scheduler.isDeliverable()) {
          throw e;
        }
        // Either the send timed out or no transport was
        // available. Either way, wait for the interval and try again
        return this._awaitRetry(envelope, message, scheduler);
      });

  },

  /**
   * Send has failed. Retry after interval
   */
  _awaitRetry: function(envelope, message, scheduler) {
    // Either no transport is available or a timeout occurred waiting for
    // the transport. Wait a bit, the try again
    return Promise.delay(scheduler.getInterval())
      .bind(this)
      .then(function() {
        return this._attemptSend(envelope, message, scheduler);
      });

  },

  handleResponse: function(reply) {
    debug('handleResponse %j', reply);

    var envelope = this._envelopes[reply.id];

    if (reply.successful !== undefined && envelope) {
      if (envelope.resolve) {
        // This is a response to a message we fired.
        envelope.resolve(reply);
      }
    } else {
      // Distribe this message through channels
      // Don't trigger a message if this is a reply
      // to a request, otherwise it'll pass
      // through the extensions twice
      this.trigger('message', reply);
    }

    if (this._state === this.UP) return;
    this._state = this.UP;
    this.trigger('transport:up');
  },

  /**
   * Currently, this only gets called by streaming transports (websocket)
   * and let's the dispatcher know that the connection is unavailable
   * so it needs to switch to an alternative transport
   */
  transportDown: function(transport) {
    this._pool.down(transport);
  },
};

/* Mixins */
extend(Dispatcher.prototype, PublisherMixin);

module.exports = Dispatcher;