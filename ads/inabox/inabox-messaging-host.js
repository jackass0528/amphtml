/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {FrameOverlayManager} from './frame-overlay-manager';
import {PositionObserver} from './position-observer';
import {
  serializeMessage,
  deserializeMessage,
  MessageType,
} from '../../src/3p-frame-messaging';
import {dev} from '../../src/log';
import {getData} from '../../src/event-helper';
import {dict} from '../../src/utils/object';
import {layoutRectFromDomRect} from '../../src/layout-rect';
/** @const */
const TAG = 'InaboxMessagingHost';



/** Simple helper for named callbacks. */
class NamedObservable {

  constructor() {
    this.map_ = {};
  }

  /**
   * @param {string} key
   * @param {!Function} callback
   */
  listen(key, callback) {
    if (key in this.map_) {
      dev().fine(TAG, `Overriding message callback [${key}]`);
    }
    this.map_[key] = callback;
  }

  /**
   * @param {string} key
   * @param {*} thisArg
   * @param {!Array} args
   * @return {boolean} True when a callback was found and successfully executed.
   */
  fire(key, thisArg, args) {
    if (key in this.map_) {
      return this.map_[key].apply(thisArg, args);
    }
    return false;
  }
}


export class InaboxMessagingHost {

  constructor(win, iframes) {
    this.win_ = win;
    this.iframes_ = iframes;
    this.iframeMap_ = Object.create(null);
    this.registeredIframeSentinels_ = Object.create(null);
    this.positionObserver_ = new PositionObserver(win);
    this.msgObservable_ = new NamedObservable();
    this.frameOverlayManager_ = new FrameOverlayManager(win);

    this.msgObservable_.listen(
        MessageType.SEND_POSITIONS, this.handleSendPositions_);

    this.msgObservable_.listen(
        MessageType.FULL_OVERLAY_FRAME, this.handleEnterFullOverlay_);

    this.msgObservable_.listen(
        MessageType.CANCEL_FULL_OVERLAY_FRAME, this.handleCancelFullOverlay_);
  }

  /**
   * Process a single post message.
   *
   * A valid message has to be formatted as a string starting with "amp-". The
   * rest part should be a stringified JSON object of
   * {type: string, sentinel: string}. The allowed types are listed in the
   * REQUEST_TYPE enum.
   *
   * @param {!MessageEvent} message
   * @return {boolean} true if message get successfully processed
   */
  processMessage(message) {
    const request = deserializeMessage(getData(message));
    if (!request || !request['sentinel']) {
      dev().fine(TAG, 'Ignored non-AMP message:', message);
      return false;
    }

    const iframe =
        this.getFrameElement_(message.source, request['sentinel']);
    if (!iframe) {
      dev().info(TAG, 'Ignored message from untrusted iframe:', message);
      return false;
    }

    if (!this.msgObservable_.fire(request['type'], this,
        [iframe, request, message.source, message.origin])) {
      dev().warn(TAG, 'Unprocessed AMP message:', message);
      return false;
    }

    return true;
  }

  /**
   * @param {!HTMLIFrameElement} iframe
   * @param {!Object} request
   * @param {!Window} source
   * @param {string} origin
   * @return {boolean}
   */
  handleSendPositions_(iframe, request, source, origin) {
    const viewportRect = this.positionObserver_.getViewportRect();
    const targetRect =
        layoutRectFromDomRect(iframe./*OK*/getBoundingClientRect());
    this.sendPosition_(request, source, origin, dict({
      'viewportRect': viewportRect,
      'targetRect': targetRect,
    }));

    // To prevent double tracking for the same requester.
    if (this.registeredIframeSentinels_[request.sentinel]) {
      return true;
    }

    this.registeredIframeSentinels_[request.sentinel] = true;
    this.positionObserver_.observe(iframe, data => {
      this.sendPosition_(request, source, origin, data);
    });
    return true;
  }

  /**
   *
   * @param {!Object} request
   * @param {!Window} source
   * @param {string} origin
   * @param {JsonObject} data
   */
  sendPosition_(request, source, origin, data) {
    dev().fine(TAG, `Sent position data to [${request.sentinel}]`, data);
    source./*OK*/postMessage(
        serializeMessage(MessageType.POSITION, request.sentinel, data),
        origin);
  }

  /**
   * @param {!HTMLIFrameElement} iframe
   * @param {!Object} request
   * @param {!Window} source
   * @param {string} origin
   * @return {boolean}
   */
  // TODO(alanorozco):
  // 1. Reject request if frame is out of focus
  // 2. Disable zoom and scroll on parent doc
  handleEnterFullOverlay_(iframe, request, source, origin) {
    this.frameOverlayManager_.expandFrame(iframe, boxRect => {
      source./*OK*/postMessage(
          serializeMessage(
              MessageType.FULL_OVERLAY_FRAME_RESPONSE,
              request.sentinel,
              dict({
                'success': true,
                'boxRect': boxRect,
              })),
          origin);
    });

    return true;
  }

  /**
   * @param {!HTMLIFrameElement} iframe
   * @param {!Object} request
   * @param {!Window} source
   * @param {string} origin
   * @return {boolean}
   */
  handleCancelFullOverlay_(iframe, request, source, origin) {
    this.frameOverlayManager_.collapseFrame(iframe, boxRect => {
      source./*OK*/postMessage(
          serializeMessage(
              MessageType.CANCEL_FULL_OVERLAY_FRAME_RESPONSE,
              request.sentinel,
              dict({
                'success': true,
                'boxRect': boxRect,
              })),
          origin);
    });

    return true;
  }

  /**
   * Returns source window's ancestor iframe who is the direct child of host
   * doc. The sentinel should be unique to the source window, and the result
   * is cached using the sentinel as the key.
   *
   * @param source {!Window}
   * @param sentinel {string}
   * @returns {?HTMLIFrameElement}
   * @private
   */
  getFrameElement_(source, sentinel) {
    if (this.iframeMap_[sentinel]) {
      return this.iframeMap_[sentinel];
    }

    // Walk up on the window tree until find host's direct child window
    while (source.parent !== this.win_ && source !== this.win_.top) {
      source = source.parent;
    }

    // Find the iframe element that hosts the message source window
    for (let i = 0; i < this.iframes_.length; i++) {
      const iframe = this.iframes_[i];
      if (iframe.contentWindow === source) {
        // Cache the found iframe with its sentinel.
        this.iframeMap_[sentinel] = iframe;
        return iframe;
      }
    }
    return null;
  }
}