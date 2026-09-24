/**
 * BodyParts3D 肌群映射表。
 *
 * 把 Rein 的 MuscleKey 映射到 BodyParts3D 的网格（OBJ）文件 id：
 * 每个解剖结构一对网格，`FJ####` 为右侧、`FJ####M` 为左侧（数据自带的镜像件）。
 *
 * 数据来源：BodyParts3D 4.0（IS-A 树，多边形削减率 99%）
 *   https://dbarchive.biosciencedbc.jp/jp/bodyparts3d/download.html
 *   许可：CC BY 4.0 —— "BodyParts3D, © The Database Center for Life Science
 *   licensed under CC Attribution 4.0 International"
 *
 * 分层（layer）用于「浅层 / 深层」切换：
 *   1 = 浅层，直接在体表可见；
 *   2 = 深层，需隐去浅层才看得见。
 * 未列入 MUSCLE_MESHES 的网格只作解剖填充（class="a"），不参与高亮。
 */

/** 肌群键 → BodyParts3D 网格 id（右侧；左侧由 fetch 自动补 `M` 变体） */
export const MUSCLE_MESHES = {
  // 胸锁乳突肌在归档里是显式左右件（没有 M 镜像件）
  scm: ['FJ1573', 'FJ1595'],
  'delt-ant': ['FJ1468'],
  'delt-lat': ['FJ1467'],
  'delt-post': ['FJ1513'],
  'traps-up': ['FJ1521'],
  'traps-mid': ['FJ1554'],
  'traps-low': ['FJ1520'],
  'lower-back': ['FJ1527', 'FJ1528', 'FJ1535', 'FJ1544'],
  'chest-up': ['FJ1447'],
  'chest-low': ['FJ1464', 'FJ1446'],
  obliques: ['FJ1452'],
  biceps: ['FJ1478', 'FJ1512'],
  triceps: ['FJ1477', 'FJ1479', 'FJ1480'],
  forearm: ['FJ1486', 'FJ1487', 'FJ1489', 'FJ1490', 'FJ1492', 'FJ1496', 'FJ1502', 'FJ1472'],
  'glute-max': ['FJ1418'],
  'glute-med': ['FJ1419'],
  'quads-lat': ['FJ1442'],
  'quads-rec': ['FJ1433'],
  'quads-med': ['FJ1443'],
  adductors: ['FJ1401', 'FJ1402', 'FJ1403', 'FJ1404', 'FJ1421', 'FJ1427'],
  hamstrings: ['FJ1395', 'FJ1435', 'FJ1436', 'FJ1444'],
  calves: ['FJ1394', 'FJ1397'],
  soleus: ['FJ1437'],
  tibialis: ['FJ1439'],
  // ---- 深层结构与补充肌束：与 src/config/muscles.ts 的深层键一一对应 ----
  'glute-min': ['FJ1420'],
  'rotator-cuff': ['FJ1500', 'FJ1506', 'FJ1504', 'FJ1508'],
  'teres-major': ['FJ1507'],
  'serratus-ant': ['FJ1459'],
  rhomboids: ['FJ1536', 'FJ1537'],
  'levator-scapulae': ['FJ1532'],
  'vastus-intermedius': ['FJ1441'],
  iliopsoas: ['FJ1422', 'FJ1431'],
  plantaris: ['FJ1429'],
  popliteus: ['FJ1430'],
  'tibialis-post': ['FJ1440'],
  fibularis: ['FJ1409', 'FJ1410', 'FJ1411'],
  'quadratus-femoris': ['FJ1445'],
}

/** 深层键：切换「深层」时才显示；激活时会叠加绘制在浅层之上 */
export const DEEP_KEYS = new Set([
  'lower-back',
  'glute-med',
  'soleus',
  'glute-min',
  'rotator-cuff',
  'teres-major',
  'serratus-ant',
  'rhomboids',
  'levator-scapulae',
  'vastus-intermedius',
  'iliopsoas',
  'plantaris',
  'popliteus',
  'tibialis-post',
  'fibularis',
  'quadratus-femoris',
])

/** 体表轮廓与参考结构 */
export const BASE_MESHES = {
  skin: ['FJ2810'],
  'linea-alba': ['FJ1448'],
}

/** 全部需要下载的右侧网格 id（自动补 M 变体） */
export function allMeshIds() {
  const ids = new Set()
  for (const list of [MUSCLE_MESHES, BASE_MESHES]) {
    for (const arr of Object.values(list)) {
      for (const id of arr) {
        ids.add(id)
        ids.add(id + 'M')
      }
    }
  }
  return [...ids].sort()
}

/**
 * BodyParts3D 未收录、需要按相邻真实结构推导的两个肌群：
 *   lats（背阔肌）、abs（腹直肌）。
 * 二者在 IS-A / PART-OF 两棵树上都不存在（已核对 4.0 全量清单），
 * 因此由 build-anatomy.mjs 依据相邻网格边界推导，见该脚本 `deriveMissing`。
 */
export const DERIVED_KEYS = ['lats', 'abs']
