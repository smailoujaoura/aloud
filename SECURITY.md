# Security

## Reporting a problem

Please report security issues privately, through GitHub's **Report a vulnerability** button on
this repository's Security tab, rather than in a public issue. Anything else, bugs and ideas
included, is welcome at <https://aloud.souj.dev/feedback.html>.

## Dependency audit

`npm audit` lists advisories for the whole dependency tree, including tools that only run on a
developer's machine. What matters for users is what ships inside the extension. Last checked
2026-11-11, after upgrading the build and test tools (19 advisories, 5 critical, down to 9, none
critical, none in what ships).

**Shipped in the extension: no open advisories.** The packaged runtime is onnxruntime-web 1.22.0,
@huggingface/transformers 3.7.5 (its browser build, `transformers.web.js`), kokoro-js 1.2.1,
@diffusionstudio/piper-wasm 1.0.0, pdfjs-dist, pdf-lib 1.17.1, @mozilla/readability 0.6.0 and
@breezystack/lamejs 1.2.7.

**Reported against transformers.js and kokoro-js, not shipped.** `npm audit` marks both "high"
through their Node.js dependencies: sharp (libvips, libheif), onnxruntime-node, and through it
global-agent, roarr and sprintf-js. The browser build Aloud packages leaves all of these out:
`onnxruntime-node` appears in it only as an empty "(ignored)" module, and none of the others
appear at all. Checked by searching the built packages, not only the dependency tree.

**Development and build tools, not shipped.** These run on the machine that builds or tests
Aloud, never in a browser:

| Package | Advisory | Why it does not reach users |
|---|---|---|
| web-ext, through addons-linter, firefox-profile and @devicefarmer/adbkit: deepmerge, adm-zip, node-forge, brace-expansion | prototype pollution, zip extraction, signature checks, CPU denial of service on crafted patterns | the Firefox linter and test launcher, at its latest version (10.8.0) |

Upgraded on 2026-11-11: vite 8.3.8, vitest 5.1.0 (with tinypool and @vitest/mocker), happy-dom
21.0.4, wxt 0.21.5, web-ext 10.8.0 and pdfjs-dist 6.5.438. The build was checked again after it:
types, every test, both builds, the Firefox linter, and the PDF reader, Dropbox sync and settings
sync in Chromium.

