'use strict';
/**
 * Writers for BDMV/index.bdmv and BDMV/MovieObject.bdmv.
 *
 * index.bdmv is rebuilt from the one tsMuxeR produced so the AppInfo block and the
 * UHD (version 0300) extension data stay exactly as tsMuxeR computed them; only the
 * Indexes() section (First Play, Top Menu, Titles) is replaced.
 */
const fs = require('fs');

/**
 * movieObjects: [{ commands: [Buffer(12)], resume?: bool, menuCallMask?: bool, titleSearchMask?: bool }]
 */
function buildMovieObject(version, movieObjects) {
  const objs = movieObjects.map((o) => {
    const head = Buffer.alloc(4);
    head[0] = (o.resume ? 0x80 : 0) | (o.menuCallMask ? 0x40 : 0) | (o.titleSearchMask ? 0x20 : 0);
    head.writeUInt16BE(o.commands.length, 2);
    return Buffer.concat([head, ...o.commands]);
  });
  const payload = Buffer.concat([Buffer.alloc(4), u16(movieObjects.length), ...objs]);
  const header = Buffer.alloc(40);
  header.write('MOBJ', 0, 'ascii');
  header.write(version, 4, 'ascii');
  header.writeUInt32BE(0, 8); // extension data start
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  return Buffer.concat([header, len, payload]);
}

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };

function hdmvEntry(objectId, interactive) {
  const b = Buffer.alloc(12);
  b[0] = 0x40; // object_type = 1 (HDMV)
  b[4] = interactive ? 0x40 : 0x00; // playback_type: 0 movie, 1 interactive
  b.writeUInt16BE(objectId, 6);
  return b;
}

function titleEntry(objectId) {
  const b = Buffer.alloc(12);
  b[0] = 0x40; // object_type HDMV, access_type 0 (permitted)
  b[4] = 0x00; // movie title
  b.writeUInt16BE(objectId, 6);
  return b;
}

/**
 * Rebuild index.bdmv.
 * template: Buffer of tsMuxeR's index.bdmv
 * nav: { firstPlayObject, topMenuObject, titleObjects: [objectId...] }
 */
function rebuildIndex(template, nav) {
  if (template.toString('ascii', 0, 4) !== 'INDX') throw new Error('index.bdmv template invalid');
  const version = template.toString('ascii', 4, 8);
  const indexesStart = template.readUInt32BE(8);
  const extStart = template.readUInt32BE(12);
  const appInfo = template.subarray(40, indexesStart);
  const extension = extStart ? template.subarray(extStart) : Buffer.alloc(0);

  const body = Buffer.concat([
    hdmvEntry(nav.firstPlayObject, true),
    hdmvEntry(nav.topMenuObject, true),
    u16(nav.titleObjects.length),
    ...nav.titleObjects.map((id) => titleEntry(id)),
  ]);
  const indexes = Buffer.concat([u32(body.length), body]);
  const header = Buffer.alloc(40);
  header.write('INDX', 0, 'ascii');
  header.write(version, 4, 'ascii');
  const newIndexesStart = 40 + appInfo.length;
  header.writeUInt32BE(newIndexesStart, 8);
  let pad = Buffer.alloc(0);
  let newExtStart = 0;
  if (extension.length) {
    let end = newIndexesStart + indexes.length;
    const aligned = (end + 3) & ~3;
    pad = Buffer.alloc(aligned - end);
    newExtStart = aligned;
  }
  header.writeUInt32BE(newExtStart, 12);
  return { buffer: Buffer.concat([header, appInfo, indexes, pad, extension]), version };
}

const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };

function writeNavigation(bdmvDir, nav, movieObjects) {
  const tplPath = `${bdmvDir}/index.bdmv`;
  const { buffer, version } = rebuildIndex(fs.readFileSync(tplPath), nav);
  const mobj = buildMovieObject(version, movieObjects);
  for (const dir of [bdmvDir, `${bdmvDir}/BACKUP`]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/index.bdmv`, buffer);
    fs.writeFileSync(`${dir}/MovieObject.bdmv`, mobj);
  }
}

module.exports = { buildMovieObject, rebuildIndex, writeNavigation };
