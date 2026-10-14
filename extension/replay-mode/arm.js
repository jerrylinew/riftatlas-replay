/**
 * Hands a pending replay to the main world at document_start.
 *
 * Replay mode has to install its socket intercept before RiftAtlas opens its
 * match socket, which happens about two seconds into page load. That means
 * arming cannot wait for a popup click on an already-loaded page - the real
 * socket wins, and replay mode correctly refuses to displace it.
 *
 * So the popup stores a replay and reloads the tab; this runs at document_start
 * in the isolated world (where chrome APIs exist), reads it, and posts it to
 * inject.js in the main world (where they do not).
 *
 * Registered dynamically, only while a replay is pending, and consumed on
 * read - so replay mode stays something the user asks for once, not a script
 * that sits armed on every page load.
 */
const KEY = 'pendingReplay';
const REVEALS = 'pendingReveals';
const RECORDING = 'pendingRecordingId';

chrome.storage.session.get([KEY, REVEALS, RECORDING]).then((stored) => {
  const pending = stored?.[KEY];
  if (!pending) return;
  const reveals = stored?.[REVEALS] ?? [];
  const recordingId = stored?.[RECORDING] ?? pending.recordingId ?? null;
  // Consume it: one arming per request.
  chrome.storage.session.remove([KEY, REVEALS, RECORDING]);
  chrome.runtime.sendMessage({ type: 'replayModeArmed' }).catch(() => {});

  const hand = () => window.postMessage(
    { source: 'riftatlas-replay-arm', replay: pending, reveals, recordingId }, window.location.origin);

  // Both scripts run at document_start and the order is not guaranteed, so
  // answer inject.js's ready call, and also offer it straight away in case it
  // was already listening. postMessage does not buffer; a handshake does.
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === 'riftatlas-replay-ready') hand();
  });
  hand();
}).catch(() => {});
