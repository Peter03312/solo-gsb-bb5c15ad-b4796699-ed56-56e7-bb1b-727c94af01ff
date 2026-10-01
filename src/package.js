'use strict';

// 方案移交包（自包含 ZIP）：
//
//   manifest.json
//   photos/sherd-0001.jpg
//   photos/sherd-0002.png
//   ...
//
// manifest 记录方案名称、毫米容差、导出时版本快照、按导出顺序的陶片（含照片
// 路径、图像像素尺寸、毫米比例尺与照片校验摘要 SHA-256/字节数）、按采纳顺序
// 排列的接缝（from_seq/to_seq 引用陶片序号）。
//
// 导入时做整包校验：清单格式与参数、照片摘要（SHA-256/字节数）、缺失/重复/
// 多余文件、越界路径、照片魔数、接缝引用，并在“重分配本地 ID”后用同一套
// 布局引擎复核全部闭合环是否超容差。任何问题都整包拒绝。

const crypto = require('crypto');
const { writeZip, readZip, ZipError } = require('./zip');
const layout = require('./layout');

const PACKAGE_FORMAT = 'sherd-stitch-workbench';
const PACKAGE_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const PHOTOS_DIR = 'photos/';

const MAX_NAME = 200;
const MAX_LABEL = 100;
const MAX_NOTE = 2000;
const MAX_JOIN_NOTE = 2000;
const MAX_PHOTO_BYTES = 64 * 1024 * 1024;
const MAX_SHERDS = 20000;
const MAX_SEAMS = 100000;

const RANGE = {
  tolerance: [0.01, 10000],
  img: [1, 20000],
  scale: [0.001, 100000],
  theta: [-360, 360],
  xy: [-100000, 100000],
};

class PackageError extends Error {
  constructor(message, reason, issues) {
    super(message);
    this.reason = reason || 'package_invalid';
    this.issues = issues || [];
  }
}

// ---------- 照片内容识别（扩展名仅作参考，以魔数为准） ----------

function sniffPhoto(buf) {
  if (Buffer.isBuffer(buf) && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return '.jpg';
  }
  if (Buffer.isBuffer(buf) && buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return '.png';
  }
  if (Buffer.isBuffer(buf) && buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return '.webp';
  }
  return null;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------- 导出：同一版本快照 -> ZIP ----------

// rows 全部由调用方（server.js）在单个同步读事务内取出：
//   { project, sherds: [...id 升序], seams: [...id 升序], photoOf: fn(sherdRow) -> Buffer }
// 顺序约定：陶片按 id 升序得到 seq=1..n（保证导入重分配后组件根片选择一致）；
// 接缝按 id 升序即采纳顺序（Kruskal 次序），导出 seq 与数组位置必须一致。
function buildPackage(rows) {
  const { project } = rows;
  const sherds = rows.sherds.slice().sort((a, b) => a.id - b.id);
  const seams = rows.seams.slice().sort((a, b) => a.id - b.id);

  const oldIdToSeq = new Map(sherds.map((s, i) => [s.id, i + 1]));
  const entries = [];
  const manifestSherds = sherds.map((s, i) => {
    const data = rows.photoOf(s);
    if (!data || !Buffer.isBuffer(data) || data.length === 0) {
      throw new PackageError(`陶片 #${s.id} 的照片文件缺失或为空，无法导出完整方案包`, 'photo_unreadable');
    }
    const ext = sniffPhoto(data);
    if (!ext) throw new PackageError(`陶片 #${s.id} 的照片不是 JPG/PNG/WebP`, 'photo_unreadable');
    const seq = i + 1;
    const photoPath = `${PHOTOS_DIR}sherd-${String(seq).padStart(4, '0')}${ext}`;
    entries.push({ name: photoPath, data, method: 0 });
    return {
      seq,
      label: s.label,
      note: s.note || '',
      photo: photoPath,
      photo_sha256: sha256(data),
      photo_bytes: data.length,
      img_w: s.img_w,
      img_h: s.img_h,
      scale_px: s.scale_px == null ? null : s.scale_px,
      scale_mm: s.scale_mm == null ? null : s.scale_mm,
    };
  });

  const manifestSeams = seams.map((s, i) => {
    const fromSeq = oldIdToSeq.get(s.from_id);
    const toSeq = oldIdToSeq.get(s.to_id);
    if (!fromSeq || !toSeq) {
      throw new PackageError(`接缝 #${s.id} 引用了不存在的陶片，方案数据不完整`, 'data_integrity_error');
    }
    return {
      seq: i + 1,
      from_seq: fromSeq,
      to_seq: toSeq,
      theta_deg: s.theta_deg,
      tx: s.tx,
      ty: s.ty,
      join_note: s.join_note || '',
    };
  });

  const manifest = {
    format: PACKAGE_FORMAT,
    format_version: PACKAGE_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    source: {
      project_id: project.id,
      name: project.name,
      tolerance_mm: project.tolerance_mm,
      version: project.version,
    },
    project: {
      name: project.name,
      tolerance_mm: project.tolerance_mm,
    },
    sherds: manifestSherds,
    seams: manifestSeams,
  };

  // manifest 用 DEFLATE，放在第一条；照片原样 STORED。
  return {
    zip: writeZip([{ name: MANIFEST_NAME, data: JSON.stringify(manifest, null, 2), method: 8 }, ...entries]),
    manifest,
  };
}

// ---------- 校验小工具 ----------

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function inRange(v, [lo, hi]) {
  return isFiniteNum(v) && v >= lo && v <= hi;
}
function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}
function clampStr(v) {
  return String(v).slice(0, 120);
}

// 严格校验条目名：仅允许 manifest.json 与 photos/ 下的单段安全文件名。
// 拒绝：绝对路径、盘符、.. 穿越、反斜杠、目录、点开头、空段、非常见扩展名。
function safePhotoPath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  if (name.includes('\\')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  if (!name.startsWith(PHOTOS_DIR)) return false;
  const rest = name.slice(PHOTOS_DIR.length);
  if (rest.includes('/') || rest.includes('\0')) return false;
  if (!/^[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/.test(rest)) return false;
  if (rest.startsWith('.')) return false;
  return true;
}

// ---------- 导入：ZIP -> 校验后的规范化包 ----------
//
// 返回 { manifest, photos: Map(photoPath -> Buffer), violations }。
// 有格式/校验问题时抛 PackageError（reason=package_invalid，issues[] 逐条列出）；
// 几何复核（全部闭合环超容差）时抛 PackageError（reason=import_cycle_tolerance_exceeded）。
// 该函数纯内存计算，不写库、不落盘；调用方在它成功后才允许产生任何副作用。

function inspectPackage(buffer) {
  let entries;
  try {
    entries = readZip(buffer, { maxEntryUncompressed: MAX_PHOTO_BYTES });
  } catch (e) {
    if (e instanceof ZipError) {
      throw new PackageError(`方案包无法读取（${clampStr(e.message)}），整包拒绝`, 'package_unreadable',
        [{ path: '', message: clampStr(e.message) }]);
    }
    throw e;
  }

  const issues = [];
  const note = (path, message) => issues.push({ path, message });

  // 1) 条目层：重复条目、越界/非法路径、目录条目、多余条目。
  const seenNames = new Map();
  for (const e of entries) {
    if (seenNames.has(e.name)) {
      note(e.name, '包内存在重复文件');
    }
    seenNames.set(e.name, (seenNames.get(e.name) || 0) + 1);
  }
  if ((seenNames.get(MANIFEST_NAME) || 0) > 1) {
    note(MANIFEST_NAME, 'manifest.json 在包内重复出现');
  }

  for (const e of entries) {
    if (e.name === MANIFEST_NAME) {
      if (e.data.length > 2 * 1024 * 1024) note(MANIFEST_NAME, 'manifest.json 过大');
      continue;
    }
    if (!safePhotoPath(e.name)) {
      note(e.name, '非法或越界路径：仅允许 manifest.json 与 photos/ 下的单段安全文件名（jpg/jpeg/png/webp）');
    }
  }

  // 2) manifest.json 必须存在且是唯一 JSON 文档。
  const manifestEntries = entries.filter((e) => e.name === MANIFEST_NAME);
  let manifest = null;
  if (manifestEntries.length === 0) {
    note(MANIFEST_NAME, '缺少清单文件 manifest.json');
  } else {
    try {
      manifest = JSON.parse(manifestEntries[0].data.toString('utf8'));
    } catch (e) {
      note(MANIFEST_NAME, `清单不是合法 JSON（${clampStr(e.message)}）`);
    }
  }

  let parsed = null;
  if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
    parsed = parseManifest(manifest, issues);
  } else if (manifest !== null) {
    note(MANIFEST_NAME, '清单根必须是 JSON 对象');
  }

  if (issues.length) throwPackageInvalid(issues);

  // 3) 文件层：每张陶片照片唯一存在、摘要/字节数/魔数/扩展名一致，无多余文件。
  const dataByName = new Map(entries.map((e) => [e.name, e.data]));
  const claimedPhotos = new Set();
  for (const sh of parsed.sherds) {
    if (claimedPhotos.has(sh.photo)) {
      note(sh.photo, `多张陶片声明了同一张照片（陶片序号 ${sh.seq}）`);
    }
    claimedPhotos.add(sh.photo);
    const data = dataByName.get(sh.photo);
    if (data === undefined) {
      note(sh.photo, `陶片序号 ${sh.seq} 的照片在包中缺失`);
      continue;
    }
    if (!safePhotoPath(sh.photo)) continue; // 路径问题已在前面登记
    if (data.length === 0) {
      note(sh.photo, `陶片序号 ${sh.seq} 的照片为空文件`);
      continue;
    }
    if (data.length > MAX_PHOTO_BYTES) {
      note(sh.photo, `陶片序号 ${sh.seq} 的照片超过 ${MAX_PHOTO_BYTES} 字节上限`);
    }
    if (data.length !== sh.photo_bytes) {
      note(sh.photo, `陶片序号 ${sh.seq} 的照片字节数与清单不符`
        + `（实际 ${data.length}，清单 ${sh.photo_bytes}）`);
    }
    const digest = sha256(data);
    if (digest !== sh.photo_sha256) {
      note(sh.photo, `陶片序号 ${sh.seq} 的照片 SHA-256 校验失败（照片已损坏或被篡改）`);
    }
    const magicExt = sniffPhoto(data);
    if (!magicExt) {
      note(sh.photo, `陶片序号 ${sh.seq} 的照片内容不是 JPG/PNG/WebP（魔数不符）`);
    } else {
      const declared = sh.photo.toLowerCase().endsWith('.jpeg')
        ? '.jpg'
        : sh.photo.slice(sh.photo.lastIndexOf('.'));
      if (declared !== magicExt) {
        note(sh.photo, `陶片序号 ${sh.seq} 的照片扩展名（${declared}）与实际内容（${magicExt}）不符`);
      }
      sh.detected_ext = magicExt; // 导入落盘时以实际内容为准
    }
  }
  for (const name of dataByName.keys()) {
    if (name !== MANIFEST_NAME && !claimedPhotos.has(name) && safePhotoPath(name)) {
      note(name, '包中存在清单未引用的多余文件');
    }
  }

  if (issues.length) throwPackageInvalid(issues);

  // 4) 几何复核：按“导入后”的本地 id（这里用 seq 当合成 id）重算全部闭合环，
  //    任一残差超包内容差即整包拒绝（422），保证导入结果与源方案布局等价。
  const synthSherds = parsed.sherds.map((sh) => ({
    id: sh.seq,
    img_w: sh.img_w,
    img_h: sh.img_h,
    scale_px: sh.scale_px,
    scale_mm: sh.scale_mm,
  }));
  const synthSeams = parsed.seams.map((se, i) => ({
    id: i + 1, // 按采纳顺序合成连续 id（导入时也按此顺序插入，自增 id 同样连续）
    from_id: se.from_seq,
    to_id: se.to_seq,
    theta_deg: se.theta_deg,
    tx: se.tx,
    ty: se.ty,
  }));
  const detailed = layout.computeLayoutDetailed(synthSherds, synthSeams, parsed.tolerance);
  const violations = detailed.cycleDetails.filter((c) => !c.within_tolerance);
  if (violations.length) {
    throw new PackageError(
      `包内有 ${violations.length} 个闭合环残差超过 ${parsed.tolerance} mm 容差，整包拒绝`,
      'import_cycle_tolerance_exceeded',
      buildGeomViolations(violations, parsed));
  }

  const photos = new Map();
  for (const sh of parsed.sherds) photos.set(sh.photo, dataByName.get(sh.photo));

  return {
    manifest: {
      name: parsed.name,
      tolerance_mm: parsed.tolerance,
      source: parsed.source,
      sherds: parsed.sherds,
      seams: parsed.seams,
    },
    photos,
    layout: { groups: detailed.groups, unconnected: detailed.unconnected, residuals: detailed.residuals },
  };
}

function buildGeomViolations(violations, parsed) {
  const seqSeams = new Map(parsed.seams.map((s) => [s.seq, s]));
  return violations.map((v) => {
    // 合成接缝 id = 采纳顺序位置 = seam.seq
    const se = seqSeams.get(v.seam_id) || { from_seq: v.from_id, to_seq: v.to_id };
    return {
      path: `seams[${v.seam_id - 1}]`,
      seam_seq: v.seam_id,
      from_seq: se.from_seq,
      to_seq: se.to_seq,
      deviation_mm: v.distance_mm,
      rotation_deg: v.rotation_deg,
      tolerance_mm: parsed.tolerance,
      conflict_chain: {
        sherd_seqs: v.conflict_chain.sherd_path,
        seam_seqs: v.conflict_chain.seam_path,
        closing_seam_seq: v.seam_id,
      },
    };
  });
}

function throwPackageInvalid(issues) {
  const uniq = [];
  const dedup = new Set();
  for (const i of issues) {
    const k = `${i.path} ${i.message}`;
    if (!dedup.has(k)) { dedup.add(k); uniq.push(i); }
  }
  uniq.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  throw new PackageError(`方案包校验未通过（${uniq.length} 项问题），整包拒绝`, 'package_invalid', uniq);
}

// ---------- manifest 字段级校验（尽量逐条收集问题） ----------

function parseManifest(m, issues) {
  const noteRoot = (field, message) => issues.push({ path: field, message });

  if (m.format !== PACKAGE_FORMAT) {
    noteRoot('format', `format 必须为 "${PACKAGE_FORMAT}"`);
  }
  if (m.format_version !== PACKAGE_FORMAT_VERSION) {
    noteRoot('format_version', `format_version 必须为 ${PACKAGE_FORMAT_VERSION}`);
  }

  // source 段仅作信息记录；损坏/缺失不致命（允许手工或第三方生成包）。
  let source = null;
  if (m.source !== undefined) {
    if (typeof m.source === 'object' && m.source !== null && !Array.isArray(m.source)) {
      source = {
        project_id: isInt(m.source.project_id) ? m.source.project_id : null,
        name: typeof m.source.name === 'string' ? m.source.name.slice(0, MAX_NAME) : null,
        version: isInt(m.source.version) ? m.source.version : null,
      };
    } else {
      noteRoot('source', 'source 必须是对象（已忽略）');
    }
  }

  const proj = m.project;
  if (proj === undefined || proj === null || typeof proj !== 'object' || Array.isArray(proj)) {
    noteRoot('project', '缺少 project 对象');
  }
  let name = '未命名方案';
  let tolerance = null;
  if (proj && typeof proj === 'object' && !Array.isArray(proj)) {
    if (typeof proj.name !== 'string' || !proj.name.trim()) {
      noteRoot('project.name', 'project.name 必须是非空字符串');
    } else if (proj.name.length > MAX_NAME) {
      noteRoot('project.name', `方案名称过长（最多 ${MAX_NAME} 字符）`);
    } else {
      name = proj.name.trim();
    }
    if (!inRange(proj.tolerance_mm, RANGE.tolerance)) {
      noteRoot('project.tolerance_mm', `tolerance_mm 必须是 ${RANGE.tolerance[0]}~${RANGE.tolerance[1]} 之间的数字`);
    } else {
      tolerance = proj.tolerance_mm;
    }
  }

  const sherds = Array.isArray(m.sherds) ? parseSherds(m.sherds, issues) : (noteRoot('sherds', 'sherds 必须是数组'), []);
  const seams = Array.isArray(m.seams) ? parseSeams(m.seams, issues, sherds) : (noteRoot('seams', 'seams 必须是数组'), []);

  if (tolerance === null) return { name, tolerance: NaN, sherds, seams, source };
  return { name, tolerance, sherds, seams, source };
}

function parseSherds(arr, issues) {
  if (arr.length > MAX_SHERDS) {
    issues.push({ path: 'sherds', message: `陶片数量超过上限 ${MAX_SHERDS}` });
  }
  const out = [];
  const seqs = new Set();
  arr.forEach((sh, i) => {
    const base = `sherds[${i}]`;
    if (sh === null || typeof sh !== 'object' || Array.isArray(sh)) {
      issues.push({ path: base, message: '陶片条目必须是对象' });
      return;
    }
    let ok = true;
    if (!isInt(sh.seq) || sh.seq < 1) {
      issues.push({ path: `${base}.seq`, message: 'seq 必须是 ≥1 的整数' });
      ok = false;
    } else if (seqs.has(sh.seq)) {
      issues.push({ path: `${base}.seq`, message: `陶片 seq=${sh.seq} 重复` });
      ok = false;
    } else {
      seqs.add(sh.seq);
    }

    let label = '';
    if (sh.label === undefined || sh.label === null) {
      label = `陶片 ${sh.seq || i + 1}`;
    } else if (typeof sh.label !== 'string') {
      issues.push({ path: `${base}.label`, message: 'label 必须是字符串' });
      ok = false;
    } else if (sh.label.length > MAX_LABEL) {
      issues.push({ path: `${base}.label`, message: `label 过长（最多 ${MAX_LABEL} 字符）` });
      ok = false;
    } else {
      label = sh.label;
    }

    let noteText = '';
    if (sh.note !== undefined && sh.note !== null) {
      if (typeof sh.note !== 'string') {
        issues.push({ path: `${base}.note`, message: 'note 必须是字符串' });
      } else if (sh.note.length > MAX_NOTE) {
        issues.push({ path: `${base}.note`, message: `note 过长（最多 ${MAX_NOTE} 字符）` });
      } else {
        noteText = sh.note;
      }
    }

    if (typeof sh.photo !== 'string' || !safePhotoPath(sh.photo)) {
      issues.push({ path: `${base}.photo`,
        message: 'photo 必须是 photos/ 目录下的单段安全文件名（jpg/jpeg/png/webp）' });
      ok = false;
    }
    if (!isInt(sh.img_w) || !inRange(sh.img_w, RANGE.img)) {
      issues.push({ path: `${base}.img_w`, message: `img_w 必须是 ${RANGE.img[0]}~${RANGE.img[1]} 的整数` });
      ok = false;
    }
    if (!isInt(sh.img_h) || !inRange(sh.img_h, RANGE.img)) {
      issues.push({ path: `${base}.img_h`, message: `img_h 必须是 ${RANGE.img[0]}~${RANGE.img[1]} 的整数` });
      ok = false;
    }

    // 比例尺：两字段同时为 null（未标定）或同时为范围内正数。
    let scalePx = null, scaleMm = null;
    const pxNull = sh.scale_px === null || sh.scale_px === undefined;
    const mmNull = sh.scale_mm === null || sh.scale_mm === undefined;
    if (pxNull !== mmNull) {
      issues.push({ path: `${base}.scale_px`, message: 'scale_px 与 scale_mm 必须同时给出或同时为 null' });
      ok = false;
    } else if (!pxNull) {
      if (!inRange(sh.scale_px, RANGE.scale) || typeof sh.scale_px !== 'number') {
        issues.push({ path: `${base}.scale_px`, message: `scale_px 必须是 ${RANGE.scale[0]}~${RANGE.scale[1]} 的数字` });
        ok = false;
      } else {
        scalePx = sh.scale_px;
      }
      if (!inRange(sh.scale_mm, RANGE.scale) || typeof sh.scale_mm !== 'number') {
        issues.push({ path: `${base}.scale_mm`, message: `scale_mm 必须是 ${RANGE.scale[0]}~${RANGE.scale[1]} 的数字` });
        ok = false;
      } else {
        scaleMm = sh.scale_mm;
      }
    }

    if (typeof sh.photo_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sh.photo_sha256)) {
      issues.push({ path: `${base}.photo_sha256`, message: 'photo_sha256 必须是 64 位小写十六进制字符串' });
      ok = false;
    }
    if (!isInt(sh.photo_bytes) || sh.photo_bytes < 1 || sh.photo_bytes > MAX_PHOTO_BYTES) {
      issues.push({ path: `${base}.photo_bytes`, message: `photo_bytes 必须是 1~${MAX_PHOTO_BYTES} 的整数` });
      ok = false;
    }

    if (ok) {
      out.push({
        seq: sh.seq, label, note: noteText, photo: sh.photo,
        photo_sha256: sh.photo_sha256.toLowerCase(), photo_bytes: sh.photo_bytes,
        img_w: sh.img_w, img_h: sh.img_h, scale_px: scalePx, scale_mm: scaleMm,
      });
    }
  });

  // seq 必须从 1 起连续无缺（导入即按 seq 顺序重分配本地 id）。
  if (out.length && !issues.some((x) => x.path === 'sherds' || x.path.endsWith('.seq'))) {
    const sorted = out.map((x) => x.seq).slice().sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) {
        issues.push({ path: 'sherds', message: `陶片 seq 必须从 1 起连续无缺（在序号 ${i + 1} 处中断）` });
        break;
      }
    }
  }
  return out;
}

function parseSeams(arr, issues, sherds) {
  if (arr.length > MAX_SEAMS) {
    issues.push({ path: 'seams', message: `接缝数量超过上限 ${MAX_SEAMS}` });
  }
  const seqs = new Set();
  const seqSet = new Set(sherds.map((s) => s.seq));
  const scaledSet = new Set(sherds.filter((s) => s.scale_px != null).map((s) => s.seq));
  const out = [];

  arr.forEach((se, i) => {
    const base = `seams[${i}]`;
    if (se === null || typeof se !== 'object' || Array.isArray(se)) {
      issues.push({ path: base, message: '接缝条目必须是对象' });
      return;
    }
    let ok = true;
    // seq 必须等于数组位置+1：接缝顺序即采纳顺序，不允许用 seq 重排。
    if (!isInt(se.seq) || se.seq !== i + 1) {
      issues.push({ path: `${base}.seq`, message: `接缝 seq 必须按数组位置从 1 起连续（此处应为 ${i + 1}）` });
      ok = false;
    } else if (seqs.has(se.seq)) {
      issues.push({ path: `${base}.seq`, message: `接缝 seq=${se.seq} 重复` });
      ok = false;
    } else {
      seqs.add(se.seq);
    }

    if (!isInt(se.from_seq) || !isInt(se.to_seq)) {
      issues.push({ path: base, message: 'from_seq / to_seq 必须是整数' });
      ok = false;
    } else if (se.from_seq === se.to_seq) {
      issues.push({ path: base, message: '接缝必须连接两片不同的陶片（from_seq = to_seq）' });
      ok = false;
    } else {
      if (!seqSet.has(se.from_seq)) {
        issues.push({ path: `${base}.from_seq`, message: `from_seq=${se.from_seq} 未在陶片列表中定义` });
        ok = false;
      }
      if (!seqSet.has(se.to_seq)) {
        issues.push({ path: `${base}.to_seq`, message: `to_seq=${se.to_seq} 未在陶片列表中定义` });
        ok = false;
      }
      if (seqSet.has(se.from_seq) && !scaledSet.has(se.from_seq)) {
        issues.push({ path: `${base}.from_seq`, message: `陶片 seq=${se.from_seq} 未标记毫米比例尺，不能作为接缝端点` });
        ok = false;
      }
      if (seqSet.has(se.to_seq) && !scaledSet.has(se.to_seq)) {
        issues.push({ path: `${base}.to_seq`, message: `陶片 seq=${se.to_seq} 未标记毫米比例尺，不能作为接缝端点` });
        ok = false;
      }
    }

    if (!inRange(se.theta_deg, RANGE.theta) || typeof se.theta_deg !== 'number') {
      issues.push({ path: `${base}.theta_deg`, message: `theta_deg 必须是 ${RANGE.theta[0]}~${RANGE.theta[1]} 的数字` });
      ok = false;
    }
    if (!inRange(se.tx, RANGE.xy) || typeof se.tx !== 'number') {
      issues.push({ path: `${base}.tx`, message: `tx 必须是 ${RANGE.xy[0]}~${RANGE.xy[1]} 的数字` });
      ok = false;
    }
    if (!inRange(se.ty, RANGE.xy) || typeof se.ty !== 'number') {
      issues.push({ path: `${base}.ty`, message: `ty 必须是 ${RANGE.xy[0]}~${RANGE.xy[1]} 的数字` });
      ok = false;
    }
    let joinNote = '';
    if (se.join_note !== undefined && se.join_note !== null) {
      if (typeof se.join_note !== 'string') {
        issues.push({ path: `${base}.join_note`, message: 'join_note 必须是字符串' });
      } else if (se.join_note.length > MAX_JOIN_NOTE) {
        issues.push({ path: `${base}.join_note`, message: `join_note 过长（最多 ${MAX_JOIN_NOTE} 字符）` });
      } else {
        joinNote = se.join_note;
      }
    }

    if (ok) {
      out.push({
        seq: se.seq, from_seq: se.from_seq, to_seq: se.to_seq,
        theta_deg: se.theta_deg, tx: se.tx, ty: se.ty, join_note: joinNote,
      });
    }
  });
  return out;
}

module.exports = {
  buildPackage,
  inspectPackage,
  sniffPhoto,
  PackageError,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  MANIFEST_NAME,
  PHOTOS_DIR,
  MAX_PACKAGE_MB_DEFAULT: 100,
};
