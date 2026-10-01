'use strict';

// 极简 ZIP 读写器（无第三方依赖），仅供方案包导出/导入使用。
//
// 写入：单盘、无加密、无 ZIP64；method 0 = STORED（照片本身已是 JPEG/PNG/WebP
// 压缩格式）或 method 8 = DEFLATE（zlib raw deflate，用于 manifest.json）。
// 读取：仅支持上述两种压缩方式，逐条用中央目录定位本地文件头并校验
// CRC32 与解压后长度——任何截断/位翻转/伪装格式都会在此暴露。
//
// 本模块只负责 ZIP 容器；条目名是否越界（绝对路径、..、盘符等）由
// src/package.js 的清单校验负责。

const zlib = require('zlib');

class ZipError extends Error {}

// ---------- CRC32（PKZIP / zlib 同一多项式） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- DOS 时间/日期 ----------

function dosDateTime(date) {
  const d = date || new Date();
  return {
    dosTime: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31),
    dosDate: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

// ---------- 写入 ----------

// entries: [{ name: string, data: Buffer|string, method?: 0|8, date?: Date }]
// 返回 ZIP Buffer。默认 STORED；manifest 等小文本由调用方显式 method:8。
function writeZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new ZipError('ZIP 至少需要一个条目');
  if (entries.length > 0xffff) throw new ZipError('条目数超过 65535（需要 ZIP64，本工作台不产生这种包）');

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name), 'utf8');
    if (nameBuf.length > 0xffff) throw new ZipError(`条目名过长: ${entry.name}`);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    if (data.length > 0xffffffff) throw new ZipError(`条目过大: ${entry.name}`);
    const method = entry.method === 8 ? 8 : 0;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const flags = 0x0800; // 条目名按 UTF-8 解析
    const { dosTime, dosDate } = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本 2.0
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 无 extra
    localChunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录文件头签名
    cd.writeUInt16LE(20, 4); // 打包版本（2.0，DOS）
    cd.writeUInt16LE(20, 6); // 解压所需版本
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // 盘号
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    centralChunks.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuffer = Buffer.concat(centralChunks);
  if (cdBuffer.length > 0xffffffff || offset > 0xffffffff) {
    throw new ZipError('包体超过 4 GiB（需要 ZIP64，本工作台不产生这种包）');
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4); // 盘号
  eocd.writeUInt16LE(0, 6); // 中央目录所在盘号
  eocd.writeUInt16LE(entries.length, 8); // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 总条目数
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录起始偏移
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localChunks, cdBuffer, eocd]);
}

// ---------- 读取 ----------

const DEFAULT_LIMITS = {
  maxEntries: 50000,
  maxEntryUncompressed: 64 * 1024 * 1024, // 单条解压后 64 MiB
  maxTotalUncompressed: 512 * 1024 * 1024, // 整包解压后 512 MiB（防 zip bomb）
};

function readUInt16(buf, off, what) {
  if (off + 2 > buf.length) throw new ZipError(`ZIP 结构损坏：${what} 越界`);
  return buf.readUInt16LE(off);
}
function readUInt32(buf, off, what) {
  if (off + 4 > buf.length) throw new ZipError(`ZIP 结构损坏：${what} 越界`);
  return buf.readUInt32LE(off);
}

// 解析 ZIP，返回 [{ name, data: Buffer, method, crc32 }]，顺序即包内中央目录顺序。
// 任何结构异常、不支持的特性（加密/分盘/ZIP64/未知压缩法）或 CRC 不符都抛 ZipError。
function readZip(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer)) throw new ZipError('方案包必须是 ZIP 二进制内容');
  const lim = { ...DEFAULT_LIMITS, ...limits };
  if (buffer.length < 22) throw new ZipError('文件过小，不是合法的 ZIP 方案包');

  // 从尾部扫描 EOCD（允许尾部最多 64KiB - 22 的注释）。
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('找不到 ZIP 中央目录结尾（EOCD），不是合法的 ZIP 方案包');

  const disk = readUInt16(buffer, eocd + 4, 'EOCD 盘号');
  const cdDisk = readUInt16(buffer, eocd + 6, 'EOCD 中央目录盘号');
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('不支持分盘 ZIP 方案包');
  const entriesDisk = readUInt16(buffer, eocd + 8, 'EOCD 条目数');
  const totalEntries = readUInt16(buffer, eocd + 10, 'EOCD 总条目数');
  if (entriesDisk !== totalEntries) throw new ZipError('不支持分盘 ZIP 方案包');
  if (totalEntries === 0xffff) throw new ZipError('ZIP64 方案包不受支持');
  if (totalEntries > lim.maxEntries) throw new ZipError(`ZIP 条目数超过上限 ${lim.maxEntries}`);

  let cdOffset = readUInt32(buffer, eocd + 16, 'EOCD 中央目录偏移');
  let cdSize = readUInt32(buffer, eocd + 12, 'EOCD 中央目录长度');
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipError('ZIP64 方案包不受支持');
  if (cdOffset >= buffer.length || cdOffset + cdSize > buffer.length) {
    throw new ZipError('ZIP 中央目录越界，方案包已损坏');
  }

  const result = [];
  let totalUncompressed = 0;
  let p = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdOffset + cdSize) throw new ZipError('中央目录文件头越界，方案包已损坏');
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new ZipError('中央目录签名错误，方案包已损坏');

    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);

    if (flags & 0x0001) throw new ZipError('加密的 ZIP 方案包不受支持');
    if (method !== 0 && method !== 8) throw new ZipError(`ZIP 压缩方式 ${method} 不受支持（仅支持 STORED/DEFLATE）`);
    if (uncompSize > lim.maxEntryUncompressed) {
      throw new ZipError('ZIP 单条解压后体积超过上限，疑似压缩炸弹');
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > lim.maxTotalUncompressed) {
      throw new ZipError('ZIP 整包解压后体积超过上限，疑似压缩炸弹');
    }

    const nameStart = p + 46;
    if (nameStart + nameLen + extraLen + commentLen > cdOffset + cdSize) {
      throw new ZipError('中央目录条目内容越界，方案包已损坏');
    }
    const name = buffer.slice(nameStart, nameStart + nameLen).toString('utf8');
    p = nameStart + nameLen + extraLen + commentLen;

    // 定位本地文件头并取出压缩数据（长度以中央目录登记值为准）。
    if (localOffset + 30 > buffer.length) throw new ZipError(`本地文件头越界: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`本地文件头签名错误: ${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buffer.length) throw new ZipError(`条目数据越界: ${name}`);
    const compData = buffer.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = compData;
    } else {
      try {
        data = zlib.inflateRawSync(compData, { maxOutputLength: lim.maxEntryUncompressed });
      } catch (e) {
        throw new ZipError(`DEFLATE 数据解压失败: ${name}（方案包已损坏）`);
      }
    }
    if (data.length !== uncompSize) {
      throw new ZipError(`条目解压后长度与清单登记不符: ${name}（方案包已损坏）`);
    }
    if (crc32(data) !== crc) {
      throw new ZipError(`条目 CRC32 校验失败: ${name}（方案包已损坏或被篡改）`);
    }
    result.push({ name, data, method, crc32: crc });
  }

  return result;
}

module.exports = { writeZip, readZip, crc32, ZipError };
