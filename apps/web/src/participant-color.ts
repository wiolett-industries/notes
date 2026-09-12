// A stable UID-derived color is identical across boards, devices and reloads.
export function participantColor(uid: string) {
  let hash = 0;
  for (const char of uid) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `hsl(${(hash >>> 0) % 360} 55% 42%)`;
}
