# Exby

A command-line tool that lets you build cross-platform (Chrome and Firefox) web extensions based on ES modules and modern Javascript.

Exby scans your extension's manifest for script entry points in `content_scripts` and `background.scripts`. It processes your code with [Rollup](https://www.rollupjs.org), performing code splitting and outputting bundled code that's compatible with both Chrome and Firefox. When combined with other compatibility aids such as [webextension-polyfill](https://github.com/mozilla/webextension-polyfill), this allows you to write web extensions using modern Javascript language features, all while minimizing the amount of vendor-specific code in your project. Exby takes care of some of the most common incompatibilities encountered by extension developers and provides a better base for those looking to write for multiple browsers.

## Installation

```bash
# Global install
$ npm install --global exby
# Local install
$ npm install --save-dev exby
```

## Usage

```bash
$ exby <input> [--dir <target location>] [--zip <target file>] [options...]
```

`<input>` is either a path to your extension's `manifest.json` file, or to a folder that directly contains `manifest.json`.

You must provide at least one of `--dir` and `--zip`. These options refer to the output locations, with `--dir` outputting built extension code to the given directory and `--zip` outputting a zipped version of the extension in the given file.

See `exby --help` for a full list of available options.

## Notes/Known Issues

- Exby automatically carries over assets included in the manifest's `web_accessible_resources` and `icons` keys. However, because no processing is currently performed on these paths, you're responsible for ensuring that none of these asset paths conflict with script outputs in the final build. The simplest way to ensure this is to keep all your assets in a separate directory from your extension's scripts.
- The manifest can't pull assets from outside the directory containing the manifest (i.e. paths starting with `../` in `web_accessible_resources` or `icons` will break the build).
- Exby doesn't currently have support for intermediate build steps, e.g. to handle Typescript code or additional transpilation with Babel.

## License

[MIT](/LICENSE)
