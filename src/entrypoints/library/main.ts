/** The Library moved into Aloud's page (options.html); this address forwards there, view and all. */
import { browser } from 'wxt/browser';

location.replace(`${browser.runtime.getURL('/options.html')}${location.hash || '#continue'}`);
