const { createHash } = require('node:crypto');

const turns = [
  {
    user: '继续本地 mock 日历 Serein 的 autumn-pair 导入，数据集 repeated-hour，工作区 clock-lab。两条 01:30 不应被当成同一时刻，先查导入协议。',
    text: 'Serein mock, repeated-hour in clock-lab: convert with timefold resolve --preserve-offset. Identify a row by (local_time, utc_offset), never local_time alone. Offset-free rows must await disambiguation, not be guessed. Conversion success alone does not verify the imported instants.',
    hash: '6568e0611cc111048928993889c9508e94497667be9f748c4120119c3a33039e',
  },
  {
    user: '同一个 Serein autumn-pair / repeated-hour / clock-lab 任务，按协议转换带偏移量的两行，缺偏移量的先留下。然后我们再核验目标日历。',
    text: 'Serein local mock conversion autumn-pair, repeated-hour, clock-lab: 01:30/-04:00 -> 05:30Z; 01:30/-05:00 -> 06:30Z. Two offset-bearing rows converted to separate import entries. One offset-free row retained unresolved; no guessed offset. Import staging accepted both entries. Target-calendar roundtrip audit has not yet been inspected.',
    hash: '3ef5db8d2335372e68b9f788ae391419cd420440f65429df690e506f1e6dfa7b',
    command: 'mock-timefold resolve --preserve-offset --dataset repeated-hour --workspace clock-lab --batch autumn-pair',
  },
  {
    user: '现在核验同一批 autumn-pair 在 Serein repeated-hour / clock-lab 目标日历里的两个时刻。请查独立 roundtrip 审计，判断下次这种重复时钟小时要怎样确认导入正确。',
    text: 'Independent Serein target-calendar audit: autumn-pair/repeated-hour/clock-lab has distinct 05:30Z and 06:30Z entries. Roundtrip recovers each original local_time AND utc_offset; unresolved rows remain absent. Acceptance for repeated-hour imports requires distinct instants, both roundtrip fields unchanged, and no unresolved row imported. Converter output is not this audit.',
    hash: 'e9b1cbb7f9e4ad286b9e8ae17f8c0d62edd1e1a255762e13b59fcd04d7b9f31c',
    command: 'mock-calendar-audit roundtrip --dataset repeated-hour --workspace clock-lab --batch autumn-pair',
  },
];
const statement = 'Serein mock autumn-pair/repeated-hour in clock-lab: use timefold resolve --preserve-offset; key rows by (local_time, utc_offset), never local_time alone; never guess missing offsets. Accept imports only after independent target-calendar roundtrip confirms distinct instants, unchanged local_time AND utc_offset, and no unresolved rows imported; converter output is insufficient.';
const custody = {
  synthetic: true,
  result_sha256: '44b4848e287cea3bb1fb89394d257647312231993ed5cb1c2bef3544154198e8',
  input_sha256: 'c816cf7fb1410ccbe4677e7410d08d0749cb86062be0163fa9b6077b6f75bf8b',
  original_packet_sha256: '64cf9f1d625fb8edc14177a86965f7a188cd2cf34b552d2fa72bd0a2e477e6bb',
  original_packet_bytes: 13700,
  original_proposal_bytes: 1447,
  original_body_cp: 1183,
  remapping: 'Host IDs, timestamps, repository identity and sandbox locators are fresh; original synthetic source texts and proposal statement are unchanged.',
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
function propose(packet) {
  const citations = [turns[0], turns[2]].map((turn) => {
    const source = packet.sources.find((entry) => entry.content_hash === turn.hash);
    return { source_id: source.source_id, content_hash: source.content_hash, span: source.span, quote: source.text };
  });
  return { candidates: [{ kind: 'context', statements: [{ text: statement, citations }] }] };
}

module.exports = { turns, statement, custody, digest, propose };
