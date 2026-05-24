/**
 * tfjs-node 4.22 still calls `util.isNullOrUndefined`, deprecated since
 * Node 4 and finally removed in Node 22. Patch it back onto `node:util`
 * before tfjs-node is imported anywhere — Node 26 (our target) needs this
 * for the native backend to register without throwing on the first kernel
 * dispatch.
 *
 * Importing this module is a side-effect: keep the import on its own line
 * above any tfjs / face-api import to guarantee initialization order
 * (TypeScript/ESM evaluates imports in declaration order from the same
 * file).
 */
import nodeUtil from 'node:util';

type LegacyUtil = {
  isNullOrUndefined?: (value: unknown) => boolean;
};

const u = nodeUtil as LegacyUtil;
if (typeof u.isNullOrUndefined !== 'function') {
  u.isNullOrUndefined = (value: unknown) => value === null || value === undefined;
}
