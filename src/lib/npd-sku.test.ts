import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readNpdColours, readNpdSizes, readNpdSkuCodes } from './npd-sku';

// The SKU cells below are copied from NPD Tracker V7 (9 Oct 2026).
describe('readNpdSkuCodes', () => {
  it('one code', () => {
    assert.deepEqual(readNpdSkuCodes('MCSKRM'), { variants: ['MCSKRM'], unread: [] });
  });
  it('full codes, comma separated', () => {
    assert.deepEqual(readNpdSkuCodes('MRESHBG,MRESHYE,MRESHDA'), { variants: ['MRESHBG', 'MRESHYE', 'MRESHDA'], unread: [] });
    assert.deepEqual(readNpdSkuCodes('WRVSKBL,WRVSKSP'), { variants: ['WRVSKBL', 'WRVSKSP'], unread: [] });
  });
  it('one full code then colour suffixes', () => {
    assert.deepEqual(readNpdSkuCodes('UHFTPWT JB MG MB RT OW DO DM'), {
      variants: ['UHFTPWT', 'UHFTPJB', 'UHFTPMG', 'UHFTPMB', 'UHFTPRT', 'UHFTPOW', 'UHFTPDO', 'UHFTPDM'],
      unread: [],
    });
  });
  it('tabs and odd pieces are reported, never guessed', () => {
    const r = readNpdSkuCodes('WWRPTNB\tBL\tL\tOG\tM EC');
    assert.deepEqual(r.variants, ['WWRPTNB', 'WWRPTBL', 'WWRPTOG', 'WWRPTEC']);
    assert.deepEqual(r.unread, ['L', 'M']);
  });
  it('underscore codes are not read', () => {
    assert.deepEqual(readNpdSkuCodes('WAPT_RM'), { variants: [], unread: ['WAPT_RM'] });
  });
  it('empty', () => {
    assert.deepEqual(readNpdSkuCodes(''), { variants: [], unread: [] });
    assert.deepEqual(readNpdSkuCodes(null), { variants: [], unread: [] });
  });
});

describe('readNpdSizes / readNpdColours', () => {
  it('sizes', () => {
    assert.deepEqual(readNpdSizes('S,M,L,XL'), ['S', 'M', 'L', 'XL']);
    assert.deepEqual(readNpdSizes(''), []);
  });
  it('colours', () => {
    assert.deepEqual(readNpdColours('[{"color":"BOTTLE GREEN","pantone_shade":"","code":"BG"},{"color":"YELLOW","code":"YE"}]'), {
      BG: 'BOTTLE GREEN',
      YE: 'YELLOW',
    });
    assert.deepEqual(readNpdColours('not json'), {});
  });
});
