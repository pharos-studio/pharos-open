(function () {
  'use strict';
  var canvas = document.getElementById('heroCanvas');
  if (!canvas) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var fine   = window.matchMedia('(hover:hover) and (pointer:fine)');

  function fallback(err) {
    if (err && err.message) console.warn('[hero] 三维不可用，保留静态图：', err.message);
    // 不加 hero-3d -> SVG 兜底可见
  }

  // 相对路径（介绍页站点根 = 仓库根）；动态 import 让 404 也能进降级链
  import('../public/vendor/three.module.min.js')
    .then(function (THREE) { try { init(THREE); } catch (e) { fallback(e); } })
    .catch(fallback);

  function init(THREE) {
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    var scene = new THREE.Scene();
    var FOG_COLOR = 0x0A1020;                       // 必须等于页面底色
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0072);

    var camera = new THREE.PerspectiveCamera(52, 1, 0.5, 1400);
    camera.rotation.order = 'YXZ';
    // 构图基准（对齐静态 SVG 兜底图，实测值）：灯塔塔底落在横向 ~38%（左三分线）、塔高约占画面 45%、
    // 塔底（≈海平线）落在纵向 ~72%，灯室在 ~33%。相机与灯室同 x（-26）正对，再给一个向右偏角
    // 把灯塔推到左侧三分线 —— 偏角由 CAM_HALF_FOV_H 与目标屏占比算出，改这几行即可整体重构图。
    var CAM_X = -26, CAM_Y = 3.5, CAM_Z = 18;
    var CAM_HALF_FOV_H = Math.atan(Math.tan(26 * Math.PI / 180) * (520 / 440));
    var CAM_TARGET_X = 0.38;                         // 灯塔目标横向屏占比
    var CAM_YAW_OFFSET = 0;                          // 由下面算出（retune 会重算）
    // ★ LOOK_AT.y 是「镜头瞄准的高度」，直接决定俯仰角与整体构图：
    //   瞄准点越高 -> 相机越抬头 -> 灯塔越往下沉、天空越多。
    //   实测瞄准 ~14（塔身中下部）时，塔底落在 68%、锥顶 23%，与静态 SVG 兜底图
    //   的「塔底 72% / 塔高 44%」最接近。改这一个数就能整体上下平移画面。
    var LOOK_AT = new THREE.Vector3(-26, 9.0, 54);
    // 水平基准：朝 +Z 再偏转，把灯塔推到 CAM_TARGET_X。
    // ★ 三处曾经的坑（2026-09-21 实测定位，改这里务必看注释）：
    //   ① 偏移量符号：CAM_TARGET_X < 0.5 时 atan(...) 本身是**负**的，
    //      若再写成 `− offset` 就变成加法、相机反向转，灯塔被推到 62% 而不是 38%。
    //      所以这里取相反数，让它变成「正的偏移量」，再用减法施加。
    //   ② three.js 的 rotation.order = 'YXZ'、rotation.y 增大是**向左**转。
    //      要把目标推到画面左侧，相机必须向右转 → rotation.y 要减。
    //   ③ 屏幕占比与角度是 tan 关系、不是线性。用 atan 反解精确角度，
    //      代替 (0.5-targetX)*2*hfov 的线性近似（30° 半 FOV 下差约 0.7°）。
    var CAM_YAW_OFFSET =
      -Math.atan(2 * Math.tan(CAM_HALF_FOV_H) * (CAM_TARGET_X - 0.5));
    var CAM_YAW_BASE = Math.PI + Math.atan2(CAM_X - LOOK_AT.x, LOOK_AT.z - CAM_Z)
                             - CAM_YAW_OFFSET;
    // 俯仰基准：相机 -> LOOK_AT 的仰角。
    // ★ 符号（2026-09-21 实测纠正）：rotation.order = 'YXZ' 且 yaw 基准含 Math.PI 时，
    //   局部 X 轴方向被翻转，所以「抬头看向高处」对应 rotation.x 为**正**值。
    //   之前写成 -atan2(...) 让画面整体低头：海平线被顶到 33%、灯塔整个跑出上边界。
    //   实测翻转后：塔底 67.7% / 锥顶 23.3% / 海平线 78.5%，与静态兜底图吻合。
    var CAM_PITCH_BASE = Math.atan2(LOOK_AT.y - CAM_Y,
                                    Math.hypot(LOOK_AT.x - CAM_X, LOOK_AT.z - CAM_Z));
    camera.position.set(CAM_X, CAM_Y, CAM_Z);

    /* ── 天空：反面球 + 顶点渐变 ── */
    var skyGeo = new THREE.SphereGeometry(900, 24, 16);
    var skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x0A1020) }, bot: { value: new THREE.Color(0x101A30) } },
      vertexShader: 'varying float vy; void main(){ vy = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vy; uniform vec3 top; uniform vec3 bot; void main(){ float k = clamp(vy*2.2+0.35,0.0,1.0); gl_FragColor = vec4(mix(bot,top,k),1.0); }'
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    /* ── 星空 ── */
    var starN = 900, sPos = new Float32Array(starN * 3);
    for (var i = 0; i < starN; i++) {
      var az = (Math.random() - 0.5) * 2.2, el = 0.06 + Math.random() * 1.04, r = 1000;
      sPos[i * 3]     = Math.sin(az) * Math.cos(el) * r;
      sPos[i * 3 + 1] = Math.sin(el) * r;
      sPos[i * 3 + 2] = Math.cos(az) * Math.cos(el) * r;
    }
    var starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xE8ECF6, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.72, fog: false })));

    /* ── 唯一光源：灯室 ── */
    /* ── 灯塔竖向尺寸：集中在这里定义，供光源 / 海面 / 几何体共用 ──
       （原来 LAMP 的 y 是散落写死的 17.2，塔身一改高度就对不上，
         导致光锥枢轴悬在灯室上方或下方。收敛成一条竖向标尺。）*/
    var TOWER_Z      = 54;
    var ISLE_TOP     = 5.4;                      // 灯塔处的山丘脊高（与 ridge 的 -26 点一致）
    var TOWER_BASE_Y = 6.6;                      // 塔底（坐在礁盘里）
    var TOWER_H      = 13.5;                     // 塔身净高
    var TOWER_TOP_Y  = TOWER_BASE_Y + TOWER_H;   // 观景台高度 = 21.1
    var LAMP_Y       = TOWER_TOP_Y + 0.95;       // 灯室中心 = 22.05
    var LAMP = new THREE.Vector3(-26, LAMP_Y, TOWER_Z);
    var lampLight = new THREE.PointLight(0xF7E7C0, 3.4, 260, 1.6);
    lampLight.position.copy(LAMP);
    scene.add(lampLight);
    scene.add(new THREE.AmbientLight(0x2A3450, 0.55));

    /* ── 海面：程序化波浪 + 兰伯特/菲涅耳/距离雾 ──
       2026-09-21 重做观感：① 加「光带」——光束 yaw 方向一致的海面楔形区被照亮，
       随扫掠移动（这是「海」读得出来的关键，旧版海面就是一片无特征的浅灰渐变）；
       ② 顶点法线叠加高频抖动 -> 灯光/光带的高光被打碎成闪粼，不再是塑料平面；
       ③ 菲涅耳天空反光从 0.55 收到 0.22 —— 旧版把海面提亮成雾感灰板。 */
    var seaMat = new THREE.ShaderMaterial({
      fog: false, transparent: false,
      uniforms: {
        t: { value: 0 }, lampPos: { value: LAMP.clone() },
        fogColor: { value: new THREE.Color(FOG_COLOR) }, fogDen: { value: 0.0072 },
        camPos: { value: camera.position },
        uBeamDir: { value: new THREE.Vector2(0, 1) },   // 光束水平方向（每帧随 beamYaw 更新）
        uHalfCos: { value: 0.9 }                         // = cos(BEAM.half)，BEAM 定义后回填
      },
      vertexShader: [
        'uniform float t; varying vec3 vW; varying vec3 vN;',
        'float wy(vec2 p,float t){ return 0.30*sin(0.055*p.x+0.70*t)+0.18*sin(0.090*p.y+0.45*t)+0.10*sin(0.160*(p.x+0.55*p.y)+1.05*t)+0.05*sin(0.240*(p.x-0.70*p.y)+1.50*t); }',
        'void main(){',
        '  vec3 p = position; float h = wy(p.xy, t);',
        '  float e = 0.6;',
        '  float hx = wy(p.xy+vec2(e,0.0), t), hz = wy(p.xy+vec2(0.0,e), t);',
        '  vN = normalize(vec3(-(hx-h)/e, 1.0, -(hz-h)/e));',
        '  vN = normalize(vN + vec3(0.16*sin(p.x*1.9+t*2.1), 0.0, 0.16*sin(p.y*1.4-t*1.6)));',
        '  p.z += h;',
        '  vec4 wp = modelMatrix * vec4(p,1.0); vW = wp.xyz;',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 lampPos; uniform vec3 fogColor; uniform float fogDen; uniform vec3 camPos;',
        'uniform vec2 uBeamDir; uniform float uHalfCos;',
        'varying vec3 vW; varying vec3 vN;',
        'void main(){',
        '  vec3 N = normalize(vN); vec3 V = normalize(camPos - vW);',
        '  vec3 L = normalize(lampPos - vW);',
        '  float lam = max(dot(N,L), 0.0);',
        '  float atten = 1.0 / (1.0 + 0.006*dot(lampPos-vW,lampPos-vW));',
        '  vec3 base = vec3(0.039,0.055,0.11);',
        '  vec3 warm = vec3(0.97,0.86,0.66);',
        '  float fres = pow(1.0 - max(dot(N,V),0.0), 3.0);',
        '  vec3 col = base + warm * lam * atten * 1.5;',
        '  col += vec3(0.22,0.27,0.40) * fres * 0.30;',
        '  vec3 Hv = normalize(L + V);',
        '  col += warm * pow(max(dot(N,Hv),0.0), 90.0) * atten * 1.6;',
        // 光带：与光束 yaw 同向的海面楔形被照亮，随扫掠移动；波面越朝向光束越亮（闪粼感）
        '  vec2 bd = vW.xz - lampPos.xz;',
        '  float bdist = length(bd);',
        '  float bc = bdist > 0.001 ? dot(bd / bdist, uBeamDir) : 0.0;',
        '  float band = smoothstep(uHalfCos - 0.10, uHalfCos + 0.03, bc);',
        '  float baxial = exp(-bdist / 120.0);',
        '  float bface = 0.45 + 0.55 * pow(max(dot(N, normalize(vec3(uBeamDir.x,0.0,uBeamDir.y))), 0.0), 5.0);',
        '  col += warm * band * baxial * bface * 0.85;',
        '  float d = length(vW - camPos);',
        '  float f = 1.0 - exp(-fogDen*fogDen*d*d);',
        '  col = mix(col, fogColor, clamp(f,0.0,1.0));',
        '  gl_FragColor = vec4(col,1.0);',
        '}'
      ].join('\n')
    });
    var sea = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400, 96, 96), seaMat);
    sea.rotation.x = -Math.PI / 2;                   // 水平面（局部 +Z 转到世界 +Y）
    scene.add(sea);

    /* ── 岬角：封闭实体岛（低矮岩石脊，不再是悬空薄片）──
       原来的实现只把「2 个基点 × 5 个脊点」拼成一片三角扇，没有闭合底面，
       侧视时会变成一张悬空黑纸。这里改为「底面环 + 脊线」的封闭实体：
       同一条脊线同时生成前坡与后坡，再补一条底面，法线才完整、才有体积感。
       ★ 取景宽度（2026-09-21 实测）：相机在 z=18 看 z=45~50 的岛，
         半 FOV 30° → 该深度可见横向范围约 ±28（即 x 从 -54 到 +2）。
         所以脊线必须落在 x∈[-52, -1] 内，脊顶 6~7.5 让它在海平线（78.6%）上方
         露出一条深色陆地剪影；超出这个范围的部分只会在画外白白增加顶点。*/
    var rockMat = new THREE.MeshLambertMaterial({ color: 0x0B1120 });
    var headGeo = new THREE.BufferGeometry();
    var hv = [];
    // 脊线：x 从左到右，y 为脊高，z 为脊的纵深中心（-26 处正对灯塔）
    // ★ 尺度原则（2026-09-21 实测）：岛必须**低而暗**。
    //   灯在 y=25.25 —— 脊顶一旦超过 ~6，它离灯就太近（<20m），
    //   shader 的 1/(1+0.006d²) 会让它过曝成一条白带。
    //   脊顶压在 5 左右、z 放在 45（距灯约 21m），atten≈0.27，是干净的深色剪影。
    //   至于「露出海平线」靠的是机位俯仰，不是抬岛：
    //   相机 y=3.5、瞄准 y=8.5 时海平线在 63.5%，岛顶 60.1% 正好压在海平线上方一点。
    var ridge = [
      [-52, 0.2, 41], [-46, 2.6, 42], [-38, 4.2, 43.5], [-32, 5.0, 44.5],
      [-26, 5.4, 45], [-20, 4.8, 44.5], [-14, 3.8, 43.5], [-7, 2.2, 42], [-1, 0.2, 41]
    ];
    function ridgePt(i, side) {
      var p = ridge[i], t = i / (ridge.length - 1);
      var fat = 6.5 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));  // 中间厚两头薄
      return [p[0], p[1], p[2] + side * (fat * 0.5)];
    }
    for (var k = 0; k < ridge.length - 1; k++) {
      var a0 = ridgePt(k, -1), a1 = ridgePt(k + 1, -1);   // 前坡（z 小）
      var b0 = ridgePt(k, +1), b1 = ridgePt(k + 1, +1);   // 后坡（z 大）
      // 前坡面
      hv.push(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], b1[0], b1[1], b1[2]);
      // 后坡面（同三角形反向绕序 -> 法线朝外）
      hv.push(a0[0], a0[1], a0[2], b1[0], b1[1], b1[2], b0[0], b0[1], b0[2]);
    }
    // 底面：把脊线两端的基脚封起来（形成闭合体积）
    for (var k2 = 0; k2 < ridge.length - 1; k2++) {
      var f0 = ridgePt(k2, -1), f1 = ridgePt(k2 + 1, -1);
      var g0 = ridgePt(k2, +1), g1 = ridgePt(k2 + 1, +1);
      var yb = -4;
      hv.push(f0[0], yb, f0[2], g0[0], yb, g0[2], g1[0], yb, g1[2]);
      hv.push(f0[0], yb, f0[2], g1[0], yb, g1[2], f1[0], yb, f1[2]);
    }
    headGeo.setAttribute('position', new THREE.Float32BufferAttribute(hv, 3));
    headGeo.computeVertexNormals();
    scene.add(new THREE.Mesh(headGeo, rockMat));

    /* ── 岩石基座：矮而宽的礁盘，把塔身「种」进岛里 ── */
    var plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 3.2, 3.4, 16, 1, false), rockMat);
    plinth.position.set(-26, ISLE_TOP - 0.1, TOWER_Z);
    scene.add(plinth);

    var goldLine = new THREE.MeshBasicMaterial({ color: 0x5A4A22 });
    var towerMat = new THREE.MeshLambertMaterial({ color: 0x16203A });
    // 塔身：0.85 顶 / 1.35 底、11.5 高，塔底 y≈9.2（坐在礁盘里）
    var tower = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.35, TOWER_H, 18, 1, false), towerMat);
    tower.position.set(-26, TOWER_BASE_Y + TOWER_H / 2, TOWER_Z);
    scene.add(tower);
    // 观景台：灯室脚下的外挑平台 + 栏杆，让「塔顶 -> 灯室」有个交代
    var gallery = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 0.28, 16), towerMat);
    gallery.position.set(-26, TOWER_TOP_Y, TOWER_Z);
    scene.add(gallery);
    var railing = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.55, 16, 1, true), goldLine);
    railing.position.set(-26, TOWER_TOP_Y + 0.42, TOWER_Z);
    scene.add(railing);
    // 灯室：坐在观景台上，仍是唯一光源
    var lampRoom = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 0.98, 1.4, 14),
      new THREE.MeshBasicMaterial({ color: 0xE8C57A }));
    lampRoom.position.set(-26, LAMP_Y, TOWER_Z);
    scene.add(lampRoom);
    // 锥顶：底半径 1.12，只略比灯室宽，避免把灯室整个盖住
    var cap = new THREE.Mesh(new THREE.ConeGeometry(1.12, 1.7, 14), new THREE.MeshLambertMaterial({ color: 0x16203A }));
    cap.position.set(-26, LAMP_Y + 1.55, TOWER_Z);
    scene.add(cap);
    // 金色环箍：沿塔身等距，半径跟着塔的收分走
    for (var ry = TOWER_BASE_Y + 1.2; ry <= TOWER_TOP_Y - 1.0; ry += 2.4) {
      var tRatio = (ry - TOWER_BASE_Y) / TOWER_H;           // 0=塔底 1=塔顶
      var rAt = 1.35 + (0.85 - 1.35) * Math.min(1, Math.max(0, tRatio));
      var ring = new THREE.Mesh(new THREE.TorusGeometry(rAt + 0.05, 0.04, 4, 18), goldLine);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(-26, ry, TOWER_Z);
      scene.add(ring);
    }
    /* 灯晕：加色混合的径向 sprite */
    var glowCv = document.createElement('canvas');
    glowCv.width = glowCv.height = 128;
    (function () {
      var g = glowCv.getContext('2d');
      var rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      rg.addColorStop(0, 'rgba(247,231,192,0.95)');
      rg.addColorStop(0.35, 'rgba(232,197,122,0.35)');
      rg.addColorStop(1, 'rgba(232,197,122,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
    })();
    var glowTex = new THREE.CanvasTexture(glowCv);
    var glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.position.copy(LAMP);
    glow.scale.set(20, 20, 1);   // 26 -> 20：灯晕太大时会把近段光束整个洗掉（2026-09-21 校准）
    scene.add(glow);

    /* ── 礁石（隐在雾里 -> 光锥扫过显形；零文字）──
       原实现是 4 面金字塔（tip 在正上方），从这个机位看就是几个锐利的黑色纸三角。
       改成「圆台 + 尖顶」的两段式：先用一圈内收的台肩把轮廓撑圆，再收成小尖，
       并给每块礁石一个固定但互不相同的旋转/压扁，避免三块长得一模一样。*/
    var REEFS = [
      { x: -38, y: -1.4, z: 44, s: 3.0, rot: 0.7, sq: 0.72 },
      { x:  24, y: -1.8, z: 76, s: 3.8, rot: 2.1, sq: 0.85 },
      { x:  62, y: -2.1, z: 120, s: 2.4, rot: 3.9, sq: 0.66 }
    ];
    REEFS.forEach(function (r) {
      var rr = r.s, rv = [];
      var N = 7;                                   // 7 边比 4 面更接近岩石轮廓
      var footR = rr, shoulderR = rr * 0.52, shoulderY = rr * 0.55, tipY = rr * 0.78;
      function pt(i, rad, y) {
        var a = (i / N) * Math.PI * 2 + r.rot;
        // sq 把圆压成椭圆 -> 礁石有长边短边，不像柱子
        return [Math.cos(a) * rad, y, Math.sin(a) * rad * r.sq];
      }
      for (var q = 0; q < N; q++) {
        var q2 = (q + 1) % N;
        var f0 = pt(q, footR, 0), f1 = pt(q2, footR, 0);
        var s0 = pt(q, shoulderR, shoulderY), s1 = pt(q2, shoulderR, shoulderY);
        // 下段：基脚 -> 台肩
        rv.push(f0[0], f0[1], f0[2], f1[0], f1[1], f1[2], s1[0], s1[1], s1[2]);
        rv.push(f0[0], f0[1], f0[2], s1[0], s1[1], s1[2], s0[0], s0[1], s0[2]);
        // 上段：台肩 -> 尖顶
        rv.push(s0[0], s0[1], s0[2], s1[0], s1[1], s1[2], 0, tipY, 0);
      }
      var rg2 = new THREE.BufferGeometry();
      rg2.setAttribute('position', new THREE.Float32BufferAttribute(rv, 3));
      rg2.computeVertexNormals();
      var m = new THREE.Mesh(rg2, new THREE.MeshLambertMaterial({ color: 0x0D1424 }));
      m.position.set(r.x, r.y, r.z);
      scene.add(m);
    });

    /* ── 光锥：常态慢扫（扫—停—回，8s 一轮）──
       原来用 MeshBasicMaterial + 恒定 opacity，锥面是一个「等亮度的硬壳」，
       近处看就是一个边缘锐利的漏斗。改成自定义 shader：
       · 沿轴向做「灯口最亮 -> 远端衰减」；
       · 沿径向（靠近锥面边缘）额外衰减，让侧影边界软掉；
       · 靠近灯口再叠一点热斑，模拟灯丝附近的强光。
       这样它才像一束光，而不是一块黄色塑料膜。*/
    /* ★ 光锥节奏（2026-09-21 用户在 A/B/C 对比页选型 = B 慢速常态）：
       11s 完整往复（左→右→左），扫程 4.1s ×2、两端各停 1.4s —— 用秒数表述，
       与对比页 beam-options 的 yawLoop 逐字同参。cycle=11 也与静态 SVG 兜底
       .beam 的 CSS「sweep 11s」节奏一致（两套首屏扫得一样慢）。
       旧值是 cycle 8.0 + 分数相位 0.34/0.46/0.80（扫得太急、停顿不对称）。 */
    /* ★ 扫掠中心（2026-09-21 几何修正）：相机在灯室正南（−Z 侧），光束方向 = (cos by, −sin by)。
       旧范围 ±34°（绕正西 +X）→ 一半相位光束几乎端面朝镜头（轴向视角下锥体天然不可见，
       表现为「光束忽隐忽现」）。改为绕「远离镜头的 −90°（正北 +Z）」±34° ——
       光束在远处海面上自右向左再扫回来，海面光带扫过整个可见海域，任何相位都有可读侧面。 */
    var BEAM = { cycle: 11.0, move: 4.1, hold: 1.4, yaw0: -124 * Math.PI / 180, yaw1: -56 * Math.PI / 180, half: 9.5 * Math.PI / 180, range: 260 };
    var beamR = Math.tan(BEAM.half) * BEAM.range;
    seaMat.uniforms.uHalfCos.value = Math.cos(BEAM.half);   // 光带阈值回填（海面 shader 在 BEAM 之前创建）
    var beamMat = new THREE.ShaderMaterial({
      /* ★ FrontSide：旧 DoubleSide 下背面墙以 0.06 权重参与加色，贡献值恰好贴着
         discard 阈值 -> 一半片元被丢一半保留，形成「百叶窗」斑带（2026-09-21 实测）。
         只渲染外壁后条纹消失；内壁本来就被 vFacing≈0 压灭，视觉无损失。 */
      transparent: true, side: THREE.FrontSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      uniforms: {
        beamColor: { value: new THREE.Color(0xE8C57A) },
        uOpacity:  { value: 0.34 },
        uRange:    { value: BEAM.range }
      },
      vertexShader: [
        'varying float vAxial;',   // 0 = 灯口，1 = 远端
        'varying float vFacing;',  // 1 = 正对相机的锥面，0 = 背面
        'varying float vDot;',     // 锥面法线 · 指向相机方向（片元里做轮廓软边）
        'varying float vWy;',      // 片元世界高度（入水淡出用）
        'uniform float uRange;',
        'void main(){',
        // ConeGeometry(radius, height) 局部 y ∈ [-h/2, +h/2]，锥尖在 +h/2
        '  float h = uRange;',
        '  vAxial = clamp((h * 0.5 - position.y) / h, 0.0, 1.0);',
        // ★ 旧版的 vEdge（1 - r/rmax 公式）是错的：锥面顶点全在锥面上，r/rmax 恒为 1，
        //   vEdge 在所有环形顶点上恒为 0 -> 整个锥体 alpha≈0，光束从未被画出来
        //   （只剩锥尖一小扇融在灯晕里）。软边改由片元里的 rim 衰减实现。
        '  vec3 nrm = normalize(vec3(position.x, 0.0, position.z));',
        '  vec3 vdir = normalize(cameraPosition - position);',
        '  vDot = dot(nrm, vdir);',
        // 背面几乎掐掉：DoubleSide + 加色下，前壁与后壁叠加会产生锯齿摩尔纹
        // （2026-09-21 截图实测），背面权重压到 0.06 后画面干净
        '  vFacing = smoothstep(0.0, 0.7, vDot);',
        '  vec4 wp = modelMatrix * vec4(position, 1.0);',
        '  vWy = wp.y;',
        '  gl_Position = projectionMatrix * viewMatrix * wp;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 beamColor; uniform float uOpacity;',
        'varying float vAxial; varying float vFacing; varying float vDot; varying float vWy;',
        'void main(){',
        '  float axial = pow(1.0 - vAxial, 1.0);',            // 线性衰减（指数 >1 时远端几乎不可见）
        // 轮廓线（视线掠射锥面）处 edge -> 0.25，正对锥面 -> 1：侧影边界自然软掉
        '  float edge  = 1.0 - 0.75 * pow(1.0 - abs(vDot), 1.5);',
        '  float hot   = pow(1.0 - vAxial, 9.0) * 0.55;',    // 灯口热斑（很紧）
        // 背面不出力（FrontSide 下本就不渲染；权重留作保险）
        '  float face  = 0.94 * vFacing;',
        '  float a = uOpacity * (axial * edge * face + hot);',
        // ★ 入水淡出：锥体下缘约 108 米外没入海面，与波浪海面相交会切出扇贝状亮线
        //   （2026-09-21 截图实测）。在水面上方 2~12 米把锥面渐隐，水上的延伸交给海面光带。
        '  a *= smoothstep(2.0, 12.0, vWy);',
        // 抖动：打散低分辨率/无 MSAA 环境下锥面网格与像素网格的相干摩尔纹（对人眼不可见）
        '  a *= 0.92 + 0.08 * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);',
        '  if (a < 0.004) discard;',
        '  gl_FragColor = vec4(beamColor * (0.9 + hot * 0.6), a);',
        '}'
      ].join('\n')
    });
    /* ★ 光束 rig（2026-09-21 重做）：真实灯塔的光束近乎水平、绕竖直轴横扫。
       旧 rig 把锥体竖直朝下挂（position.y = -range/2），再让 pivot 绕竖直 Y 轴转 ——
       锥轴与转轴重合，绕自己的轴自旋 = 视觉上纹丝不动，「扫光」从未真正发生过
       （用户反馈「光锥贴在灯塔最底部」的根因：那是一团静止砸向塔底海面的光晕）。
       新 rig：holder 先用 rotation.z = +90° 把锥轴从竖直转为水平
       （Rz(+90°) 把局部 -Y（锥底方向）映到 +X），锥尖正好落在枢轴上；
       再减 2.2° 让光束微微低头、真正照到远海；pivot.rotation.y 才是真正的横扫。 */
    var beamMesh = new THREE.Mesh(
      // 24x1（非 48x24）：锥面是直纹面，多段几何完全等价、只会带来掠射视角下的摩尔纹
      new THREE.ConeGeometry(beamR, BEAM.range, 24, 1, true),
      beamMat
    );
    var beamHolder = new THREE.Object3D();
    beamHolder.rotation.z = Math.PI / 2 - 2.2 * Math.PI / 180;
    // ★ 偏移必须沿局部 -Y 放：子节点的 position 会被 holder 的旋转一并转掉 ——
    //   写 (range/2, 0, 0) 的下场是整个锥体被 Rz(87.8°) 翘到灯室上方 85 米的画外天空
    //   （2026-09-21 实测踩坑：控制台零报错、海面光带正常，唯独光束本体消失）。
    //   沿 -Y 放，Rz(+90°−低头) 恰好把它「放倒」成 +X 方向的近水平光束。
    beamMesh.position.set(0, -BEAM.range / 2, 0);
    beamHolder.add(beamMesh);
    var beamPivot = new THREE.Object3D();
    beamPivot.position.copy(LAMP);
    scene.add(beamPivot);
    beamPivot.add(beamHolder);

    function smoothstep(x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }
    function beamYaw(t) {
      // 相位直接用秒：[0,4.1) 右扫 / [4.1,5.5) 右停 / [5.5,9.6) 左扫 / [9.6,11) 左停
      var u = t % BEAM.cycle, A = BEAM.yaw0, B = BEAM.yaw1;
      if (u < BEAM.move) return A + (B - A) * smoothstep(u / BEAM.move);
      if (u < BEAM.move + BEAM.hold) return B;
      if (u < BEAM.move * 2 + BEAM.hold)
        return B + (A - B) * smoothstep((u - BEAM.move - BEAM.hold) / BEAM.move);
      return A;
    }

    /* ── 船头剪影：贴在相机前方的近景框（第一人称「我在船上」）──
       ★ 相机局部空间里「看得见的方向是 -Z」——2026-09-21 之前的版本把船头放在
         +z=2.2，整艘船都在相机背后，所以画面里从来没有船（用户反馈「船没画出来」的根因）。
       结构 = 甲板大底板 + 左右舷缘（向船头收拢）+ 艏 stem 柱 + 护栏，全是夜色剪影
       （MeshBasicMaterial 不受光）。挂在 camera 下随浪一起起伏摇摆——相机就在船上，
       刚性连接才是物理正确的。具体角度/尺寸用截图迭代校准，不靠纸面推算。*/
    var bowGroup = new THREE.Object3D();
    camera.add(bowGroup);
    scene.add(camera);
    var bowMat = new THREE.MeshBasicMaterial({ color: 0x060A13, fog: false });
    var bowMat2 = new THREE.MeshBasicMaterial({ color: 0x0A1120, fog: false });
    // ★ 比例校准（2026-09-21 截图迭代）：第一版甲板宽 11、艏柱高 1.5，把画面底部占掉近半、
    //   中央竖柱像烟囱 —— 用户视角里「海全被挡住」。第二版：甲板收窄放低（顶线 ~74%、
    //   两侧露海）、艏柱删除、舷缘外移到画面下两角并向中央收拢。
    // 甲板：中央走道，向前（-z）延伸，顶线落在海平线之下、两侧露出海面
    var deck = new THREE.Mesh(new THREE.BoxGeometry(6.0, 0.4, 5.5), bowMat);
    deck.position.set(0, -1.95, -4.3);
    bowGroup.add(deck);
    // 左右舷缘：从画面下两角向中央前方收拢（绕 y 微转 -> 透视上「船头变窄」）
    var waleGeo = new THREE.BoxGeometry(0.34, 0.62, 6.0);
    var waleL = new THREE.Mesh(waleGeo, bowMat2);
    waleL.position.set(-2.95, -1.5, -4.1);
    waleL.rotation.y = -0.2;
    bowGroup.add(waleL);
    var waleR = new THREE.Mesh(waleGeo, bowMat2);
    waleR.position.set(2.95, -1.5, -4.1);
    waleR.rotation.y = 0.2;
    bowGroup.add(waleR);
    // 护栏：左右各一根细横杆 + 三根小柱（够读出「栏杆」即可，不抢戏）
    var railMat = bowMat2;
    [-2.95, 2.95].forEach(function (sx) {
      var bar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 4.6), railMat);
      bar.position.set(sx, -1.02, -3.9);
      bar.rotation.y = sx < 0 ? -0.2 : 0.2;
      bowGroup.add(bar);
      for (var pi = 0; pi < 3; pi++) {
        var post = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.62, 0.09), railMat);
        post.position.set(sx * (1.04 + pi * 0.06), -1.28, -2.3 - pi * 1.5);
        post.rotation.y = sx < 0 ? -0.2 : 0.2;
        bowGroup.add(post);
      }
    });

    /* ── 尺寸 / 循环 / 事件 ── */
    var W = 1, H = 1;
    function resize() {
      var rect = canvas.getBoundingClientRect();
      var cssW = Math.max(1, rect.width), cssH = Math.max(1, (rect.width * 440) / 520);
      W = cssW; H = cssH;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(cssW, cssH, false);
      camera.aspect = cssW / cssH;
      camera.updateProjectionMatrix();
    }
    if ('ResizeObserver' in window) { new ResizeObserver(resize).observe(canvas); }
    else { window.addEventListener('resize', resize, { passive: true }); }
    resize();

    var BOB = { rollA: 1.6 * Math.PI / 180, rollW: 0.90, pitchA: 1.0 * Math.PI / 180, pitchW: 0.55, heaveA: 0.12, heaveW: 0.80 };
    var userYaw = 0, userPitch = 0, yaw = 0, pitch = 0, touching = !fine.matches;
    var running = false, rafId = 0, t0 = 0, pauseAt = 0, frames = 0, staticMode = reduce.matches;

    if (fine.matches && !staticMode) {
      window.addEventListener('pointermove', function (e) {
        var rect = canvas.getBoundingClientRect();
        var tx = (e.clientX - rect.left) / rect.width * 2 - 1;
        var ty = (e.clientY - rect.top) / rect.height * 2 - 1;
        // ★ 相机基准朝向已翻转 180°（CAM_YAW_BASE），所以指针增量要**取反**，
        //   才能保持「鼠标往右拖 → 视线往右转」的手感（否则会反向）。
        userYaw = -Math.max(-1, Math.min(1, tx)) * 20 * Math.PI / 180;
        userPitch = -Math.max(-1, Math.min(1, ty)) * 8 * Math.PI / 180;
      }, { passive: true });
    }

    function frame(now) {
      if (!running) return;
      rafId = window.requestAnimationFrame(frame);
      var t = (now - t0) / 1000;
      var roll = BOB.rollA * Math.sin(t * BOB.rollW + 1.7);
      var bobP = BOB.pitchA * Math.sin(t * BOB.pitchW + 0.4);
      var heave = BOB.heaveA * Math.sin(t * BOB.heaveW + 2.3);
      var drift = touching ? 6 * Math.PI / 180 * Math.sin(0.12 * t) : 0;
      yaw += ((userYaw + drift) - yaw) * 0.08;
      pitch += (userPitch - pitch) * 0.08;
      camera.position.set(CAM_X, CAM_Y + heave, CAM_Z);
      // 俯仰基准 = 相机 -> LOOK_AT 的仰角（保证灯室落在画面上部），再叠加船身起伏与用户抬头低头
      camera.rotation.set(CAM_PITCH_BASE + bobP + pitch, CAM_YAW_BASE + yaw, roll);
      seaMat.uniforms.t.value = t;
      var by = beamYaw(t);
      // 光束水平方向（世界 xz）：Ry(by) 把 +X 映到 (cos by, 0, −sin by)，海面光带据此跟随
      seaMat.uniforms.uBeamDir.value.set(Math.cos(by), -Math.sin(by));
      // pivot.rotation.y = 横扫角；水平化的锥轴在 beamHolder 里（rotation.z = +90°−低头 2.2°），
      // 所以这里的 Y 旋转现在是真正的「绕灯室横扫」。旧版锥体竖直朝下时这个旋转是自旋、画面不动。
      beamPivot.rotation.set(0, by, 0);
      frames++;
      if (frames % 10 === 0) {
        canvas.dataset.frames = String(frames);
        canvas.dataset.running = running ? '1' : '0';
        canvas.dataset.yaw = yaw.toFixed(3);
        canvas.dataset.beam = by.toFixed(3);
        if (staticMode) canvas.dataset.static = '1';
      }
      renderer.render(scene, camera);
      if (staticMode) { running = false; canvas.dataset.running = '0'; }
    }

    function start() {
      if (running) return;
      if (pauseAt) { t0 += performance.now() - pauseAt; pauseAt = 0; }
      running = true;
      canvas.dataset.running = '1';
      rafId = window.requestAnimationFrame(frame);
    }
    function stop() {
      if (!running) return;
      running = false;
      pauseAt = performance.now();
      canvas.dataset.running = '0';
      if (rafId) window.cancelAnimationFrame(rafId);
    }

    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault(); stop(); fallback(new Error('WebGL 上下文丢失'));
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else if (!staticMode) start();
    });

    /* ── 调试钩子：只读查询 + 相机重调（供自动化构图比对使用）──
       只挂在 window 上、不写任何 DOM，线上无副作用；探针据此批量试机位，
       免得每换一组 CAM_* 都要改源码 + 重新加载页面。
       retune 只改相机基准，不碰场景几何，所以不会留下「半改」状态。*/
    window.__pharosCam = {
      get: function () {
        return {
          camX: CAM_X, camY: CAM_Y, camZ: CAM_Z,
          lookX: LOOK_AT.x, lookY: LOOK_AT.y, lookZ: LOOK_AT.z,
          targetX: CAM_TARGET_X,
          yawBase: CAM_YAW_BASE, pitchBase: CAM_PITCH_BASE,
          halfFovH: CAM_HALF_FOV_H,
          lamp: { x: LAMP.x, y: LAMP.y, z: LAMP.z },
          towerBaseY: TOWER_BASE_Y, towerTopY: TOWER_TOP_Y, isleTop: ISLE_TOP
        };
      },
      retune: function (camY, camZ, lookY, targetX) {
        if (typeof camY === 'number') CAM_Y = camY;
        if (typeof camZ === 'number') CAM_Z = camZ;
        if (typeof lookY === 'number') LOOK_AT.y = lookY;
        if (typeof targetX === 'number') CAM_TARGET_X = targetX;
        CAM_YAW_OFFSET = -Math.atan(2 * Math.tan(CAM_HALF_FOV_H) * (CAM_TARGET_X - 0.5));
        CAM_YAW_BASE = Math.PI + Math.atan2(CAM_X - LOOK_AT.x, LOOK_AT.z - CAM_Z)
                             - CAM_YAW_OFFSET;
        CAM_PITCH_BASE = Math.atan2(LOOK_AT.y - CAM_Y,
                                    Math.hypot(LOOK_AT.x - CAM_X, LOOK_AT.z - CAM_Z));
        return window.__pharosCam.get();
      },
      // 把 3D 点投影到 canvas 的归一化屏幕坐标（0~1），用于断言构图。
      // ★ 必须先把相机参数写进 camera.position/rotation 再 updateMatrixWorld，
      //   否则读到的是上一帧的矩阵（表现为 retune 之后 project 结果不变）。
      project: function (x, y, z) {
        camera.position.set(CAM_X, CAM_Y, CAM_Z);
        camera.rotation.set(CAM_PITCH_BASE, CAM_YAW_BASE, 0);
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
        var v = new THREE.Vector3(x, y, z).project(camera);
        return { sx: (v.x + 1) / 2, sy: (1 - v.y) / 2, depth: v.z };
      }
    };

    /* ── v2 翻页：3D 生命周期钩子（只有封面页在跑）──
       翻页引擎（普通 script）在切页时调用 pause/resume；
       module 后于它执行，故挂载时补判一次「当前是否在封面」，不在封面就先停。*/
    function renderOnce() { renderer.render(scene, camera); }
    window.__pharosHero = {
      pause: function () { stop(); },
      resume: function () {
        resize();
        if (staticMode) { renderOnce(); return; }
        start();
        renderOnce();
      }
    };
    if (window.__pharosCur && window.__pharosCur() !== 0) stop();

    // 首帧渲染成功后切换显示（失败则不切 -> SVG 兜底）
    renderer.render(scene, camera);
    document.documentElement.classList.add('hero-3d');
    canvas.dataset.running = '1';
    canvas.dataset.frames = '1';

    if (staticMode) {
      canvas.dataset.static = '1';
      canvas.dataset.running = '0';
      canvas.dataset.frames = '1';
    } else {
      start();
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (es) {
          es.forEach(function (en) { if (en.isIntersecting) start(); else stop(); });
        }, { threshold: 0 }).observe(canvas);
      }
      reduce.addEventListener('change', function (e) {
        staticMode = e.matches;
        if (staticMode) { stop(); canvas.dataset.static = '1'; }
        else { delete canvas.dataset.static; start(); }
      });
    }
  }
})();
