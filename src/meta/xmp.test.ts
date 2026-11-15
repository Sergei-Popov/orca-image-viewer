import { assert, test } from 'orca/testing'
import { stripXpacket, xmpProperties, xmpSection } from './xmp'

const props = (packet: string) => Object.fromEntries(xmpProperties(packet).map((i) => [i.key, i.value]))

test('XMP properties: attributes, simple values, language alternatives, bags, structures; comments and history skipped', () => {
  const packet = [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmp:CreatorTool="Paint 3" xmp:Rating = "4">',
    '<!-- <dc:hidden>in a comment</dc:hidden> -->',
    '<dc:format>image/tiff</dc:format>',
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Sunset &amp; sea</rdf:li><rdf:li xml:lang="ru">Закат</rdf:li></rdf:Alt></dc:title>',
    '<dc:subject><rdf:Bag><rdf:li>a</rdf:li><rdf:li>b</rdf:li><rdf:li></rdf:li></rdf:Bag></dc:subject>',
    '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:when>2026</stEvt:when></rdf:li></rdf:Seq></xmpMM:History>',
    '<Iptc4xmpCore:CreatorContactInfo rdf:parseType="Resource"><Iptc4xmpCore:CiAdrCity>Riga</Iptc4xmpCore:CiAdrCity></Iptc4xmpCore:CreatorContactInfo>',
    '<crs:Empty/><tiff:Orientation>1</tiff:Orientation>',
    '</rdf:Description></rdf:RDF></x:xmpmeta>'
  ].join('\n')
  assert.deepEqual(props(packet), {
    'xmp:CreatorTool': 'Paint 3',
    'xmp:Rating': '4',
    'dc:format': 'image/tiff',
    'dc:title': 'Sunset & sea, Закат',
    'dc:subject': 'a, b',
    'Iptc4xmpCore:CiAdrCity': 'Riga',
    'tiff:Orientation': '1'
  })
})

test('XMP damaged packets: long runs, unclosed tags and quotes, deep nesting all parse in one pass', () => {
  const head = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description '
  const size = 1 << 20
  const packets = [
    `${head}${'a'.repeat(size)}></rdf:Description><dc:format>x</dc:format></rdf:RDF></x:xmpmeta>`,
    `${head}>${'<a:b>'.repeat(size / 5)}`,
    `${head}>${'<rdf:Description a:b="x '.repeat(size / 24)}`,
    `${'<a:b>'.repeat(63)}${'</c:d>'.repeat(size / 6)}`,
    `${head}>${'<dc:x><rdf:Bag><rdf:li>'.repeat(size / 24)}`,
    // Unclosed xpacket instructions: each start used to scan on to the next '>'.
    `${head}>${'<?xpacket '.repeat(size / 10)}`,
    `${'<?xpacket begin="'.repeat(size / 17)}>${head}`
  ]
  for (const p of packets) {
    const started = Date.now()
    xmpSection(p)
    assert.ok(Date.now() - started < 1000, `${p.slice(0, 80)}… parsed at once`)
  }
  assert.equal(props(packets[0])['dc:format'], 'x')
})

test('XMP xpacket instructions: removed as the old pattern removed them, anywhere in the packet', () => {
  const pattern = (t: string) => t.replace(/<\?xpacket[^>]*\?>/g, '')
  const cases = [
    '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta/><?xpacket end="w"?>',
    '<?xpacket?>a<?xpacket ?>b',
    '<?xpacket begin="" > not closed ?> <x/>',
    '<?xpacket <?xpacket end="r"?> tail',
    'no instructions at all',
    '<?xpacket',
    '<?xpacket>?>',
    'a<?xpacket b<?xpacket c?>d?>e>'
  ]
  for (const c of cases) assert.equal(stripXpacket(c), pattern(c), c)
})
