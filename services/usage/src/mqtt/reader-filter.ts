/** A bounded MQTT 3.1.1 reader surface; broker ACLs remain required too. */
export function createMqttReaderFilter(prefix: string, maxBytes: number) {
  const allowed = new Set(
    ["state", "heartbeat", "availability"].map(
      (name) => `${prefix.replace(/\/+$/, "")}/usage/${name}`,
    ),
  );
  let pending = Buffer.alloc(0),
    connected = false,
    ended = false;
  const deny = (): never => {
    throw Error("mqtt_reader_denied");
  };
  function check(packet: Buffer, offset: number) {
    const type = packet[0] >> 4,
      flags = packet[0] & 15;
    const body = packet.subarray(offset);
    if (ended) deny();
    if (type === 1) {
      if (
        connected ||
        flags ||
        body.length < 12 ||
        body.readUInt16BE(0) !== 4 ||
        body.subarray(2, 6).toString() !== "MQTT" ||
        body[6] !== 4 ||
        body[7] !== 2 ||
        body.readUInt16BE(10) !== body.length - 12
      )
        deny();
      connected = true;
      return;
    }
    if (!connected) deny();
    if (type === 12 || type === 14) {
      if (flags || body.length) deny();
      if (type === 14) ended = true;
      return;
    }
    if (type === 4) {
      if (flags || body.length !== 2 || !body.readUInt16BE(0)) deny();
      return;
    }
    if (
      (type !== 8 && type !== 10) ||
      flags !== 2 ||
      body.length < 5 ||
      !body.readUInt16BE(0)
    )
      deny();
    let cursor = 2,
      count = 0;
    while (cursor < body.length) {
      if (cursor + 2 > body.length) deny();
      const size = body.readUInt16BE(cursor);
      cursor += 2;
      if (!size || cursor + size > body.length) deny();
      let topic: string;
      try {
        topic = new TextDecoder("utf-8", { fatal: true }).decode(
          body.subarray(cursor, cursor + size),
        );
      } catch {
        deny();
      }
      cursor += size;
      if (!allowed.has(topic!)) deny();
      if (type === 8 && (cursor >= body.length || body[cursor++] > 1)) deny();
      count++;
    }
    if (!count) deny();
  }
  return (chunk: Uint8Array): Buffer[] => {
    if (pending.length + chunk.byteLength > maxBytes + 5) deny();
    pending = Buffer.concat([pending, chunk]);
    const packets: Buffer[] = [];
    while (pending.length >= 2) {
      let length = 0,
        multiplier = 1,
        cursor = 1;
      while (true) {
        if (cursor >= pending.length) return packets;
        const byte = pending[cursor++];
        length += (byte & 127) * multiplier;
        if (length > maxBytes || (cursor === 5 && byte & 128)) deny();
        if (!(byte & 128)) break;
        multiplier *= 128;
      }
      if (pending.length < cursor + length) break;
      const packet = Buffer.from(pending.subarray(0, cursor + length));
      check(packet, cursor);
      packets.push(packet);
      pending = Buffer.from(pending.subarray(cursor + length));
    }
    return packets;
  };
}
