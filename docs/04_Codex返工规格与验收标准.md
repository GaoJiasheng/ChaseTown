# Codex 返工规格与验收标准（Web 3D）

> 版本 v1.1 · 2026-07-15 · 针对第一批角色/环境交付的打回说明与可机器判定的验收红线
> 前置阅读：`docs/02_Codex外包资产规格.md`。原始美术标准继续有效，本文是加严补丁，不是替代。
> 当前唯一运行时目标是 **Three.js + WebGL 2 + GLB**；制作源归 `art-source/`，浏览器资产归 `public/models/`。

---

## 0. 为什么打回第一批交付

1. **小孩、坏人、警察共 9 套正式角色没有形成浏览器可用交付**：缺少能从 `public/models/` 直接加载、带正式材质和动画的 GLB。角色是玩家持续注视的核心，优先级最高，不能用空目录、说明文件或胶囊占位代替。
2. **部分道具只是基础几何拼装**：例如旧警车只有缩放立方体车身、纯色方块警灯和纯黑圆柱轮胎，没有车门接缝、灯壳、腰线、磨损或可信材质。这直接违反“严禁用纯色、几何线条和色块充当正式模型”的最高原则。
3. **旧的程序化生成路线天花板过低**：无头 Blender 脚本适合白盒、批量处理和格式转换，但“缩放基础体 + 纯色材质”不能产出正式角色或英雄道具。`tools/art_pipeline/` 可以保留，但职责必须升级为源资产处理、GLB 导出、压缩和质量门禁，不能继续把灰盒当最终成品。
4. **自评报告只证明“有文件”，没有证明“有质量”**：例如只写 `pbr_texture_files_present: true` 无法说明贴图是否是纯色。必须记录可独立复算的像素方差、面数、材质数、GLB 体积、Validator 结果和浏览器实测。
5. **DCC 预览成功不等于网页可用**：最终验收必须覆盖 Three.js 实际加载、材质通道、骨骼动画、相机可见性、移动浏览器性能和网络请求。

---

## 1. 硬性红线（一票否决）

### 1.1 贴图“非纯色”检测

Codex 必须对每个新增或修改的 Base Color、Normal、AO 跑质量门禁，并把实际数值写入报告。

```python
# tools/art_pipeline/quality_gate.py
# 用法: python quality_gate.py <texture.png> <kind>
import sys
import numpy as np
from PIL import Image

THRESHOLDS = {
    "basecolor_stddev_min": 8.0,
    "normal_stddev_min": 4.0,
    "ao_stddev_min": 3.0,
}

def check(path: str, kind: str) -> dict:
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    stddev = float(img.std())
    key = f"{kind}_stddev_min"
    passed = stddev >= THRESHOLDS.get(key, 5.0)
    return {
        "file": path,
        "kind": kind,
        "stddev": round(stddev, 2),
        "passed": passed,
    }

if __name__ == "__main__":
    result = check(sys.argv[1], sys.argv[2])
    print(result)
    sys.exit(0 if result["passed"] else 1)
```

- Base Color stddev < 8：纯色平涂，打回。
- Normal stddev < 4：没有可信表面细节，打回。
- AO stddev < 3：没有可信遮蔽信息，打回。
- 压缩后的 WebP/KTX2 也要做目视对比；压缩不能把原本通过的细节抹掉。
- 阈值只是最低门槛；通过数值但图案与资产无关、存在明显生成噪点或重复伪影，仍然打回。

### 1.2 几何“非基础体”检查

- [ ] 没有未加工的 Cube/Cylinder/Sphere/Plane 直接作为正式可见表面。
- [ ] 所有硬表面可见边缘有合理倒角，不是完美 90° 箱体。
- [ ] 至少有一层结构细节：面板分割、螺丝/铆钉、接缝、磨损、贴花或真实 Trim Sheet。
- [ ] 警车、警局外观、模块转角等复杂资产不能仅用纯色材质区分部件。
- [ ] 对照 `art-source/Concepts/` 的剪影、比例和主要分件，必须“一眼是同一个设计”。
- [ ] 远景优化与 LOD 可以减少细节，但 LOD0 不得以“性能”为理由退化成灰盒。

### 1.3 Web 运行时红线

- [ ] 正式交付为 GLB，位于 `public/models/`；制作源只位于 `art-source/`。
- [ ] glTF Validator Error=0；每条 Warning 都有解释或修复记录。
- [ ] 项目实际 `GLTFLoader` 加载无异常，控制台无错误，资源无 404。
- [ ] 加载后 scale=1、角色面朝 +Z、轴心正确；不靠应用代码写特殊补丁。
- [ ] glTF Metallic-Roughness、Normal、AO、Emission 通道正确。
- [ ] 正式相机首帧能看到角色和关键场景；不能落在地面下、相机外或因灯光全黑。
- [ ] 角色 skin、joint、clip 能在 Three.js `AnimationMixer` 中运行，三风格真实模型重定向通过。
- [ ] 体积、面数、材质数和纹理分辨率满足 `02` 文档预算。

只要 §1.1、§1.2 或 §1.3 任意一项失败，该资产就仍是“未完成”。不允许用布尔自评、DCC 截图或“待浏览器验证”标记交付完成。

---

## 2. 必须采用的制作路线

### 2.1 优先级 1：高质量基础网格或图生 3D

- 角色优先使用可信的人体基础网格、MB-Lab/MakeHuman 类工具，或经过授权的 image-to-3D 服务。
- 生成结果只能作为起点，必须在 Blender 中清理拓扑、UV、材质和权重，再绑定到统一骨骼。
- 三风格要按概念图主动重塑比例、服装和材质，不能把同一个生成结果简单改色冒充三套风格。
- 导出后必须通过 GLB、动画、浏览器和性能全链路验收。

### 2.2 优先级 2：手工/程序化混合制作环境

环境模块可以脚本化，但脚本必须生成可交付细节，而不是盒子：

- **贴图**：使用授权明确的真实拍摄/扫描 PBR 素材，或在 Blender 中生成包含噪声、污渍、划痕和层次的材质；禁止 Principled BSDF 只填单一 RGB。
- **几何**：可见硬边加 Bevel；面板、门缝、灯壳和腰线使用真实几何、Boolean 或法线细节。
- **法线**：有结构细节的表面必须有有效 Normal；不允许统一平面法线冒充烘焙结果。
- **运行时优化**：生成脚本负责稳定命名、材质复用、LOD、GLB 导出、Meshopt/Draco 与 KTX2（如启用），但优化前后要目视一致。
- **关卡数据**：模块实例、碰撞与导航信息输出为 Web 可读 JSON，不依赖编辑器专有场景文件。

### 2.3 明确禁止

- 纯色材质直接作为最终材质。
- 缩放/旋转基础体直接充当最终可见部件。
- 只渲染预览图，不交付可在项目中加载的 GLB。
- 只写 `true/false`，不提供 stddev、面数、体积、Validator 和浏览器实测数据。
- 在应用里直接加载 `art-source/`、绝对磁盘路径或临时下载目录。
- 为单个坏模型在运行时写专属缩放、旋转、材质和骨骼修补逻辑。

---

## 3. 角色资产专项要求（最高优先级）

1. **先确认工具和来源**：记录使用的人体基础、生成服务、模型许可证与修改范围。来源不清楚的模型不得进入产品。
2. **禁止为了“有文件”硬交几何人形**：若环境缺少合格的人体工具或授权，必须明确报告阻塞和所需输入，同时继续完成统一骨骼、动画、导出与测试夹具；不能用不合格角色填空。
3. **按真实角色验收骨骼**：Task A 只有在小孩、坏人、警察的正式 GLB 上完成播放与切换才算完成。空骨架、调试胶囊或单套测试模型不算。
4. **手机俯视可读性必须实测**：每个角色提供正式游戏相机的桌面和手机截图。面部细节再好，如果角色太小、颜色融入地面或轮廓无法区分，仍然返工。
5. **风格切换保持状态**：切换 GLB 不得改变位置、朝向、碰撞、AI 状态和当前动作，不得出现一帧消失或骨骼爆炸。

---

## 4. 已交付环境资产的返工方式

不要凭主观印象挑几件重做；所有旧环境资产走同一流水线：

1. 把迁移到 `art-source/Environment/` 的所有 Base Color、Normal、AO 逐个跑 §1.1，生成汇总表。
2. 贴图不通过时，引用它的模块或道具自动进入返工队列。
3. 贴图通过但 §1.2 的倒角、分件和结构细节不通过，同样返工。
4. 重点复核警车、篮球架、警察局外观、长椅、储物柜、课桌椅；但不能只检查这份名单。
5. 返工完成后从源资产重新导出正式 GLB 到 `public/models/environment/`，运行 glTF Validator 和 Three.js 加载测试。
6. 模块/道具更新后重新生成第一关实例清单、碰撞和导航 JSON，并从前门完整跑到警察局。
7. 三套光照/后处理参数必须在真实材质、真实相机和移动设备上复核，不能只保留纸面参数。

---

## 5. 提交与复核流程

### 5.1 Codex 提交前

1. 对每个新增/修改纹理运行 §1.1，把实际数值写入对应资产目录现有的 `Reports/`。
2. 对每个 GLB 运行 Validator 和资源检查，报告至少包含：

```json
{
  "asset_id": "prop_police_car",
  "source": "art-source/Environment/Props/",
  "runtime_glb": "public/models/environment/props/police-car.glb",
  "quality_gate": {
    "basecolor_stddev": 0.0,
    "normal_stddev": 0.0,
    "ao_stddev": 0.0,
    "bevel_used": true,
    "reference_image": "art-source/Concepts/04_school_environment_sheet.png"
  },
  "geometry": {
    "triangles": 0,
    "materials": 0,
    "lod_count": 1
  },
  "runtime": {
    "glb_bytes": 0,
    "validator_errors": 0,
    "validator_warnings": [],
    "threejs_load_passed": true,
    "browser_console_errors": 0
  }
}
```

3. 渲染一张与概念图接近机位的高质量预览，再提供一张正式游戏相机截图。
4. 至少提供桌面 Chrome 和手机 Safari/Chrome 的浏览器证据；角色还要提供动画播放和风格切换证据。
5. 交付说明逐项列出通过、失败和未做内容，不允许笼统写“已完成”。

### 5.2 收到交付后的独立复核

1. 抽样重跑像素方差与 glTF Validator，核对数字是否真实。
2. 在生产构建中打开页面，检查网络请求、控制台、首帧可见性、材质和动画。
3. 对照概念图检查剪影、比例、分件与材质；明显仍是盒子拼装时整批打回。
4. 在窄屏手机视口跑完整一局，检查角色可见、动态相机、触控、帧率和内存。
5. 任何必须由专属运行时代码补丁才能正常显示的模型，退回源资产修正。

### 5.3 项目级门禁

- `npm run lint`、`npm run build`、`npm test` 全绿。
- 浏览器无资源 404、未处理异常或持续 WebGL warning。
- `public/models/` 中不存在制作源、高模备份或未引用的临时导出。
- `art-source/` 不进入生产资源图；产品代码没有源目录引用。
- 重开和换风格后，GPU/JS 内存不持续增长。

---

## 6. 重新下发任务清单

| 优先级 | 任务 | 完成定义 |
|---|---|---|
| P0 | B1–B3 小孩三风格 | 三套正式 GLB、PBR、动画、手机相机可见、运行时切换通过 |
| P0 | C1–C3 坏人三风格 | 同上，并与小孩剪影强对比 |
| P0 | D1–D3 警察三风格 | 三套正式 GLB，Idle/Point 正常，终点演出可见 |
| P1 | 全量环境质量门禁 | `art-source/Environment/` 贴图与几何通过/失败清单 |
| P1 | 重做不通过的道具/模块 | 正式 GLB + 报告 + 浏览器截图，不是简单调色 |
| P2 | 重建第一关 | 模块实例、关卡 GLB、碰撞/导航 JSON，完整跑通 |
| P2 | 三风格渲染配置 | Three.js/WebGL 参数在桌面与手机真实复核 |

> Task A 不要求从零重做，但必须在 B/C/D 正式 GLB 到位后完成一次真实的 `AnimationMixer` 播放、重定向和风格切换测试；“待浏览器验证”不再算完成。
