/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 * @oncall react_native
 */

/**
 * Originally vendored from
 * https://github.com/amasad/sane/blob/64ff3a870c42e84f744086884bf55a4f9c22d376/src/common.js
 */

'use strict';

import type {ChangeEventMetadata} from '../flow-types';
import type {Stats} from 'fs';

// $FlowFixMe[untyped-import] - Write libdefs for `micromatch`
const micromatch = require('micromatch');
const platform = require('os').platform();
const path = require('path');
// $FlowFixMe[untyped-import] - Write libdefs for `walker`
const walker = require('walker');

/**
 * Constants
 */
export const CHANGE_EVENT = 'change';
export const DELETE_EVENT = 'delete';
export const ADD_EVENT = 'add';
export const ALL_EVENT = 'all';

export type WatcherOptions = $ReadOnly<{
  glob: $ReadOnlyArray<string>,
  dot: boolean,
  ignored: ?RegExp,
  watchmanDeferStates: $ReadOnlyArray<string>,
  watchman?: mixed,
  watchmanPath?: string,
}>;

interface Watcher {
  doIgnore: string => boolean;
  dot: boolean;
  globs: $ReadOnlyArray<string>;
  ignored?: ?RegExp;
  watchmanDeferStates: $ReadOnlyArray<string>;
  watchmanPath?: ?string;
}

/**
 * Assigns options to the watcher.
 *
 * @param {NodeWatcher|PollWatcher|WatchmanWatcher} watcher
 * @param {?object} opts
 * @return {boolean}
 * @public
 */
export const assignOptions = function (
  watcher: Watcher,
  opts: WatcherOptions,
): WatcherOptions {
  watcher.globs = opts.glob ?? [];
  watcher.dot = opts.dot ?? false;
  watcher.ignored = opts.ignored ?? null;
  watcher.watchmanDeferStates = opts.watchmanDeferStates;

  if (!Array.isArray(watcher.globs)) {
    watcher.globs = [watcher.globs];
  }
  const ignored = watcher.ignored;
  watcher.doIgnore = ignored
    ? filePath => posixPathMatchesPattern(ignored, filePath)
    : () => false;

  if (opts.watchman == true && opts.watchmanPath != null) {
    watcher.watchmanPath = opts.watchmanPath;
  }

  return opts;
};

/**
 * Checks a file relative path against the globs array.
 */
export function isIncluded(
  type: ?('f' | 'l' | 'd'),
  globs: $ReadOnlyArray<string>,
  dot: boolean,
  doIgnore: string => boolean,
  relativePath: string,
): boolean {
  if (doIgnore(relativePath)) {
    return false;
  }
  // For non-regular files or if there are no glob matchers, just respect the
  // `dot` option to filter dotfiles if dot === false.
  if (globs.length === 0 || type !== 'f') {
    return dot || micromatch.some(relativePath, '**/*');
  }
  return micromatch.some(relativePath, globs, {dot});
}

/**
 * Whether the given filePath matches the given RegExp, after converting
 * (on Windows only) system separators to posix separators.
 *
 * Conversion to posix is for backwards compatibility with the previous
 * anymatch matcher, which normlises all inputs[1]. This may not be consistent
 * with other parts of metro-file-map.
 *
 * [1]: https://github.com/micromatch/anymatch/blob/3.1.1/index.js#L50
 */
const posixPathMatchesPattern: (pattern: RegExp, filePath: string) => boolean =
  path.sep === '/'
    ? (pattern, filePath) => pattern.test(filePath)
    : (pattern, filePath) => pattern.test(filePath.replaceAll(path.sep, '/'));

/**
 * Traverse a directory recursively calling `callback` on every directory.
 */
export function recReaddir(
  dir: string,
  dirCallback: (string, Stats) => void,
  fileCallback: (string, Stats) => void,
  symlinkCallback: (string, Stats) => void,
  endCallback: () => void,
  errorCallback: Error => void,
  ignored: ?RegExp,
) {
  const walk = walker(dir);
  if (ignored) {
    walk.filterDir(
      (currentDir: string) => !posixPathMatchesPattern(ignored, currentDir),
    );
  }
  walk
    .on('dir', normalizeProxy(dirCallback))
    .on('file', normalizeProxy(fileCallback))
    .on('symlink', normalizeProxy(symlinkCallback))
    .on('error', errorCallback)
    .on('end', () => {
      if (platform === 'win32') {
        setTimeout(endCallback, 1000);
      } else {
        endCallback();
      }
    });
}

/**
 * Returns a callback that when called will normalize a path and call the
 * original callback
 */
function normalizeProxy<T>(
  callback: (filepath: string, stats: Stats) => T,
): (string, Stats) => T {
  return (filepath: string, stats: Stats) =>
    callback(path.normalize(filepath), stats);
}

export function typeFromStat(stat: Stats): ?ChangeEventMetadata['type'] {
  // Note: These tests are not mutually exclusive - a symlink passes isFile
  if (stat.isSymbolicLink()) {
    return 'l';
  }
  if (stat.isDirectory()) {
    return 'd';
  }
  if (stat.isFile()) {
    return 'f'; // "Regular" file
  }
  return null;
}
