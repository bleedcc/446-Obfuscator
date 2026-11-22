export const DF_MAGIC = [0x44, 0x46, 0x33, 0x01] as const;
export const DF_VERSION = 3;

export interface PayloadSection {
  tag: number;
  data: number[];
}

export function encodePayload(sections: readonly PayloadSection[]): number[] {
  const out: number[] = [DF_MAGIC[0], DF_MAGIC[1], DF_MAGIC[2], DF_MAGIC[3], DF_VERSION & 255, (DF_VERSION >> 8) & 255, 0, 0];
  for (const section of sections) {
    if ((section.tag & 255) !== section.tag) throw new Error("payload section tag is out of range");
    if (section.data.length > 65535) throw new Error("payload section is too large");
    out.push(section.tag, section.data.length & 255, (section.data.length >> 8) & 255);
    for (const b of section.data) out.push(b & 255);
  }
  return out;
}

export function decodePayload(bytes: readonly number[]): PayloadSection[] {
  if (bytes.length < 8) throw new Error("payload is shorter than the header");
  for (let i = 0; i < 4; i++) {
    if ((bytes[i] & 255) !== DF_MAGIC[i]) throw new Error("payload magic is not DF3");
  }
  const version = (bytes[4] & 255) + (bytes[5] & 255) * 256;
  if (version !== DF_VERSION) throw new Error(`payload version ${version} is not supported`);
  const sections: PayloadSection[] = [];
  let p = 8;
  while (p < bytes.length) {
    if (p + 3 > bytes.length) throw new Error("payload section header is truncated");
    const tag = bytes[p] & 255;
    const len = (bytes[p + 1] & 255) + (bytes[p + 2] & 255) * 256;
    const start = p + 3;
    if (start + len > bytes.length) throw new Error("payload section length is out of range");
    sections.push({ tag, data: bytes.slice(start, start + len).map((b) => b & 255) });
    p = start + len;
  }
  if (p !== bytes.length) throw new Error("payload has trailing bytes");
  if (sections.length !== 3 || sections[0].tag !== 1 || sections[1].tag !== 2 || sections[2].tag !== 3) {
    throw new Error("payload sections are missing or out of order");
  }
  return sections;
}
