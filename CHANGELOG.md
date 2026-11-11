# Changelog

What changed in each version of Aloud, in the words used for the store release notes. New entries
go under **Unreleased** as they are made; a release renames that section to its version and date.
Website-only and documentation changes are not listed: they never reach the extension.

## Unreleased

### Added
- **Settings sync.** Settings, Sync & backup: turn on "Sync settings" and your reading speed and
  pauses, highlights, keys, video speed, pronunciations, what to skip and the theme follow you to
  your other computers, through Firefox Sync or your Chromium browser's own sync. Each device keeps
  its own voices and the sites you gave access to. Not on Firefox for Android, which does not sync
  add-on settings.
- **Notes in your Dropbox.** Settings, Sync & backup, Connect Dropbox: your notes and PDF highlights
  are kept in one file in your own Dropbox (Apps/Aloud-tts) and merged on every device you
  connect, Firefox for Android included (there with a code Dropbox shows). A note deleted on one
  device is deleted on the others; one edited on two, the later edit stays; one deleted on one
  device but edited on another afterwards is kept.

### Changed
- **PDFs are read with pdf.js's modern build**, as Mozilla publishes it, for the Chrome Web Store's
  code readability rules: its older build carried a compatibility library the store took for
  hidden code. A handful of newer functions it relies on are filled in by Aloud for browsers that
  lack them.

## 1.0.3 (2026-11-10)

### Added
- **Keys for Read selection and Read from here.** Alt+L reads the selected text, Alt+G reads
  from here: from the selection, or from where you last clicked in the text (from the top of the
  screen when that is out of sight). In Chromium, which gives an add-on four keys, you choose
  them in `chrome://extensions/shortcuts`. Alt+K, which highlights the selected text and keeps
  it in Notes, says so in Settings → Shortcuts.
- **Video speed: "But never on".** With the speed control on every site, a list of sites where it
  never starts, for pages whose letter keys are their own.

### Changed
- **The name is now Aloud: Natural Text to Speech Reader, Offline**, "Reader" added: the same extension, found by
  what people search for.
- **Alt+M turns the video speed control on and off**, and says which. On a site where it starts
  by itself, off means off there: the site goes on the "But never on" list, and Alt+M on it again
  takes it off. It only ever turned the control on, silently, so it seemed to do nothing.
- pdf.js (the PDF reader's engine) is shipped as Mozilla publishes it unminified, for the Chrome
  Web Store's code readability rules. Nothing about it changes when reading.

### Fixed
- A voice no longer stops with "… is not producing audio" over a moment's trouble. A sentence that
  fails is asked for again, and the reader starts again by itself, twice, before it says so. When
  one of Phonon's workers stopped, every sentence it held failed at once; Play then worked at once.
- N keeps the sentence being read, the one highlighted, and says which ("Saved to Notes: …").
  A sentence only just begun gave way to the one before, so N highlighted the sentence before
  the one being read, pressed again said "Already in your notes", and the sentence itself never
  lit up. At a section's start that was the end of the last section, or the heading.
- Notes, tips and warnings in documentation are read. The Swift book puts each "Note" in an aside,
  and Aloud passed over every one, with every Skip setting off. One-line code listings there were
  skipped too, taken for buttons.
- Passages Readability leaves out in the middle of an article are read when nothing around them
  says they are promotion, navigation or a form: MDN's whole opening section was skipped. So is an
  article's standfirst, the line under its title.
- Read selection no longer loses your place in the page. It used to save the selection's place as
  the page's, and clear it at the end, so the page started again from the top. When the selection
  is read, the reader goes back to where you were in the page.
- Back a little (Z) goes back one sentence at a time, as X goes forward one: the sentence again
  once a few seconds of it have played, else the one before. It went back ten seconds of speech,
  two or three short sentences at one press.
- Read from here is in the right-click menu again, also on selected text (it starts where the
  selection starts), on links and inside frames.
- In the PDF reader, N (or the bar's bookmark) highlights the sentence on the page, as choosing a
  colour for a selection does. It was only kept in Notes.
- Zooming a PDF no longer moves the sentence highlight off the words it marks.
- Closing the reading bar on a PDF and pressing the Aloud button (or Alt+R) reads it again in the
  same tab. It opened Settings in a new tab instead.
- A PDF's highlights and notes say "Kept on this device": they are kept as they are made, for a
  PDF from the web too, and come back when it is opened again. "Not in the file yet" read as if
  they would be lost without a Save.
- The video speed keys (S, D, R, Z, X, M) are left to the page when it has no video or audio to
  control. They were taken on every page, and "No video or audio here" shown.
- On a phone asking for sites' desktop versions, the speed button shows on videos (YouTube Shorts
  included). Taken for a computer, it was given keys instead.

## 1.0.2 (2026-11-06)

### Added
- **Articles inside frames.** A page that shows its text in an embedded frame from another site,
  such as Claude's artifacts, an embedded report or a newsletter reader, is read: Aloud reads the
  frame, after asking once for that site. Before, it said "This page doesn't look like an
  article". Read selection and Read from here work inside such frames too, and so do notes:
  highlights and notes made there are kept, and the Library goes back to the page around it and
  finds them in the frame.
  In Firefox, which lets Aloud ask for a site only from a page of its own, Read it opens a small
  tab that asks.
- **Pages built from web components**, such as MSN's articles, are read. Their text sits inside
  components, where Aloud did not look, so it found no article. Aloud now reads the article's
  paragraphs, not the promotions around them, highlights inside the components, and when a
  "Continue reading" button reveals the rest, the rest is read too.

### Fixed
- A voice of your own speech server chosen for a language (Use → For English, or For every other
  language) shows on the voice board. It was saved, but the board went on showing the voice it
  would have picked itself.
- On a long article (thousands of sentences, hours to go) the reading bar stays one row: the time
  left is shorter ("5h 17m left"), keeps its width as it counts down instead of shifting the
  buttons, and steps aside before the bar would take two rows (it stays in the count's tooltip).
- A voice of your own speech server reads the languages it is chosen for while your main voice is
  one in the browser (Phonon, say). It failed to load ("No server address is set") and the main
  voice read those passages instead; picking it in the reading bar failed the same way.

## 1.0.1 (2026-11-04)

### Added
- **Phonon voices.** A new engine, Phonon by Gradium: natural, expressive voices that read about
  twice as fast as real time on an ordinary processor, no graphics card needed. 37 English voices
  (American, British and a cast of characters, from a pirate captain to a fairy godmother), and 65
  in French, Spanish, German and Portuguese. One 101 MB download, every voice included. Each voice
  has a face and says what it sounds like, and search finds it ("pirate"). Phonon is licensed for
  non-commercial use only. New installs read with Phonon from the start, on computers and on
  phones.
- **Your own speech server.** In Settings → Voice → Custom, point Aloud at a speech
  server you run, such as Kokoro-FastAPI on a PC at home or over Tailscale, and read with its
  voices from any device: the server does the speaking, Aloud does everything else. Works with any
  OpenAI-style speech API. Text goes only to the address you enter, after you allow it, and
  stops if you take that permission back. A server that asks for a key gets one (kept on this
  device only, never in backups), and a server on the internet is only reached over https.
  ([#9](https://github.com/smailoujaoura/aloud/issues/9))
- **Video speed on phones.** A phone has no keys, so the video speed control was out of reach
  there. Now a small speed button sits on the video, appearing when it starts or when you tap
  it: tap it for − and +, tap the number for normal speed. Settings → Video speed has one switch
  to show it on every video. It shows in full screen too.
- **Mute key for videos.** M turns the sound of the video or audio you're watching off, and on
  again, on any site the speed control runs on. Where the player already mutes on M, as YouTube's
  does, its own mute is used. M can be changed in Settings → Video speed.

### Fixed
- On phones the reading bar is two rows instead of three: the progress sits in the first row,
  beside the play controls, with the sentence count and time left under it, and still takes a
  tap or a drag (on the narrowest phones it is a thin line along the bar's top edge). On narrow
  phones the close button no longer falls off the edge of the bar.
- Text in a writing system none of your voices can read (Chinese, Japanese, Russian, Arabic and
  others, when no voice for that language is downloaded) is now skipped, and the bar says so with
  a **Get one** button, instead of being read by an English voice as noise. Languages written in
  Latin letters are still read in English, as before.
- Supertonic voices previewed in Japanese, Croatian and Lithuanian now speak their own language,
  not the English sample sentence. ([#3](https://github.com/smailoujaoura/aloud/issues/3), [#8](https://github.com/smailoujaoura/aloud/issues/8))
- The language badge on the bar (ZH, FR, ...) shows the language's name when you hover over it.
- The bar no longer jumps to two rows when the sentence counter reaches 10 (or 100): it keeps
  room for its widest value from the start. ([#6](https://github.com/smailoujaoura/aloud/issues/6))
- Chinese, Japanese, Thai and other languages written without spaces are highlighted word by
  word, instead of the whole sentence at once. ([#7](https://github.com/smailoujaoura/aloud/issues/7))
- On a Japanese page, a heading or name written only in kanji is read in Japanese, instead of
  being taken for Chinese and skipped.
- **Read from here** starts at the sentence you right-clicked. In Chrome the browser doesn't say
  where you clicked, so the very first time on a page it starts at the top of the screen, and now
  says so; from then on it starts at the right sentence. ([#4](https://github.com/smailoujaoura/aloud/issues/4))
- A download that does not fit on the device no longer deletes part of a voice you already have
  to make room: it stops, says the storage may be full, and leaves your voices as they were.
- PDFs: choosing or dropping a second file while the first is still opening shows the second,
  instead of the first replacing it when it finishes. A file that cannot be opened no longer
  leaves work running in the background of the tab.
- PDFs whose pages are turned sideways in the file and turned back for display are read,
  instead of being reported as scans with no text.
- Two different PDFs with the same file name and number of pages no longer share one place in
  History and one reading position. A PDF is now recognised by its text, so a renamed copy, or
  the same file saved with your highlights, still picks up where you left off. What was saved
  before moves over the first time you open each PDF again.
- Sites that show each article at its own `#/...` address (single-page apps) keep a separate
  place, queue entry and notes for each article, instead of treating them all as one page. Notes
  you already made there stay with the article they were made on.
- Short bits of text in another language, like a site's English "Learn more" under a Spanish
  paragraph or a French phrase quoted in an English article, are read in their own language far
  more often: on lines of one to eight words, Chrome went from about half right to over 80%, and
  Firefox from about two thirds to three quarters. ([#2](https://github.com/smailoujaoura/aloud/issues/2))
- The video speed (1.5×, 2×...) now shows over videos in full screen too, on sites like Loom,
  YouTube and course sites. It was hidden behind the full-screen video.
- Scrolled to the end of a page, the last lines no longer stay hidden under the reading bar: the
  page gets room at the bottom, as tall as the bar, while it is open.
- Supertonic voices' faces show on the reading bar's voice button and in its menu; they showed
  the stand-in avatar there.

### Changed
- **A new name: Aloud: Natural Text to Speech, Offline.** The same extension, called what it does.
- The voice engine tabs in Settings are short and fit a phone: each engine's name (Phonon, Piper,
  Supertonic, Kokoro, Custom) with a mark for whether it is on this device; the details are in its
  tooltip. On a phone they scroll sideways instead of running off the screen.
- Pronunciation fixes can be limited to one language, so a fix for how English is read no longer
  changes the same word in a French passage. **Hear it** speaks the fix in the voice that will
  actually say it, instead of always your main voice. ([#5](https://github.com/smailoujaoura/aloud/issues/5))

## 1.0.0 (2026-10-23)

First release, on the [Chrome Web Store](https://chromewebstore.google.com/detail/ilnojbdjpnnlkjbmldpgbgckkkifheeo)
and [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/aloud-natural-text-to-speech/)
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
