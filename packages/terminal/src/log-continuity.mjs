import { createHash } from 'node:crypto';

const CHECKPOINT_BYTES = 4096;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Keep only hashes of bytes already consumed, never an extra raw-content cache.
// Check both the beginning and read boundary: copy-truncate can regrow past the
// saved offset between polls without changing the inode.
export function checkpointForRead(bytes, start, previous = null) {
  if (!bytes.length) return previous;
  const size = Math.min(bytes.length, CHECKPOINT_BYTES);
  const head = start === 0 ? { start: 0, size, digest: digest(bytes.subarray(0, size)) } : previous?.head;
  const tail = { start: start + bytes.length - size, size, digest: digest(bytes.subarray(bytes.length - size)) };
  return { head, tail };
}

export async function checkpointMatches(handle, checkpoint) {
  if (!checkpoint) return true;
  const { head, tail } = checkpoint;
  for (const part of head?.start === tail.start && head.size === tail.size ? [tail] : [head, tail].filter(Boolean)) {
    const buffer = Buffer.alloc(part.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, part.start);
    if (bytesRead !== part.size || digest(buffer) !== part.digest) return false;
  }
  return true;
}
