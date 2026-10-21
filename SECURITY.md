# Security

## Reporting a problem

Please report security issues privately, through GitHub's **Report a vulnerability** button on
this repository's Security tab, rather than in a public issue. Anything else, bugs and ideas
included, is welcome at <https://aloud.souj.dev/feedback.html>.

## Dependency audit

`npm audit` lists advisories for the whole dependency tree, including tools that only run on a
developer's machine. What matters for users is what ships inside the extension. Last checked
2026-10-21, against the release candidate.

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
| vitest, @vitest/mocker, tinypool | path traversal in the mock server; prototype pollution in worker options | test runner only |
| vite, source-map-js | Windows command escaping in launch-editor (dev server); source-map parsing DoS | build tool; no dev server is exposed |
| web-ext, fx-runner, shell-quote, @devicefarmer/adbkit, node-forge, adm-zip | command quoting, signature checks, zip extraction | the Firefox linter and test launcher |
| brace-expansion | CPU denial of service on crafted patterns | used by build tooling on fixed patterns |

npm's suggested fixes are a major upgrade of vitest, a downgrade of web-ext, and a new vite
release. They are left for after the first release: vite builds the shipped files, so upgrading it
would change the package after review. Each will be upgraded and the build re-verified then.
