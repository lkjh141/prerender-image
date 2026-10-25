'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateAddress, isPrivateHost } = require('../lib/guard');

// Every way an IPv6 address can carry or stand for a private IPv4 address or a non-public range.
function groups(v4) {
  const [a, b, c, d] = v4.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}
const PRIVATE_V4 = ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.7', '198.51.100.7', '203.0.113.7'];
const PUBLIC_V4 = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1'];

test('IPv4 inside IPv6 is classified by the embedded address in every standard embedding and spelling', () => {
  for (const v4 of PRIVATE_V4) {
    const [hi, lo] = groups(v4);
    const expanded = [`0000:0000:0000:0000:0000:ffff:${hi.padStart(4, '0')}:${lo.padStart(4, '0')}`];
    const forms = [
      `::ffff:${v4}`, `::ffff:${hi}:${lo}`, `::FFFF:${hi.toUpperCase()}:${lo.toUpperCase()}`, `0:0:0:0:0:ffff:${hi}:${lo}`, ...expanded,
      `::ffff:0:${v4}`, `::ffff:0:${hi}:${lo}`, // SIIT
      `64:ff9b::${v4}`, `64:ff9b::${hi}:${lo}`, `0064:ff9b:0000:0000:0000:0000:${hi.padStart(4, '0')}:${lo.padStart(4, '0')}`, // NAT64
      `2002:${hi}:${lo}::1`, `2002:${hi}:${lo}:1:2:3:4:5`, // 6to4
      `::${v4}`, `::${hi}:${lo}`, // deprecated compatible
    ];
    for (const form of forms) assert.equal(isPrivateAddress(form), true, form);
  }
  for (const v4 of PUBLIC_V4) {
    const [hi, lo] = groups(v4);
    for (const form of [`::ffff:${v4}`, `::ffff:${hi}:${lo}`, `64:ff9b::${v4}`, `2002:${hi}:${lo}::1`]) {
      assert.equal(isPrivateAddress(form), false, form);
    }
  }
});

test('non-public IPv6 ranges are refused', () => {
  for (const address of [
    '::', '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', 'fc00::1', 'fd00::1', 'fdff:ffff::1', 'fe80::1', 'febf::1', 'fe80::1%eth0',
    'fec0::1', 'feff::1', 'ff02::1', 'ff00::', '2001:db8::1', '2001:0db8:ffff::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '100::1',
    '64:ff9b:1::1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['2606:4700::1111', '2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4001:81b::200e', '2001:4860:4860::8888', '2620:fe::fe']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('documentation, relay and benchmark IPv4 ranges are not public', () => {
  for (const address of ['192.0.2.1', '198.51.100.1', '203.0.113.255', '192.88.99.1', '198.19.255.255', '240.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('192.0.3.1'), false);
  assert.equal(isPrivateAddress('198.51.101.1'), false);
  assert.equal(isPrivateAddress('203.0.114.1'), false);
});

test('things that are not addresses are refused rather than allowed', () => {
  for (const value of ['', 'example.com', '1.2.3', 'gggg::1', '[::1', undefined, null]) assert.equal(isPrivateAddress(value), true, String(value));
});

test('bracketed IPv6 hosts are classified like bare ones', () => {
  assert.equal(isPrivateHost('[::ffff:7f00:1]'), true);
  assert.equal(isPrivateHost('[64:ff9b::7f00:1]'), true);
  assert.equal(isPrivateHost('[2606:4700::1111]'), false);
});
