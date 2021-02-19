'use strict';

const fs = require('fs').promises;

/**
 * Returns whether or not the given path exists.
 * @param {string} somePath
 * @returns {boolean}
 */
function pathExists (somePath) {
	return fs.access(somePath).then(() => true).catch(() => false);
}

// Helper for iterating asynchronously
function forEachParallel (items, func) {
	return Promise.all(items.map((...args) => func(...args)));
}

module.exports = {
	pathExists,
	forEachParallel,
};
