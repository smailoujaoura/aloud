/**
 * May page text go to the reader's own speech server now?
 *
 * Asked once, on Connect (options/voice-panels.ts: askForServer): access to the server's host and,
 * in Firefox, consent to send it website content. That is not enough on its own: Firefox lets the
 * reader take the consent back in the add-on's settings, a backup restored on another device names
 * a server nobody there agreed to, and a server that answers every origin (Kokoro-FastAPI does)
 * receives text even without the host permission. So the permissions are asked again whenever a
 * server is about to be read with: by the synthesis host before it starts one, and by the
 * settings page before a preview. Free of extension APIs, given the permissions object to ask.
 */
import { serverOrigin } from './server-voices';

export interface PermissionsLike {
  contains(permissions: { origins?: string[]; data_collection?: string[] }): Promise<boolean>;
}

/** `firefox`: also ask for the website-content data consent, which only Firefox has. */
export async function serverConsented(url: string, permissions: PermissionsLike | undefined, firefox: boolean): Promise<boolean> {
  if (!permissions || !url) return false;
  let origins: string[];
  try {
    origins = [serverOrigin(url)];
  } catch {
    return false;
  }
  if (firefox) {
    try {
      return await permissions.contains({ origins, data_collection: ['websiteContent'] });
    } catch {
      /* a Firefox without data-collection permissions: the host alone, as on Connect */
    }
  }
  return permissions.contains({ origins }).catch(() => false);
}

/** What to tell the reader when it may not. */
export function noConsentMessage(url: string): string {
  return `Aloud may not send text to ${url} any more: that permission was taken back, or never given on this browser. Connect the server again in Settings → Voice → Custom.`;
}
