# Changelog

What changed in each version of Aloud, in the words used for the store release notes. New entries
go under **Unreleased** as they are made; a release renames that section to its version and date.
Website-only and documentation changes are not listed: they never reach the extension.

## Unreleased

### Fixed
- Text in a writing system none of your voices can read (Chinese, Japanese, Russian, Arabic and
  others, when no voice for that language is downloaded) is now skipped, and the bar says so with
  a **Get one** button, instead of being read by an English voice as noise. Languages written in
  Latin letters are still read in English, as before.
- Supertonic voices previewed in Japanese, Croatian and Lithuanian now speak their own language,
  not the English sample sentence. ([#3](https://github.com/smailoujaoura/aloud/issues/3))
- The language badge on the bar (ZH, FR, ...) shows the language's name when you hover over it.

## 1.0.0 (2026-10-23)

First release, on the [Chrome Web Store](https://chromewebstore.google.com/detail/ilnojbdjpnnlkjbmldpgbgckkkifheeo)
and [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/aloud-offline-neural-reader/)
(desktop and Android).

- Reads any article or PDF aloud with natural neural voices that run on your device: 222 voices in
  52 languages from Supertonic 3, Kokoro-82M and Piper. Offline and private, no account.
- Highlights each sentence, and with most voices each word, as it is read.
- Pages in several languages: each passage is read by a voice that speaks it.
- PDFs as real pages, with highlighting and mark-up saved into the file.
- Highlights, notes and tags on any website; a reading queue; picks up where you stopped; save an
  article as MP3; sleep timer.
- The same keys for reading and for any video or audio on the web: S slower, D faster, R normal
  speed, Z back, X forward.
