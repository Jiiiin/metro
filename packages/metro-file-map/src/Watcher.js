/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow strict-local
 */

import type {
  Console,
  CrawlerOptions,
  FileData,
  Path,
  PerfLogger,
  WatcherBackendChangeEvent,
  WatchmanClocks,
} from './flow-types';
import type {WatcherOptions as WatcherBackendOptions} from './watchers/common';
import type {AbortSignal} from 'node-abort-controller';

import nodeCrawl from './crawlers/node';
import watchmanCrawl from './crawlers/watchman';
import {ADD_EVENT, CHANGE_EVENT} from './watchers/common';
import FSEventsWatcher from './watchers/FSEventsWatcher';
import NodeWatcher from './watchers/NodeWatcher';
import WatchmanWatcher from './watchers/WatchmanWatcher';
import EventEmitter from 'events';
import * as fs from 'fs';
import nullthrows from 'nullthrows';
import * as path from 'path';
import {performance} from 'perf_hooks';

const debug = require('debug')('Metro:Watcher');

const MAX_WAIT_TIME = 240000;

type CrawlResult = {
  changedFiles: FileData,
  clocks?: WatchmanClocks,
  removedFiles: Set<Path>,
};

type WatcherOptions = {
  abortSignal: AbortSignal,
  computeSha1: boolean,
  console: Console,
  enableSymlinks: boolean,
  extensions: $ReadOnlyArray<string>,
  forceNodeFilesystemAPI: boolean,
  healthCheckFilePrefix: string,
  ignore: string => boolean,
  ignorePattern: RegExp,
  previousState: CrawlerOptions['previousState'],
  perfLogger: ?PerfLogger,
  roots: $ReadOnlyArray<string>,
  rootDir: string,
  useWatchman: boolean,
  watch: boolean,
  watchmanDeferStates: $ReadOnlyArray<string>,
};

interface WatcherBackend {
  getPauseReason(): ?string;
  close(): Promise<void>;
}

let nextInstanceId = 0;

export type HealthCheckResult =
  | {type: 'error', timeout: number, error: Error, watcher: ?string}
  | {type: 'success', timeout: number, timeElapsed: number, watcher: ?string}
  | {type: 'timeout', timeout: number, watcher: ?string, pauseReason: ?string};

export class Watcher extends EventEmitter {
  _options: WatcherOptions;
  _backends: $ReadOnlyArray<WatcherBackend> = [];
  _instanceId: number;
  _nextHealthCheckId: number = 0;
  _pendingHealthChecks: Map</* basename */ string, /* resolve */ () => void> =
    new Map();
  _activeWatcher: ?string;

  constructor(options: WatcherOptions) {
    super();
    this._options = options;
    this._instanceId = nextInstanceId++;
  }

  async crawl(): Promise<CrawlResult> {
    this._options.perfLogger?.point('crawl_start');

    const options = this._options;
    const ignore = (filePath: string) =>
      options.ignore(filePath) ||
      path.basename(filePath).startsWith(this._options.healthCheckFilePrefix);
    const crawl = options.useWatchman ? watchmanCrawl : nodeCrawl;
    let crawler = crawl === watchmanCrawl ? 'watchman' : 'node';

    options.abortSignal.throwIfAborted();

    const crawlerOptions: CrawlerOptions = {
      abortSignal: options.abortSignal,
      computeSha1: options.computeSha1,
      console: options.console,
      includeSymlinks: options.enableSymlinks,
      extensions: options.extensions,
      forceNodeFilesystemAPI: options.forceNodeFilesystemAPI,
      ignore,
      onStatus: status => {
        this.emit('status', status);
      },
      perfLogger: options.perfLogger,
      previousState: options.previousState,
      rootDir: options.rootDir,
      roots: options.roots,
    };

    const retry = (error: Error): Promise<CrawlResult> => {
      if (crawl === watchmanCrawl) {
        crawler = 'node';
        options.console.warn(
          'metro-file-map: Watchman crawl failed. Retrying once with node ' +
            'crawler.\n' +
            "  Usually this happens when watchman isn't running. Create an " +
            "empty `.watchmanconfig` file in your project's root folder or " +
            'initialize a git or hg repository in your project.\n' +
            '  ' +
            error.toString(),
        );
        // $FlowFixMe[prop-missing] Found when updating Promise type definition
        return nodeCrawl(crawlerOptions).catch<CrawlResult>(e => {
          throw new Error(
            'Crawler retry failed:\n' +
              `  Original error: ${error.message}\n` +
              `  Retry error: ${e.message}\n`,
          );
        });
      }

      throw error;
    };

    const logEnd = (delta: CrawlResult): CrawlResult => {
      debug(
        'Crawler "%s" returned %d added/modified, %d removed, %d clock(s).',
        crawler,
        delta.changedFiles.size,
        delta.removedFiles.size,
        delta.clocks?.size ?? 0,
      );
      this._options.perfLogger?.point('crawl_end');
      return delta;
    };

    debug('Beginning crawl with "%s".', crawler);
    try {
      // $FlowFixMe[incompatible-call] Found when updating Promise type definition
      return crawl(crawlerOptions).catch<CrawlResult>(retry).then(logEnd);
    } catch (error) {
      return retry(error).then(logEnd);
    }
  }

  async watch(onChange: (change: WatcherBackendChangeEvent) => void) {
    const {extensions, ignorePattern, useWatchman} = this._options;

    // WatchmanWatcher > FSEventsWatcher > sane.NodeWatcher
    const WatcherImpl = useWatchman
      ? WatchmanWatcher
      : FSEventsWatcher.isSupported()
        ? FSEventsWatcher
        : NodeWatcher;

    let watcher = 'node';
    if (WatcherImpl === WatchmanWatcher) {
      watcher = 'watchman';
    } else if (WatcherImpl === FSEventsWatcher) {
      watcher = 'fsevents';
    }
    debug(`Using watcher: ${watcher}`);
    this._options.perfLogger?.annotate({string: {watcher}});
    this._activeWatcher = watcher;

    const createWatcherBackend = (root: Path): Promise<WatcherBackend> => {
      const watcherOptions: WatcherBackendOptions = {
        dot: true,
        glob: [
          // Ensure we always include package.json files, which are crucial for
          /// module resolution.
          '**/package.json',
          // Ensure we always watch any health check files
          '**/' + this._options.healthCheckFilePrefix + '*',
          ...extensions.map(extension => '**/*.' + extension),
        ],
        ignored: ignorePattern,
        watchmanDeferStates: this._options.watchmanDeferStates,
      };
      const watcher = new WatcherImpl(root, watcherOptions);

      return new Promise((resolve, reject) => {
        const rejectTimeout = setTimeout(
          () => reject(new Error('Failed to start watch mode.')),
          MAX_WAIT_TIME,
        );

        watcher.once('ready', () => {
          clearTimeout(rejectTimeout);
          watcher.on('all', (change: WatcherBackendChangeEvent) => {
            const basename = path.basename(change.relativePath);
            if (basename.startsWith(this._options.healthCheckFilePrefix)) {
              if (change.event === ADD_EVENT || change.event === CHANGE_EVENT) {
                debug(
                  'Observed possible health check cookie: %s in %s',
                  change.relativePath,
                  root,
                );
                this._handleHealthCheckObservation(basename);
              }
              return;
            }
            onChange(change);
          });
          resolve(watcher);
        });
      });
    };

    this._backends = await Promise.all(
      this._options.roots.map(createWatcherBackend),
    );
  }

  _handleHealthCheckObservation(basename: string) {
    const resolveHealthCheck = this._pendingHealthChecks.get(basename);
    if (!resolveHealthCheck) {
      return;
    }
    resolveHealthCheck();
  }

  async close() {
    await Promise.all(this._backends.map(watcher => watcher.close()));
    this._activeWatcher = null;
  }

  async checkHealth(timeout: number): Promise<HealthCheckResult> {
    const healthCheckId = this._nextHealthCheckId++;
    if (healthCheckId === Number.MAX_SAFE_INTEGER) {
      this._nextHealthCheckId = 0;
    }
    const watcher = this._activeWatcher;
    const basename =
      this._options.healthCheckFilePrefix +
      '-' +
      process.pid +
      '-' +
      this._instanceId +
      '-' +
      healthCheckId;
    const healthCheckPath = path.join(this._options.rootDir, basename);
    let result: ?HealthCheckResult;
    const timeoutPromise = new Promise(resolve =>
      setTimeout(resolve, timeout),
    ).then(() => {
      if (!result) {
        result = {
          type: 'timeout',
          pauseReason: this._backends[0]?.getPauseReason(),
          timeout,
          watcher,
        };
      }
    });
    const startTime = performance.now();
    debug('Creating health check cookie: %s', healthCheckPath);
    const creationPromise = fs.promises
      .writeFile(healthCheckPath, String(startTime))
      .catch(error => {
        if (!result) {
          result = {
            type: 'error',
            error,
            timeout,
            watcher,
          };
        }
      });
    const observationPromise = new Promise(resolve => {
      this._pendingHealthChecks.set(basename, resolve);
    }).then(() => {
      if (!result) {
        result = {
          type: 'success',
          timeElapsed: performance.now() - startTime,
          timeout,
          watcher,
        };
      }
    });
    await Promise.race([
      timeoutPromise,
      creationPromise.then(() => observationPromise),
    ]);
    this._pendingHealthChecks.delete(basename);
    // Chain a deletion to the creation promise (which may not have even settled yet!),
    // don't await it, and swallow errors. This is just best-effort cleanup.
    // $FlowFixMe[unused-promise]
    creationPromise.then(() =>
      fs.promises.unlink(healthCheckPath).catch(() => {}),
    );
    debug('Health check result: %o', result);
    return nullthrows(result);
  }
}
