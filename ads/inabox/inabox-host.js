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

/**
 * Inabox host script is installed on a non-AMP host page to provide APIs for
 * its embed AMP content (such as an ad created in AMP).
 */

import {dev, initLogConstructor, setReportError} from '../../src/log';
import {reportError} from '../../src/error';
import {InaboxMessagingHost} from './inabox-messaging-host';

/** @const {string} */
const TAG = 'inabox-host';
/** @const {string} */
const AMP_INABOX_INITIALIZED = 'ampInaboxInitialized';
/** @const {string} */
const PENDING_MESSAGES = 'ampInaboxPendingMessages';
/** @const {string} */
const INABOX_IFRAMES = 'ampInaboxIframes';

/**
 * Class for initializing host script and consuming queued messages.
 * @visibleForTesting
 */
export class InaboxHost {
  /** @param win {!Window}  */
  constructor(win) {
    // Prevent double initialization
    if (win[AMP_INABOX_INITIALIZED]) {
      dev().info(TAG, 'Skip a 2nd attempt of initializing AMP inabox host.');
      return;
    }

    // Assume we cannot recover from state initialization errors.
    win[AMP_INABOX_INITIALIZED] = true;
    initLogConstructor();
    setReportError(reportError);

    if (win[INABOX_IFRAMES] && !Array.isArray(win[INABOX_IFRAMES])) {
      dev().info(TAG, `Invalid ${INABOX_IFRAMES}`,
          win[INABOX_IFRAMES]);
      win[INABOX_IFRAMES] = [];
    }
    const host = new InaboxMessagingHost(win, win[INABOX_IFRAMES]);

    const queuedMsgs = win[PENDING_MESSAGES];
    if (queuedMsgs) {
      if (Array.isArray(queuedMsgs)) {
        queuedMsgs.forEach(message => {
          try {
            host.processMessage(message);
          } catch (err) {
            dev().error(TAG, 'Error processing inabox message', message, err);
          }
        });
      } else {
        dev().info(TAG, `Invalid ${PENDING_MESSAGES}`, queuedMsgs);
      }
    }
    // Empty and ensure that future messages are no longer stored in the array.
    win[PENDING_MESSAGES] = [];
    win[PENDING_MESSAGES]['push'] = () => {};
    win.addEventListener('message', host.processMessage.bind(host));
  }
}

new InaboxHost(self);