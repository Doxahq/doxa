/** Decode the classic PCAP formats tcpdump emits. No packet or MDX content is executed. */
export function inspectPcap(buffer) {
  if (buffer.length < 24) throw new Error("Incomplete PCAP header.");
  const magic = buffer.readUInt32LE(0);
  const little = [0xa1b2c3d4, 0xa1b23c4d].includes(magic);
  if (!little && ![0xd4c3b2a1, 0x4d3cb2a1].includes(magic)) throw new Error("Unknown PCAP format.");
  const u32 = (offset) => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  const link = u32(20);
  if (![1, 113, 276].includes(link)) throw new Error(`Unsupported PCAP link type ${link}.`);
  const connections = [];
  const dnsQueries = [];
  let packets = 0;
  let truncatedPackets = 0;
  for (let offset = 24; offset + 16 <= buffer.length; ) {
    const length = u32(offset + 8);
    const originalLength = u32(offset + 12);
    offset += 16;
    if (offset + length > buffer.length) throw new Error("Truncated PCAP record.");
    const frame = buffer.subarray(offset, offset + length);
    offset += length;
    packets++;
    if (length < originalLength) truncatedPackets++;
    let ipOffset;
    let protocol;
    let outgoing = false;
    if (link === 276 && frame.length >= 20) {
      protocol = frame.readUInt16BE(0);
      ipOffset = 20;
      outgoing = frame[10] === 4;
    } else if (link === 113 && frame.length >= 16) {
      protocol = frame.readUInt16BE(14);
      ipOffset = 16;
      outgoing = frame.readUInt16BE(0) === 4;
    } else if (link === 1 && frame.length >= 14) {
      protocol = frame.readUInt16BE(12);
      ipOffset = 14;
    } else continue;
    const ip = frame.subarray(ipOffset);
    let transport;
    let next;
    let address;
    if (protocol === 0x0800 && ip.length >= 20) {
      transport = (ip[0] & 15) * 4;
      next = ip[9];
      address = [...ip.subarray(16, 20)].join(".");
    } else if (protocol === 0x86dd && ip.length >= 40) {
      transport = 40;
      next = ip[6];
      address = Array.from({ length: 8 }, (_, i) => ip.readUInt16BE(24 + i * 2).toString(16)).join(":");
    } else continue;
    if (![6, 17].includes(next) || ip.length < transport + 8) continue;
    const sourcePort = ip.readUInt16BE(transport);
    const port = ip.readUInt16BE(transport + 2);
    if (outgoing && sourcePort !== 8789) connections.push({ address, port, attempted: true, source: "pcap" });
    if (next !== 17) continue;
    const payload = ip.subarray(transport + 8);
    // Docker rewrites the resolver port, so do not rely on UDP port 53 here.
    if (
      payload.length < 13 ||
      payload[2] & 0x80 ||
      payload.readUInt16BE(4) < 1 ||
      payload.readUInt16BE(4) > 20
    )
      continue;
    if (port !== 53 && address !== "127.0.0.11") continue;
    const labels = [];
    let cursor = 12;
    while (cursor < payload.length) {
      const size = payload[cursor++];
      if (!size) break;
      if (size > 63 || cursor + size > payload.length) {
        labels.length = 0;
        break;
      }
      labels.push(payload.subarray(cursor, cursor + size).toString("utf8"));
      cursor += size;
    }
    if (labels.length) dnsQueries.push(labels.join(".").toLowerCase());
  }
  return {
    connections: [...new Map(connections.map((value) => [`${value.address}:${value.port}`, value])).values()],
    dnsQueries: [...new Set(dnsQueries)],
    packets,
    truncatedPackets,
  };
}
