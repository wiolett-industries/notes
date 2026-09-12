const colors = ['#d66a5e', '#d9953b', '#b2ab42', '#65ac58', '#3cb897', '#42acc4', '#678be0', '#a180dc', '#d67fb4', '#ac8970'];
// The server assigns a persistent, unique slot within each board.
export function participantColor(uid: string, slot?: number) {
  if (slot !== undefined && Number.isInteger(slot) && slot >= 0 && slot < colors.length) return colors[slot];
  let hash = 0;
  for (const char of uid) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return colors[(hash >>> 0) % colors.length];
}
