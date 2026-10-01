'use strict';

// 方案包（ZIP）导出/导入：跨工作台交接的自包含快照。
//
// 包结构（条目名固定、大小写敏感、只用 POSIX 斜杠）：
//   manifest.json          方案名称、毫米容差、快照版本、陶片（含比例尺）、
//                          按采纳顺序（ord 升序）排列的接缝、照片校验摘要
//   photos/<ref>.<ext>     陶片照片（ref = 源方案中的陶片 id，仅作包内引用）
//
// 零依赖：ZIP 使用 STORE（不压缩——陶片照片本身已是 JPEG/PNG/WebP），
// 自行实现 CRC32 / 本地头 / 中央目录读写。照片以 SHA-256 + 字节数作摘要，
// 另有 photos_digest 对全部照片摘要再做一次聚合哈希。
//
// 导入时做“整包校验”：清单结构与参数、照片摘要、缺失/重复/越界条目、
// 以及按导入容差重算的全部闭合环残差。任一不合法即抛 PackageError，
// 由调用方保证不留下方案或孤儿照片（先写临时命名的照片、最后单事务入库，
// 失败回滚并删除已写文件）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const layout = require('./layout');

const PACKAGE_FORMAT = 'sherd-stitch-workbench-package';
const FORMAT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const PHOTOS_PREFIX = 'photos/';

const MAX_SHERDS = 1000;
const MAX_SEAMS = 10000;
const MAX_ENTRIES = MAX_SHERDS + 1;

const NAME_MAX = 200;
const NOTE_MAX = 2000;
const TOL_MIN = 0.01;
const TOL_MAX = 10000;
const IMG_DIM_MAX = 20000;
const SCALE_MIN = 0.001;
const SCALE_MAX = 100000;
const THETA_MIN = -360;
const THETA_MAX = 360;
const TRANS_MIN = -100000;
const TRANS_MAX = 100000;
const REF_MAX = 2147483647;

const PHOTO_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

class PackageError extends Error {
  constructor(status, message, { reason, errors, violations } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.errors = errors || [];
    this.violations = violations;
  }
}

// ---------------- CRC32（ZIP 校验用） ----------------

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

// ---------------- ZIP 写入（STORE） ----------------

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

// entries: [{ name: string, data: Buffer }]，按给定顺序写入。
function zipEntries(entries) {
  const { time, date } = dosDateTime(new Date(2026, 0, 1, 0, 0, 0));
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // 解压所需版本
    local.writeUInt16LE(0x0800, 6);        // 标志：UTF-8 文件名
    local.writeUInt16LE(0, 8);             // 方法：STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);  // 压缩后大小（STORE == 原大小）
    local.writeUInt32LE(data.length, 22);  // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra 长度
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // 制作版本
    central.writeUInt16LE(20, 6);          // 解压版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // 磁盘号
    central.writeUInt16LE(0, 36);          // 内部属性
    central.writeUInt32LE(0, 38);          // 外部属性
    central.writeUInt32LE(offset, 42);     // 本地头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centrals) cdSize += c.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ---------------- ZIP 读取（以中央目录为准） ----------------

// 返回 [{ name, data: Buffer, size }]。结构损坏 / 不支持的特性直接抛错。
// 仅支持 STOORE/DEFLATE 非分卷、无 Zip64 的普通 ZIP（与写出的格式一致）。
function unzipEntries(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('方案包不是合法的 ZIP（内容不是字节流）');

  // EOCD 从尾部向前扫描（允许尾部注释）。
  let eocd = -1;
  if (buf.length >= 22) {
    const scanFrom = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= scanFrom; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
  }
  if (eocd < 0) throw new Error('方案包不是合法的 ZIP（找不到中央目录结尾）');
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('方案包使用了分卷 ZIP，不受支持');
  }
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('方案包使用了 Zip64 扩展，不受支持');
  }
  if (total === 0) throw new Error('方案包为空 ZIP（不含任何文件）');
  if (total > MAX_ENTRIES) throw new Error(`方案包条目过多（最多 ${MAX_ENTRIES} 项）`);
  if (cdOffset + cdSize > buf.length) throw new Error('方案包中央目录越界（文件已损坏）');
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('方案包不是合法的 ZIP（缺少本地文件头签名）');
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('方案包中央目录损坏');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('方案包使用了 Zip64 扩展，不受支持');
    }
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`方案包条目 ${name} 的本地文件头损坏或越界`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error(`方案包条目 ${name} 的数据越界（文件已损坏）`);
    }
    // 中央目录与本地头应指向同一条目（防御错位/截断）。
    const localName = buf.slice(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8');
    if (localName !== name) throw new Error(`方案包条目 ${name} 的本地头与中央目录不一致（文件已损坏）`);

    let data;
    if (method === 0) {
      if (compSize !== uncompSize) throw new Error(`方案包条目 ${name} 的 STORE 尺寸不一致`);
      data = buf.slice(dataStart, dataStart + compSize);
    } else if (method === 8) {
      // 兼容标准工具压缩出的包；导出自身使用 STORE。
      let inflated;
      try {
        inflated = require('zlib').inflateRawSync(buf.slice(dataStart, dataStart + compSize));
      } catch {
        throw new Error(`方案包条目 ${name} 解压失败（文件已损坏）`);
      }
      if (inflated.length !== uncompSize) throw new Error(`方案包条目 ${name} 解压后尺寸不符`);
      data = inflated;
    } else {
      throw new Error(`方案包条目 ${name} 使用了不支持的压缩方式（${method}）`);
    }
    if (crc32(data) !== crc) throw new Error(`方案包条目 ${name} 校验失败（CRC32 不符，文件已损坏）`);
    if (flags & 0x08) {
      // 数据描述符标志：尺寸/CRC 在中央目录中仍为权威值，已校验，放行。
    }
    entries.push({ name, data, size: uncompSize });
  }
  return entries;
}

// ---------------- 图片魔术字识别 ----------------

function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 12 &&
      buf.slice(0, 4).toString('latin1') === 'RIFF' &&
      buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// ---------------- 导出：构造清单 + 打包 ----------------

// 入参：{ project, sherds, files }（同一事务内读出的快照；files: Map(sherdId -> Buffer)）。
// 返回 { buffer, manifest, filename }。
function buildProjectPackage({ project, sherds, seams, files }) {
  const sortedSherds = sherds.slice().sort((a, b) => a.id - b.id);
  const sortedSeams = seams.slice().sort((a, b) => a.id - b.id); // id 升序即采纳顺序

  const manifestSherds = [];
  const entries = [];
  const digestLines = [];
  let totalBytes = 0;

  for (const sh of sortedSherds) {
    const data = files.get(sh.id);
    if (!data) throw new Error(`陶片 #${sh.id} 的照片在快照中缺失`);
    const kind = sniffImage(data);
    if (!kind) throw new Error(`陶片 #${sh.id} 的照片不是受支持的图片格式（JPG/PNG/WebP）`);
    const image = `${PHOTOS_PREFIX}${sh.id}.${kind}`;
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    manifestSherds.push({
      ref: sh.id,
      label: sh.label,
      image,
      sha256: sha,
      bytes: data.length,
      img_w: sh.img_w,
      img_h: sh.img_h,
      scale_px: sh.scale_px == null ? null : sh.scale_px,
      scale_mm: sh.scale_mm == null ? null : sh.scale_mm,
      note: sh.note || '',
    });
    digestLines.push(`${sha}  ${data.length}  ${image}`);
    totalBytes += data.length;
    entries.push({ name: image, data });
  }

  digestLines.sort();
  const photosDigest = crypto.createHash('sha256').update(digestLines.join('\n') + (digestLines.length ? '\n' : '')).digest('hex');

  const manifest = {
    format: PACKAGE_FORMAT,
    format_version: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    source: { project_id: project.id, version: project.version },
    project: { name: project.name, tolerance_mm: project.tolerance_mm },
    snapshot_version: project.version,
    sherds: manifestSherds,
    seams: sortedSeams.map((s, i) => ({
      ord: i + 1,
      from_ref: s.from_id,
      to_ref: s.to_id,
      theta_deg: s.theta_deg,
      tx: s.tx,
      ty: s.ty,
      join_note: s.join_note || '',
    })),
    digests: { algorithm: 'sha256', photos_digest: photosDigest },
    counts: { sherds: sortedSherds.length, seams: sortedSeams.length, photos_bytes: totalBytes },
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const zip = zipEntries([{ name: MANIFEST_NAME, data: manifestBuf }, ...entries]);
  const filename = `sherd-project-${project.id}-v${project.version}.zip`;
  return { buffer: zip, manifest, filename };
}

// ---------------- 导入：解析 + 整包校验 ----------------

function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function safePhotoName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 120) return false;
  if (name.includes('\\') || name.includes('\0')) return false;
  if (!name.startsWith(PHOTOS_PREFIX)) return false;
  const rel = name.slice(PHOTOS_PREFIX.length);
  if (!rel || rel.includes('/')) return false;
  if (rel === '.' || rel === '..' || rel.startsWith('..')) return false;
  return /^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(rel);
}

// 校验通过后返回：
// { name, toleranceMm, sherds: [{ref,label,img_w,img_h,scale_px,scale_mm,note,image,ext,data,bytes}],
//   seams: [{ord,from_ref,to_ref,theta_deg,tx,ty,join_note}] }
// 任何不合法都抛 PackageError（400 参数/结构类；422 闭合环超容差）。
function validateProjectPackage(buf, { maxPhotoBytes } = {}) {
  let entries;
  try {
    entries = unzipEntries(buf);
  } catch (e) {
    throw new PackageError(400, `无法读取方案包：${e.message}`, { reason: 'import_package_unreadable' });
  }

  const errors = [];
  const fail = (msg) => errors.push(msg);

  // 1) 条目层：重复 / 越界路径 / 非法命名
  const entryByName = new Map();
  for (const en of entries) {
    if (en.name.includes('\\') || en.name.includes('\0')) fail(`条目路径非法（含反斜杠或 NUL）：${en.name}`);
    if (en.name.startsWith('/') || en.name.startsWith('..')) fail(`条目路径越界：${en.name}`);
    if (en.name.split('/').includes('..')) fail(`条目路径越界（包含 ..）：${en.name}`);
    if (entryByName.has(en.name)) fail(`包内存在重复文件：${en.name}`);
    entryByName.set(en.name, en.data);
  }

  // 2) 清单存在且为合法 JSON、格式标识正确
  const manifestEntry = entryByName.get(MANIFEST_NAME);
  let manifest = null;
  if (!manifestEntry) {
    fail('缺少清单文件 manifest.json');
  } else {
    try {
      manifest = JSON.parse(manifestEntry.toString('utf8'));
    } catch {
      fail('清单文件 manifest.json 不是合法 JSON');
    }
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      if (manifest.format !== PACKAGE_FORMAT) fail(`清单格式标识不符（format=${JSON.stringify(manifest.format)}）`);
      if (manifest.format_version !== FORMAT_VERSION) fail(`清单格式版本不受支持（format_version=${manifest.format_version}）`);
    } else if (manifest !== null) {
      fail('清单顶层必须是对象');
      manifest = null;
    }
  }
  if (errors.length) throw new PackageError(400, `方案包校验失败：${errors[0]}`, { reason: 'import_package_invalid', errors });

  // 3) 方案参数
  if (!manifest.project || typeof manifest.project !== 'object' || Array.isArray(manifest.project)) {
    fail('清单缺少 project 对象（name / tolerance_mm）');
  }
  const proj = manifest.project || {};
  const name = typeof proj.name === 'string' ? proj.name.trim() : '';
  if (!name) fail('缺少方案名称 project.name');
  else if (name.length > NAME_MAX) fail(`方案名称过长（最多 ${NAME_MAX} 字符）`);
  const tolerance = isNum(proj.tolerance_mm) ? proj.tolerance_mm : NaN;
  if (!Number.isFinite(tolerance)) fail('毫米容差 project.tolerance_mm 必须是数字');
  else if (tolerance < TOL_MIN || tolerance > TOL_MAX) fail(`毫米容差超出允许范围（${TOL_MIN} ~ ${TOL_MAX} mm）`);

  // 4) 陶片清单
  const rawSherds = Array.isArray(manifest.sherds) ? manifest.sherds : null;
  if (!rawSherds) {
    fail('清单 sherds 必须是数组');
  } else if (rawSherds.length === 0) {
    fail('清单中没有任何陶片（空方案包不予导入）');
  } else if (rawSherds.length > MAX_SHERDS) {
    fail(`陶片数量超过上限（最多 ${MAX_SHERDS} 片）`);
  }

  const rawSeams = Array.isArray(manifest.seams) ? manifest.seams : null;
  if (!rawSeams) fail('清单 seams 必须是数组');
  else if (rawSeams.length > MAX_SEAMS) fail(`接缝数量超过上限（最多 ${MAX_SEAMS} 条）`);

  if (errors.length) throw new PackageError(400, `方案包校验失败：${errors[0]}`, { reason: 'import_package_invalid', errors });

  const sherds = [];
  const refs = new Set();
  const declaredImages = new Set();

  rawSherds.forEach((sh, i) => {
    const where = `陶片清单第 ${i + 1} 项`;
    if (!sh || typeof sh !== 'object' || Array.isArray(sh)) return fail(`${where} 必须是对象`);
    if (!isInt(sh.ref) || sh.ref < 1 || sh.ref > REF_MAX) return fail(`${where} 的 ref 必须是正整数`);
    if (refs.has(sh.ref)) return fail(`${where} 的 ref=${sh.ref} 重复`);
    refs.add(sh.ref);

    if (typeof sh.label !== 'string' || !sh.label.trim()) fail(`${where}（ref=${sh.ref}）缺少 label`);
    else if (sh.label.length > NAME_MAX) fail(`${where}（ref=${sh.ref}）label 过长（最多 ${NAME_MAX} 字符）`);
    if (typeof sh.note !== 'undefined' && sh.note !== null && typeof sh.note !== 'string') {
      fail(`${where}（ref=${sh.ref}）note 必须是字符串`);
    } else if (typeof sh.note === 'string' && sh.note.length > NOTE_MAX) {
      fail(`${where}（ref=${sh.ref}）note 过长（最多 ${NOTE_MAX} 字符）`);
    }
    if (!isInt(sh.img_w) || sh.img_w < 1 || sh.img_w > IMG_DIM_MAX) fail(`${where}（ref=${sh.ref}）img_w 非法（1 ~ ${IMG_DIM_MAX}）`);
    if (!isInt(sh.img_h) || sh.img_h < 1 || sh.img_h > IMG_DIM_MAX) fail(`${where}（ref=${sh.ref}）img_h 非法（1 ~ ${IMG_DIM_MAX}）`);

    const scaleOk = (v) => v === null || (isNum(v) && v >= SCALE_MIN && v <= SCALE_MAX);
    const pxMissing = sh.scale_px === undefined || sh.scale_mm === undefined;
    const scaleNull = sh.scale_px === null && sh.scale_mm === null;
    const scalePartial = sh.scale_px === null || sh.scale_mm === null
      ? sh.scale_px !== sh.scale_mm
      : false;
    if (pxMissing) {
      fail(`${where}（ref=${sh.ref}）缺少比例尺字段 scale_px/scale_mm（未标比例尺时须同时显式为 null）`);
    } else if (scalePartial || !scaleOk(sh.scale_px) || !scaleOk(sh.scale_mm)) {
      fail(`${where}（ref=${sh.ref}）比例尺非法：scale_px/scale_mm 必须同时为 null 或同时为 ${SCALE_MIN} ~ ${SCALE_MAX} 的数字`);
    }

    if (typeof sh.image !== 'string' || !safePhotoName(sh.image)) {
      fail(`${where}（ref=${sh.ref}）照片路径非法（应为 photos/<ref>.<jpg|png|webp>）`);
      return;
    }
    if (declaredImages.has(sh.image)) fail(`${where}（ref=${sh.ref}）照片路径 ${sh.image} 被多片共用`);
    declaredImages.add(sh.image);

    if (!isInt(sh.bytes) || sh.bytes < 1) fail(`${where}（ref=${sh.ref}）bytes 摘要必须是正整数`);
    else if (maxPhotoBytes && sh.bytes > maxPhotoBytes) {
      fail(`${where}（ref=${sh.ref}）照片超过单张大小上限（${Math.round(maxPhotoBytes / 1048576)} MB）`);
    }
    if (typeof sh.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sh.sha256)) {
      fail(`${where}（ref=${sh.ref}）sha256 摘要必须是 64 位十六进制`);
    }

    const data = entryByName.get(sh.image);
    if (!data) {
      fail(`${where}（ref=${sh.ref}）缺少照片文件 ${sh.image}`);
      return;
    }
    if (isInt(sh.bytes) && sh.bytes >= 1 && data.length !== sh.bytes) {
      fail(`${where}（ref=${sh.ref}）照片实际字节数（${data.length}）与摘要（${sh.bytes}）不符`);
    }
    const actualSha = crypto.createHash('sha256').update(data).digest('hex');
    if (typeof sh.sha256 === 'string' && /^[0-9a-f]{64}$/.test(sh.sha256) && actualSha !== sh.sha256) {
      fail(`${where}（ref=${sh.ref}）照片 SHA-256 与摘要不符（文件已损坏或被替换）`);
    }
    const ext = path.posix.extname(sh.image).slice(1).toLowerCase();
    const sniffed = sniffImage(data);
    if (!sniffed) fail(`${where}（ref=${sh.ref}）照片不是受支持的图片格式（JPG/PNG/WebP）`);
    else if (!((ext === 'jpg' || ext === 'jpeg') && sniffed === 'jpg') && sniffed !== ext) {
      fail(`${where}（ref=${sh.ref}）照片内容（${sniffed}）与扩展名（${ext}）不符`);
    }

    sherds.push({
      ref: sh.ref,
      label: sh.label,
      note: typeof sh.note === 'string' ? sh.note : '',
      image: sh.image,
      ext: sniffed || ext,
      data,
      bytes: data.length,
      img_w: sh.img_w,
      img_h: sh.img_h,
      scale_px: scaleNull ? null : sh.scale_px,
      scale_mm: scaleNull ? null : sh.scale_mm,
    });
  });

  // 5) 条目集合必须恰好等于 {manifest.json} ∪ 声明照片：多余文件整包拒绝
  for (const en of entries) {
    if (en.name === MANIFEST_NAME) continue;
    if (!safePhotoName(en.name)) {
      fail(`包含非法或越界路径的条目：${en.name}`);
    } else if (!declaredImages.has(en.name)) {
      fail(`包内存在清单未引用的多余文件：${en.name}`);
    }
  }

  // 6) 聚合照片摘要（对实际解出字节重算，连同清单声明一起复核）
  if (manifest.digests && typeof manifest.digests === 'object' && !Array.isArray(manifest.digests)
      && typeof manifest.digests.photos_digest !== 'undefined') {
    if (typeof manifest.digests.photos_digest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.digests.photos_digest)) {
      fail('digests.photos_digest 必须是 64 位十六进制 SHA-256');
    } else {
      const lines = sherds
        .map((sh) => `${crypto.createHash('sha256').update(sh.data).digest('hex')}  ${sh.bytes}  ${sh.image}`)
        .sort();
      const actual = crypto.createHash('sha256').update(lines.join('\n') + (lines.length ? '\n' : '')).digest('hex');
      if (actual !== manifest.digests.photos_digest) fail('照片聚合摘要 photos_digest 不符（照片集合已被改动）');
    }
  } else {
    fail('清单缺少 digests.photos_digest 照片聚合摘要');
  }

  // 7) 接缝：按采纳顺序（ord）排列，参数范围、端点引用、同片检查
  const seams = [];
  const ords = new Set();
  const sherdByRef = new Map(sherds.map((sh) => [sh.ref, sh]));
  rawSeams.forEach((se, i) => {
    const where = `接缝清单第 ${i + 1} 项`;
    if (!se || typeof se !== 'object' || Array.isArray(se)) return fail(`${where} 必须是对象`);
    if (!isInt(se.ord) || se.ord < 1 || se.ord > REF_MAX) return fail(`${where} 的 ord 必须是正整数`);
    if (ords.has(se.ord)) return fail(`${where} 的 ord=${se.ord} 重复（采纳顺序必须唯一）`);
    ords.add(se.ord);
    if (!isInt(se.from_ref) || !isInt(se.to_ref)) return fail(`${where}（ord=${se.ord}）from_ref/to_ref 必须是整数`);
    if (se.from_ref === se.to_ref) fail(`${where}（ord=${se.ord}）接缝连接了同一片陶片`);
    const from = sherdByRef.get(se.from_ref);
    const to = sherdByRef.get(se.to_ref);
    if (!from || !to) {
      fail(`${where}（ord=${se.ord}）端点陶片不在本方案包内（from_ref=${se.from_ref}, to_ref=${se.to_ref}）`);
    } else {
      if (from.scale_px == null || to.scale_px == null) {
        fail(`${where}（ord=${se.ord}）接缝两端的陶片缺少毫米比例尺`);
      }
    }
    if (!isNum(se.theta_deg) || se.theta_deg < THETA_MIN || se.theta_deg > THETA_MAX) {
      fail(`${where}（ord=${se.ord}）theta_deg 非法（${THETA_MIN} ~ ${THETA_MAX}）`);
    }
    for (const k of ['tx', 'ty']) {
      if (!isNum(se[k]) || se[k] < TRANS_MIN || se[k] > TRANS_MAX) {
        fail(`${where}（ord=${se.ord}）${k} 非法（${TRANS_MIN} ~ ${TRANS_MAX} mm）`);
      }
    }
    if (se.join_note !== null && typeof se.join_note !== 'undefined' && typeof se.join_note !== 'string') {
      fail(`${where}（ord=${se.ord}）join_note 必须是字符串`);
    } else if (typeof se.join_note === 'string' && se.join_note.length > NOTE_MAX) {
      fail(`${where}（ord=${se.ord}）join_note 过长（最多 ${NOTE_MAX} 字符）`);
    }
    // 参数齐备且端点合法的接缝才参与下一步的几何复核；
    // 字段非法的情况已经记录到 errors，稍后整包拒绝。
    if (isNum(se.theta_deg) && isNum(se.tx) && isNum(se.ty) && from && to
        && from.scale_px != null && to.scale_px != null) {
      seams.push({
        ord: se.ord,
        from_ref: se.from_ref,
        to_ref: se.to_ref,
        theta_deg: se.theta_deg,
        tx: se.tx,
        ty: se.ty,
        join_note: typeof se.join_note === 'string' ? se.join_note : '',
      });
    }
  });

  if (errors.length) {
    throw new PackageError(400,
      `方案包校验失败（${errors.length} 处问题）：${errors[0]}`,
      { reason: 'import_package_invalid', errors });
  }

  // 8) 全部闭合环复核：用包内容（ref 当陶片 id、ord 当接缝采纳序）现算布局，
  //    任一残差超过包声明容差即整包拒绝——源方案的等价性在此把关。
  seams.sort((a, b) => a.ord - b.ord);
  const synSherds = sherds.map((sh) => ({
    id: sh.ref,
    img_w: sh.img_w,
    img_h: sh.img_h,
    scale_px: sh.scale_px,
    scale_mm: sh.scale_mm,
  }));
  const synSeams = seams.map((se) => ({
    id: se.ord,
    from_id: se.from_ref,
    to_id: se.to_ref,
    theta_deg: se.theta_deg,
    tx: se.tx,
    ty: se.ty,
  }));
  const detailed = layout.computeLayoutDetailed(synSherds, synSeams, tolerance);
  const violations = detailed.residuals.filter((r) => !r.within_tolerance);
  if (violations.length) {
    throw new PackageError(422,
      `方案包中 ${violations.length} 个闭合环残差超过声明容差 ${tolerance} mm，整包拒绝导入。`,
      {
        reason: 'import_cycle_tolerance_exceeded',
        tolerance_mm: tolerance,
        violations: violations.map((v) => ({
          ord: synSeams.find((s) => s.id === v.seam_id) ? v.seam_id : null,
          from_ref: v.from_id,
          to_ref: v.to_ref,
          deviation_mm: v.distance_mm,
          rotation_deg: v.rotation_deg,
          tolerance_mm: tolerance,
        })),
      });
  }

  return {
    name,
    tolerance_mm: tolerance,
    sherds: sherds.sort((a, b) => a.ref - b.ref),
    seams,
    snapshot_version: isInt(manifest.snapshot_version) ? manifest.snapshot_version : null,
  };
}

// 在导入事务中使用：生成照片落地文件名（与上传同一目录、同一随机命名约定）。
function planImportFilenames(parsed) {
  return parsed.sherds.map((sh) => ({
    sherd: sh,
    filename: `sherd_import_${Date.now()}_${Math.round(Math.random() * 1e9)}_${Math.round(Math.random() * 1e9)}.${sh.ext}`,
  }));
}

module.exports = {
  PACKAGE_FORMAT,
  FORMAT_VERSION,
  buildProjectPackage,
  validateProjectPackage,
  planImportFilenames,
  zipEntries,
  unzipEntries,
  sniffImage,
  PackageError,
};
