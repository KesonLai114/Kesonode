/**
 * Integrity guards for the two portable export files (the settings backup and the data
 * backup). A checksum here detects ACCIDENTAL damage — a truncated download, a half-
 * written file, a bad copy/paste — and nothing else. There is no secret: anyone can
 * recompute it, and deleting the field restores the pre-checksum behaviour, so it is NOT
 * an authentication code. Files written before it existed have none and stay readable.
 * Authenticated data is a different matter, handled by the frozen SyncPacket/E2EE
 * contract in compat/protocol.ts.
 */
import { sha256 } from "@/lib/crypto/encryption";

/**
 * Stable serialisation: object keys are sorted and undefined keys are dropped the way
 * JSON.stringify drops them, so reformatting or re-saving a file cannot change its hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

function withoutChecksum(envelope: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(envelope)) {
    if (key !== "checksum") rest[key] = envelope[key];
  }
  return rest;
}

/** Adds a checksum over every field of the envelope except `checksum` itself. */
export async function withChecksum<const T extends Record<string, unknown>>(
  envelope: T
): Promise<T & { checksum: string }> {
  const rest = withoutChecksum(envelope);
  return { ...rest, checksum: await sha256(canonicalJson(rest)) } as T & { checksum: string };
}

/**
 * Verifies a checksum when one is PRESENT. Missing means an older file and is accepted;
 * present but malformed or mismatched is refused with an actionable message. Call AFTER
 * the format/version gate, so a newer file is reported as newer rather than as damaged.
 */
export async function verifyChecksum(input: Record<string, unknown>): Promise<void> {
  const checksum = input.checksum;
  if (checksum === undefined || checksum === null || checksum === "") return;
  if (typeof checksum !== "string" || !CHECKSUM_PATTERN.test(checksum)) {
    throw new Error(
      "This backup has a malformed checksum. It may be damaged; please export it again."
    );
  }
  const expected = await sha256(canonicalJson(withoutChecksum(input)));
  if (checksum !== expected) {
    throw new Error(
      "This backup's checksum does not match its contents. The file may be damaged or " +
        "incomplete; please export it again."
    );
  }
}
