#!/usr/bin/env node

const path = require('path');
const fs = require('fs').promises;
const yargs = require('yargs');
const rollup = require('rollup');
const {nodeResolve} = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');

/** Returns whether or not the given path exists. */
function pathExists (path) {
	return fs.access(path).then(() => true).catch(() => false);
}

let varNameCache = new Map();
/**
 * Returns a unique string which is a valid Javascript identifier associated
 * with the given chunk.
 */
function globalExportsVariableName (chunkFileName) {
	// Check cache first - if we've seen this module before, return what we already have
	const existing = varNameCache.get(chunkFileName);
	if (existing != null) {
		return existing;
	}

	// Generate a new variable name from this module's path
	let name = `__EXBY_MODULE__${chunkFileName.replace(/[^a-z0-9_]/gi, '_')}__`;
	// If we somehow got a collision, add extra characters until we have something unique
	while ([...varNameCache.values()].some(val => val === name)) {
		name += '_';
	}
	// Set the cache and return
	varNameCache.set(chunkFileName, name);
	return name;
}

(async () => {
	const argv = yargs.command('$0 <input> <output>', false, command => command
		.positional('input', {
			desc: 'Path to a manifest.json file, or to a directory containing a manifest.json file.',
			string: true,
		})
		.positional('output', {
			desc: 'Name of a directory that will contain the built extension.',
			string: true,
		})
		.option('cjs-exclude', {
			desc: 'Patterns to exclude from CommonJS module conversion, e.g. polyfills that need direct access to the global scope.',
			array: true,
			default: [],
		})
	)
	.argv;

	// Make the manifest path into an absolute path
	let manifestPath = path.resolve(process.cwd(), argv.input);

	// If the given path is a directory, our entry point is the manifest.json inside
	const stats = await fs.stat(manifestPath);
	if (stats.isDirectory()) {
		manifestPath = path.resolve(manifestPath, 'manifest.json');
	}

	// We also check the output path ahead of time - if it needs to be cleaned, we won't bother building anything
	let outputPath = path.resolve(process.cwd(), argv.output);
	if (await pathExists(outputPath)) {
		console.log('Output path should not exist - I will create it');
		process.exit(1)
	}

	// Load the contents of the manifest
	const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

	// We'll store a record of each entry point in this object. The key is the path as specified in the manifest, and
	// the value is an absolute path to the specified file, which Rollup uses as a module ID - we'll get back to that.
	const entryPoints = {};
	for (const contentScript of manifest.content_scripts || []) {
		for (const scriptPath of contentScript.js || []) {
			if (!entryPoints[scriptPath]) {
				entryPoints[scriptPath] = path.resolve(manifestPath, '..', scriptPath);
			}
		}
	}
	if (manifest.background) for (const scriptPath of manifest.background.scripts || []) {
		if (!entryPoints[scriptPath]) {
			entryPoints[scriptPath] = path.resolve(manifestPath, '..', scriptPath);
		}
	}

	// Perform code splitting on the entry points. The goal here is to flatten the dependency tree as much as possible,
	// merging individual modules that only rely on each other, getting rid of unused exports, and outputting as few
	// files as possible. For example, if the dependency tree of the input entry points looks like this:
	//
	//           a   b
	//          / \
	//     c   d   |
	//      \ /    |
	//       e     f <-- entry points
	//
	// We want to flatten it to the following tree:
	//
	//           a
	//          / \
	//     c+d+e   f
	//
	// Where e has been merged with its dependencies c and d, since it's the only thing using them, and the unused
	// dependency b has been removed entirely.
	const codeSplitBundle = await rollup.rollup({
		input: Object.values(entryPoints),
		plugins: [
			nodeResolve(),
			commonjs({
				exclude: argv.cjsExclude,
			}),
			// During this stage, we also rewrite any references to the manifest file. The contents of the manifest can
			// be read at runtime, so we do that rather than including another copy of it in the built code.
			{
				load (id) {
					// Code references to the manifest are resolved at runtime
					if (id === manifestPath) {
						return 'export default (window.browser || window.chrome).runtime.getManifest();';
					}
					// Other modules are loaded normally
					return null;
				},		
			}
		],
	});
	// The output we get here is an array of "chunks," each of which corresponds to a single output file (which may
	// contain multiple input files merged together). Note that chunks which contain our entry points have a property
	// `facadeModuleId` which matches the absolute path of the entry point it contains. We still have to do some more
	// transformation to this output, but afterwards, we'll use that property to map our chunks back to the manifest.
	const {output: codeSplitOutput} = await codeSplitBundle.generate({format: 'es'});
	await codeSplitBundle.close();

	// Once we've got our merged, code-split chunks, we need to convert them to a format our target environment can
	// understand. Firefox doesn't like ES6 modules in extension scripts, so we instead have to convert our nice
	// declarative import/export syntax into something more basic - global variable assignment. The goal is to turn a
	// module that looks like this:
	//
	//     // src/foo.js
	//     import {something} from './somewhere.js';
	//     export const somethingElse = something + 1;
	//     export const somethingDifferentEntirely = 100;
	//
	// Into source code that looks (roughly) like this:
	//
	//     // out/foo.js
	//     window.__exby_module__foo_js__ = (function () {
	//         const {something} = __exby_module__somewhere_js__;
	//         const somethingElse = something + 1;
	//         const somethingDifferentEntirely = 100;
	//         return {somethingElse, somethingDifferentEntirely};
	//     })();
	//
	// For this conversion to work, we need to give modules a place to export their values where they won't conflict
	// with anything else in the global scope, or with other modules, and where other modules that want to import their
	// values will be able to predict where to find them. We do this by creating a global variable for each module,
	//  where the variable name consists of a predictable, long prefix, along with the module's name (sanitized for use
	// in an identifier). We also need to ensure that modules exporting values are loaded before modules relying on
	// those values - this is handled below, when we rewrite the manifest. Once we've ensured these two things, we can
	// rewrite imports as global variable reads.
	const outputFiles = {};
	for (const chunk of codeSplitOutput) {
		if (chunk.type !== 'chunk') continue;

		// Convert module imports from ES format to our IIFE-based system. 
		const iifeBundle = await rollup.rollup({
			plugins: [{
				// We don't pass `input` to this rollup process, since it only accepts file paths and we're dealing with
				// code in memory. Instead, we emit our code as a "file," using the output filename Rollup generated for
				// us as a temporary ID...
				buildStart () {
					this.emitFile({
						type: 'chunk',
						id: chunk.fileName,
						name: chunk.name,
					});
				},

				// ...and when Rollup tries to load that "file," we tell it to use the source code we want to transform.
				load (id) {
					if (id === chunk.fileName) {
						return chunk.code;
					}

					// If the source has import statements, this load hook will get called multiple times, where 'id' is
					// the location being imported from. When generating IIFE output, Rollup will just inline all
					// imported code into a single output file. Here, we tell Rollup that instead of inlining the entire
					// source of the imported module, we just want to read the module's value from its associated
					// global variable.
					const importedModule = codeSplitOutput.find(c => c.type === 'chunk' && c.fileName === id);
					const exportsString = importedModule.exports.join(',');
					return `
						const {${exportsString}} = ${globalExportsVariableName(id)};
						export {${exportsString}};
					`;
				},

				// We also have to tell Rollup that it shouldn't try to resolve relative paths. We do this by removing
				// the relative path indicator from any locations being imported.
				resolveId (id) {
					// TODO
					const result = id.replace(/^\.?\.\//, '');
					return result;
				},		
			}],
		});
		const {output: iifeOutput} = await iifeBundle.generate({
			// Here, we tell Rollup to handle exports by using the IIFE format, assigning module exports to a global
			// variable with the corresponding name.
			format: 'iife',
			name: globalExportsVariableName(chunk.fileName),
		});
		await iifeBundle.close();

		// IIFE builds should never have more than one output - if there's more, there's probably an asset that got
		// added to the build somehow. We don't know how to handle assets (yet).
		if (iifeOutput.length !== 1) {
			throw new Error(`IIFE build of ${chunkId} generated ${iifeOutput.length} outputs`);
		}

		// Tricky part's out of the way now~! Save the final result for later.
		outputFiles[chunk.fileName] = iifeOutput[0].code;
	}

	// All we have to do now is map each of our initial entry point files to a list of output files. We do have to be
	// careful to list dependencies first, so their exported values are ready before other files try to use them. We
	// already mapped paths in the manifest to chunk IDs earlier, so we can now go from manifest paths to a list of
	// dependencies.
	function flatImportList (chunk) {
		if (!chunk) return [];
		const nestedImports = chunk.imports.map(importee => flatImportList(codeSplitOutput.find(c => c.fileName === importee)));
		return [].concat(...nestedImports, [chunk.fileName]);
	}
	const dependencyMap = {};
	for (const [entryPath, entryModuleID] of Object.entries(entryPoints)) {
		const entryChunk = codeSplitOutput.find(chunk => chunk.facadeModuleId === entryModuleID)
		dependencyMap[entryPath] = flatImportList(entryChunk);
	}
	
	// Now that we have our dependency map, we need to replace the original paths in the manifest. Since we're replacing
	// each individual array value with multiple new values, we work backwards through each list of entry points. We
	// also filter each list for uniqueness once we're done, to ensure that each module is only loaded once per context,
	// even if there are multiple other modules relying on it.
	for (const contentScript of manifest.content_scripts || []) {
		if (contentScript.js) {
			for (let i = contentScript.js.length - 1; i >= 0; i -= 1) {
				contentScript.js.splice(i, 1, ...dependencyMap[contentScript.js[i]])
			}
			contentScript.js = contentScript.js.filter((val, i, arr) => arr.indexOf(val) === i);
		}
	}
	if (manifest.background && manifest.background.scripts) {
		for (let i = manifest.background.scripts.length - 1; i >= 0; i -= 1) {
			manifest.background.scripts.splice(i, 1, ...dependencyMap[manifest.background.scripts[i]]);
		}
		manifest.background.scripts = manifest.background.scripts.filter((val, i, arr) => arr.indexOf(val) === i);
	}

	// Finally, it's time to write our output.
	await fs.mkdir(outputPath);
	await fs.writeFile(path.resolve(outputPath, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
	await Promise.all(Object.entries(outputFiles).map(async ([filename, code]) => {
		await fs.writeFile(path.resolve(outputPath, filename), code, 'utf-8');
	}));
	console.log('done!')
})();
