'use strict';

const {relative: relativePath} = require('path');
const {declare: declareBabelPlugin} = require('@babel/helper-plugin-utils');
const {isModule, rewriteModuleStatementsAndPrepareHeader, hasExports} = require('@babel/helper-module-transforms');

/**
 * Returns an identifier generator function whose IDs use the given prefix and
 * suffix. Prefix and suffix must be valid parts for Javascript identifiers.
 * @param {string} prefix
 * @param {string} suffix
 * @returns {function(string): string} A function that takes a string and returns
 * a valid Javascript identifier linked to that string
 */
function makeIdentifierGenerator (prefix, suffix) {
	const uniqueIdentifierCache = new Map();
	return str => {
		const existing = uniqueIdentifierCache.get(str);
		if (existing) return existing;

		let uid = `${prefix}${str.replace(/[^a-z0-9_]/gi, '_')}${suffix}`;
		// eslint-disable-next-line no-loop-func
		while ([...uniqueIdentifierCache.values()].some(value => value === uid)) {
			uid += '_'; // not super readable but oh well
		}

		uniqueIdentifierCache.set(str, uid);
		return uid;
	};
}

module.exports = declareBabelPlugin((babel, {
	identifierPrefix = '__',
	identifierSuffix = '__',
	generateUniqueIdentifier = makeIdentifierGenerator(identifierPrefix, identifierSuffix),
}) => {
	babel.assertVersion(7);

	const t = babel.types;

	// Babel's helpers will convert module code to script code for us, and will also tell us how it's mapped module
	// references to local variables. The main job of this plugin is to wrap that code in an IIFE, which references
	// the global variables corresponding to each module. In this template, `PARAMETER_NAMES` will be the variables
	// Babel has specified for its converted code, and `ARGUMENTS` will be the global variables we've determined. The
	// converted code will be inserted into the body of this IIFE.
	const iifeTemplate = babel.template(`
        (function (PARAMETER_NAMES) {})(ARGUMENTS);
    `);

	// If the module has exports, the first argument will hold the exports object. We use an assignnent expression as
	// the argument expression, generating code like this:
	//
	//     (function (_exports) { /* code */ })(this.__thing__ = this.__thing__ || {})
	//
	// This creates a global object with the appropriate name and passes a reference to it to the converted code as the
	// exports argument, which means that export assignments will be mapped to the correct global variables. The
	// parameter name is usually `_exports`, but Babel may have us use something different.
	const exportArgumentTemplate = babel.template.expression(`
        this.MODULE_ID = this.MODULE_ID || {}
    `);

	// Further arguments will be one per imported module. Again, Babel will tell us the parameter name to use for each
	// module, and we generate the argument name from the filename. The assumption is that imported files will be
	// loaded into the page before this one, so we expect their exports to be available as the corresponding global.
	const importArgumentTemplate = babel.template.expression(`
        this.MODULE_ID
    `);

	return {
		visitor: {
			Program: {
				exit (path, state) {
					// Only operate on module code.
					if (!isModule(path)) return;

					// Relative file path is used as a component of global variable names. We need to have file context
					// for this process to make sense. We also keep track of the working directory - we'll resolve paths
					// against it later.
					if (state.file.opts.filename == null) {
						throw new Error('Filename is required for this plugin');
					}
					const cwd = state.file.opts.cwd;

					// Use a Babel helper to convert import/export statements to script-compatible code, including
					// metadata about the conversion which we can use to map the values to the right places. This call
					// rewrites the program AST in-place. `meta` contains information about name mapping, and `headers`
					// contains additional statements that should be inserted into the program manually later (e.g.
					// setting `__esModule` on the exports object).
					const {meta, headers} = rewriteModuleStatementsAndPrepareHeader(path, {});

					// Construct the argument and parameter lists we'll substitute into the template.
					const iifeArgs = [];
					const iifeParamNames = [];

					// Generate arguments and parameters for the exports object and any imported modules, resolving the
					// path of each module relative to the current working directory to help avoid naming conflicts.
					if (hasExports(meta)) {
						iifeArgs.push(exportArgumentTemplate({
							MODULE_ID: generateUniqueIdentifier(relativePath(cwd, state.file.opts.filename)),
						}));
						iifeParamNames.push(t.identifier(meta.exportName));
					}
					for (const [sourcePath, {name}] of meta.source) {
						iifeArgs.push(importArgumentTemplate({
							// TODO: Support Node module resolution for import specifiers
							MODULE_ID: generateUniqueIdentifier(relativePath(cwd, sourcePath)),
						}));
						iifeParamNames.push(t.identifier(name));
					}

					// Record the original directives and body of the program, then clean the program node.
					const {body, directives} = path.node;
					path.node.directives = [];
					path.node.body = [];

					// Execute the template to generate our IIFE.
					const iifeNode = iifeTemplate({
						ARGUMENTS: iifeArgs,
						PARAMETER_NAMES: iifeParamNames,
					});

					// Insert the IIFE into the now-empty program body, and get a path to it so we can manipulate it.
					const iifePath = path.pushContainer('body', [iifeNode])[0].get('expression.callee.body');

					// Insert the old program directives and body, along with our compatibility headers, into the IIFE.
					iifePath.pushContainer('body', [
						...directives,
						...headers,
						...body,
					]);
				},
			},
		},
	};
});
