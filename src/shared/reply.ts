/**
 * Answer a runtime message after an `await`, in every browser Aloud supports.
 *
 * Returning a promise from an `onMessage` listener works in Firefox and in Chromium from 148, but
 * the Chromium the build targets (120) ignores it: the sender receives `undefined`. "Add page to
 * queue" then said the page could not be queued, and a note that had been saved was reported as
 * not saved. `sendResponse` with a literal `true` returned from the listener works in all of them.
 *
 *   browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
 *     if (isMine(msg)) return replyLater(sendResponse, work());
 *     return false;
 *   });
 */
export function replyLater(sendResponse: (reply: unknown) => void, answer: Promise<unknown> | unknown): true {
  void Promise.resolve(answer).then(
    (value) => sendResponse(value),
    () => sendResponse(undefined),
  );
  return true;
}
